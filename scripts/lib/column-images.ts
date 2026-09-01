import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import sharp from 'sharp';
import type { ColumnCategory, ColumnKind } from './column-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// generate-ogp-images.ts（ogpImage.ts）と同じサブセット済みフォントを流用する。
// satoriはテキストを<path>としてSVGに埋め込むため、ラスタライズ側（sharp）は
// フォントを一切知らなくてよく、CIランナーにCJKフォントが入っていなくても
// 確実に描画できる（scripts/assets/fonts/README.md参照）。
const FONTS_DIR = path.resolve(__dirname, '../assets/fonts');

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const MAX_IMAGE_ATTEMPTS = 2;
export const MAX_PUBLIC_IMAGE_BYTES = 200 * 1024;

/** アルファ値がこれ以上急変する隣接画素ペアを「ノイズらしい」とみなす境界。
 *  境界線のアンチエイリアスは数px幅のなだらかな変化になるが、背景全体が
 *  ディザリングされているケースは0近辺⇔255近辺を1px単位で往復する。 */
const ALPHA_NOISE_JUMP_THRESHOLD = 150;
/**
 * 画像全体に占める「ノイズらしい隣接ペア」の比率のしきい値。
 * 実測値（japanese-sake-label-rules-illust.webp の背景ディザリング事故と、
 * 既存の正常画像2点）: 事故画像 7.8%（jump=150基準）、正常画像は0.0〜0.2%。
 * 大きな余裕を見て1%に設定する。
 */
export const ALPHA_NOISE_RATIO_THRESHOLD = 0.01;

/** 本文中ほどに2枚目の挿絵を入れるための最小要件。見出しが少ない、または
 *  本文が短い記事に無理に挿絵を挟むと窮屈になるため、どちらかを下回る記事は
 *  2枚目を生成せず、1枚目（アイキャッチ）だけで公開を続行する。 */
export const MIN_HEADING_COUNT_FOR_MID_IMAGE = 2;
export const MIN_BODY_CHARS_FOR_MID_IMAGE = 600;

export interface ColumnImageInput {
  slug: string;
  title: string;
  summary: string;
  category: ColumnCategory;
  kind: ColumnKind;
}

export interface ColumnImageResult {
  eyecatch: { src: string; alt: string };
  /** Instagram投稿用のフィード画像（1080x1350、4:5）。eyecatchと同じ透過
   *  ソースから切り出すため、追加の画像生成APIコールは発生しない。 */
  feed: { src: string; alt: string };
  /** 本文中ほどの2枚目挿絵。findMidImageInsertionの条件を満たさない場合や、
   *  2枚目の生成自体に失敗した場合はundefined（1枚目だけで公開を続行する）。 */
  illustration?: { src: string; alt: string };
  /** 2枚目を挿入済みのMarkdown本文。挿入していない場合は入力のbodyのまま。 */
  body: string;
  imageStatus: 'draft';
  sourcePath: string;
  midSourcePath?: string;
  warnings: string[];
}

const CATEGORY_MOTIFS: Record<ColumnCategory, string> = {
  'お酒の豆知識': '一組の徳利と猪口',
  '街の歴史': '古い路地の格子戸と小さな行灯',
  '店と人': '暖簾の前に静かに置かれた一つの盃',
  '夜の作法': '会計盆の上に置かれた一つの猪口',
};

/** カテゴリとテキスト（キーワード照合対象）から、決定論的にモチーフを選ぶ。
 *  1枚目（title+summary）・2枚目（挿入位置前後の本文）の両方から
 *  同じ精度でモチーフを導けるよう、対象テキストを引数として切り出してある。 */
function motifFromText(category: ColumnCategory, text: string): string {
  if (category === 'お酒の豆知識') {
    if (/(燗|温度|熱燗|ぬる燗)/.test(text)) return '湯気が細く立つ一組の徳利と猪口';
    if (/(米|酒米|精米)/.test(text)) return '数粒の酒米を添えた一つの徳利';
    if (/(麹|発酵)/.test(text)) return '麹蓋と小さな一つの徳利';
  }
  if (category === '街の歴史' && /(鍛冶|金物|刃物)/.test(text)) {
    return '古い鍛冶槌と小さな行灯を組み合わせた静物';
  }
  return CATEGORY_MOTIFS[category];
}

export function chooseColumnMotif(input: ColumnImageInput): string {
  return motifFromText(input.category, `${input.title} ${input.summary}`);
}

/** 1枚目・2枚目共通の画風ロック。挿絵の見た目をサイト全体で統一するため、
 *  プロンプトを分けても必ずこの一文を含める。 */
const LOCKED_ART_DIRECTION = `Locked art direction:
- completely transparent background with a real alpha channel
- transparency must be encoded in the alpha channel; never draw a checkerboard, transparency grid, gray-and-white squares, or placeholder background
- exactly one central subject or one compact still-life group
- generous empty transparent margin around the subject
- Japanese modern, restrained hand-drawn illustration
- thin sumi-ink linework
- flat shapes, minimal shading, no photorealism, no 3D, no anime style
- use only these colors: sumi black #14110f, warm off-white #d8cbb8, lantern amber #f2b544, vermilion #c8412f
- no text, no letters, no numbers, no labels, no logos, no signatures, no border, no frame
- do not depict a recognizable real person or reproduce a real storefront
- for historical themes, create a symbolic scene rather than claiming an exact historical reconstruction`;

export function buildColumnImagePrompt(input: ColumnImageInput): string {
  const motif = chooseColumnMotif(input);
  return `Create one editorial illustration for a Japanese nightlife culture column.

Subject: ${motif}
Article context: ${input.title} — ${input.summary}
Content kind: ${input.kind}

${LOCKED_ART_DIRECTION}

Return only the illustration image.`;
}

export function buildColumnImageAlt(input: ColumnImageInput): string {
  return `${input.title}を象徴する${chooseColumnMotif(input)}の和モダンな挿絵`;
}

export interface MidImageInsertion {
  /** body.trim() した文字列内でのオフセット。この直前に画像行を挿む。 */
  offset: number;
  /** 挿入位置の直前の段落（2枚目プロンプトの文脈に使う）。 */
  contextBefore: string;
  /** 挿入位置の見出しと、その直後の段落（2枚目プロンプトの文脈に使う）。 */
  contextAfter: string;
}

/**
 * 本文中ほどに2枚目の挿絵を挿入する位置を決定論的に決める。
 *
 * ルール: 見出し（## 等）がMIN_HEADING_COUNT_FOR_MID_IMAGE個以上あれば、
 * 「最後から2番目の見出し」の直前に挿入する。
 *   - 見出しが3つなら2つ目の見出しの直前
 *   - 見出しが2つなら1つ目の見出しの直前
 * 一番最後の見出しの直前には置かない。まとめ・結論のセクション直前に挟むと
 * 唐突になるため、常に「最後の見出しより1つ手前」を選ぶ。
 *
 * 見出しがMIN_HEADING_COUNT_FOR_MID_IMAGE未満、または本文が
 * MIN_BODY_CHARS_FOR_MID_IMAGE字未満の記事はnullを返す（2枚目を作らない）。
 */
export function findMidImageInsertion(body: string): MidImageInsertion | null {
  const trimmed = body.trim();
  if ([...trimmed].length < MIN_BODY_CHARS_FOR_MID_IMAGE) return null;

  const headingOffsets: number[] = [];
  const headingRegex = /^#{1,6}\s.+$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(trimmed)) !== null) {
    headingOffsets.push(match.index);
  }
  if (headingOffsets.length < MIN_HEADING_COUNT_FOR_MID_IMAGE) return null;

  const offset = headingOffsets[headingOffsets.length - 2];
  const before = trimmed.slice(0, offset).trimEnd();
  const after = trimmed.slice(offset).trimStart();
  // 前後それぞれ直近のブロック（空行区切り）だけを文脈として渡す。
  // 記事全体ではなく、挿入位置の具体的な内容にプロンプトを絞るため。
  const contextBefore = before.split(/\n{2,}/).pop()?.trim() ?? before;
  const contextAfter = after.split(/\n{2,}/)[0]?.trim() ?? after;

  return { offset, contextBefore, contextAfter };
}

/** findMidImageInsertionが決めた位置へ、Markdown画像行を空行区切りで挿入する。 */
export function insertMidImageMarkdown(
  body: string,
  insertion: MidImageInsertion,
  image: { src: string; alt: string }
): string {
  const trimmed = body.trim();
  const before = trimmed.slice(0, insertion.offset).trimEnd();
  const after = trimmed.slice(insertion.offset);
  return `${before}\n\n![${image.alt}](${image.src})\n\n${after}`;
}

export function buildColumnMidImagePrompt(input: ColumnImageInput, insertion: MidImageInsertion): string {
  return `Create one editorial illustration for a Japanese nightlife culture column. It will be inserted midway through the article body, between the two Japanese passages quoted below.

Depict one concrete object or small scene that is actually described in these passages — not a summary of the whole article, and not a generic restatement of the article's overall topic.

--- Passage immediately before the illustration ---
${insertion.contextBefore}

--- Passage immediately after the illustration ---
${insertion.contextAfter}

Article title (tone reference only — do not illustrate the title itself): ${input.title}

${LOCKED_ART_DIRECTION}

Return only the illustration image.`;
}

/** 2枚目用のモチーフ。挿入位置の前後の本文（＝buildColumnMidImagePromptが
 *  実際に画像生成へ渡す文章そのもの）をchooseColumnMotifと同じキーワード
 *  照合にかけ、1枚目と同じ精度で具体的なモチーフを導く。マッチしなければ
 *  1枚目と同じくカテゴリ既定のモチーフにフォールバックする。 */
export function chooseMidImageMotif(input: ColumnImageInput, insertion: MidImageInsertion): string {
  return motifFromText(input.category, `${insertion.contextBefore} ${insertion.contextAfter}`);
}

export function buildColumnMidImageAlt(input: ColumnImageInput, insertion: MidImageInsertion): string {
  return `${input.title}の本文中盤、${chooseMidImageMotif(input, insertion)}を描いた和モダンな挿絵`;
}

interface AlphaStats {
  hasAlpha: boolean;
  transparentRatio: number;
}

export async function inspectAlpha(buffer: Buffer): Promise<AlphaStats> {
  const metadata = await sharp(buffer).metadata();
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  const pixels = info.width * info.height;
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 250) transparent += 1;
  }
  return { hasAlpha: Boolean(metadata.hasAlpha), transparentRatio: pixels ? transparent / pixels : 0 };
}

export function needsBackgroundRemoval(transparentRatio: number): boolean {
  return transparentRatio < 0.05;
}

/**
 * 透過を表す市松模様そのものが画素として描かれた画像を検出する。
 *
 * 「無彩色（グレースケール）」の判定にmin>120（明るいグレー〜白限定）を
 * 課していたが、実際に発生した事故では黒に近い市松（約20,20,20）や中間の
 * 濃さの市松（約50,50,50/105,105,105）もあり、いずれもこの下限に阻まれて
 * 検出をすり抜けていた（japanese-sake-label-rules記事のアイキャッチ・
 * 挿絵で確認）。下限を撤廃し、「無彩色（max-min<12）かつ不透明」だけを
 * 条件にする。墨線（thin ink strokes）は面積が小さく隣接ペア数が少ないため、
 * 誤検出防止は下限を課さなくても以下のneutralRatio/edgeRatioのしきい値で
 * 十分に効く（薄い輪郭線だけでは画像全体の55%やエッジ比0.15%を超えない）。
 */
export async function hasRenderedTransparencyGrid(buffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  let opaqueNeutral = 0;
  let semitransparentNeutral = 0;
  let contrastEdges = 0;
  let neighborPairs = 0;
  const isOpaqueNeutral = (offset: number) => {
    const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    return data[offset + 3] >= 250 && max - min < 12;
  };
  const luminance = (offset: number) => (data[offset] + data[offset + 1] + data[offset + 2]) / 3;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      if (isOpaqueNeutral(offset)) opaqueNeutral += 1;
      const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
      const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
      if (data[offset + 3] > 0 && data[offset + 3] < 245 && max - min < 15) {
        semitransparentNeutral += 1;
      }
      if (x + 1 < info.width) {
        const next = offset + 4;
        neighborPairs += 1;
        if (isOpaqueNeutral(offset) && isOpaqueNeutral(next) && Math.abs(luminance(offset) - luminance(next)) > 50) contrastEdges += 1;
      }
      if (y + 1 < info.height) {
        const next = offset + info.width * 4;
        neighborPairs += 1;
        if (isOpaqueNeutral(offset) && isOpaqueNeutral(next) && Math.abs(luminance(offset) - luminance(next)) > 50) contrastEdges += 1;
      }
    }
  }

  const neutralRatio = opaqueNeutral / total;
  const semitransparentNeutralRatio = semitransparentNeutral / total;
  const edgeRatio = contrastEdges / neighborPairs;
  return semitransparentNeutralRatio > 0.1 || neutralRatio > 0.55 || (neutralRatio > 0.4 && edgeRatio > 0.0015);
}

/**
 * 隣接画素間でアルファ値が激しく往復している比率を測る（0〜1）。
 *
 * 背景が単色寄りでもRGBは揃ったまま「透明⇔不透明」がまだら状にディザリング
 * されるケースを検出するために作った。このケースは、色は均一なため
 * removeConnectedBackgroundの色距離ベースの背景推定にはほとんど引っかからず
 * （提灯部分の描画色と誤認したり、たまたま角の画素が透明で背景色推定自体を
 * 誤らせたりする）、hasRenderedTransparencyGrid（RGBの明度差で市松模様を
 * 検出する）にも引っかからない（RGBはほぼ同じ色のままでアルファだけが
 * 動くため、隣接画素間の明度差がほぼ0になる）。日本酒ラベルコラムの
 * 2枚目挿絵で実際に発生した事故（背景が白のまま、アルファだけが1px単位で
 * 0/255付近を往復）はこの手口で検出できる。
 */
export async function alphaNoiseRatio(
  buffer: Buffer,
  jumpThreshold: number = ALPHA_NOISE_JUMP_THRESHOLD
): Promise<number> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let noisyPairs = 0;
  let pairs = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (x + 1 < width) {
        pairs += 1;
        if (Math.abs(data[offset + 3] - data[offset + 4 + 3]) > jumpThreshold) noisyPairs += 1;
      }
      if (y + 1 < height) {
        const next = offset + width * 4;
        pairs += 1;
        if (Math.abs(data[offset + 3] - data[next + 3]) > jumpThreshold) noisyPairs += 1;
      }
    }
  }
  return pairs ? noisyPairs / pairs : 0;
}

/**
 * 画像モデルが「透明」を半透明の無彩色格子として描いた場合、その画素だけを
 * 完全透明にする。彩色された半透明画素と、不透明な墨線・生成り面は保持する。
 */
export async function removeRenderedTransparencyGrid(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    const max = Math.max(data[offset], data[offset + 1], data[offset + 2]);
    const min = Math.min(data[offset], data[offset + 1], data[offset + 2]);
    if (alpha > 0 && alpha < 245 && max - min < 15) data[offset + 3] = 0;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

function colorDistance(r: number, g: number, b: number, bg: [number, number, number]): number {
  return Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2);
}

/**
 * 画像モデルが透明指定を守らず単色背景を返した場合だけ、外周につながる背景を
 * flood fillで透明化する。絵の内側にある生成り色は外周非連結なら保持される。
 */
export async function removeConnectedBackground(buffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const cornerOffsets = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4];
  const rgbCorners: Array<[number, number, number]> = cornerOffsets.map((offset) => [
    data[offset],
    data[offset + 1],
    data[offset + 2],
  ]);
  const sorted = (channel: number) => rgbCorners.map((rgb) => rgb[channel]).sort((a, b) => a - b);
  const red = sorted(0);
  const green = sorted(1);
  const blue = sorted(2);
  const background: [number, number, number] = [red[1], green[1], blue[1]];
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const enqueue = (pixel: number) => {
    if (seen[pixel]) return;
    const offset = pixel * 4;
    if (colorDistance(data[offset], data[offset + 1], data[offset + 2], background) > 44) return;
    seen[pixel] = 1;
    queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const offset = pixel * 4;
    const distance = colorDistance(data[offset], data[offset + 1], data[offset + 2], background);
    // 背景近似色は完全透明、境界側はアルファを段階的に残してフリンジを抑える。
    data[offset + 3] = distance <= 20 ? 0 : Math.round(((distance - 20) / 24) * data[offset + 3]);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }

  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function ensureDoesNotExist(filePath: string) {
  try {
    await access(filePath);
    throw new Error(`既存画像を上書きしません: ${path.relative(process.cwd(), filePath)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('既存画像')) throw error;
  }
}

function extractImage(response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>): Buffer {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const images = parts.filter((part) => !part.thought && part.inlineData?.data);
  const data = images.at(-1)?.inlineData?.data;
  if (!data) throw new Error('画像生成APIのレスポンスに最終画像がありません。');
  return Buffer.from(data, 'base64');
}

/** 指定プロンプトから透過PNGを生成し、透過QA（背景除去・チェッカー柄検出・
 *  ディザリングノイズ検出・透明率検証）を通過するまで最大MAX_IMAGE_ATTEMPTS回
 *  試みる。1枚目・2枚目のどちらもこの関数を通す（プロンプトが違うだけで
 *  検証ロジックは共通）。生成し直しても直らない類のAPIエラーでない限り、
 *  QAに落ちた画像はそのまま公開せず再試行する（不透過のまま使うフォール
 *  バックは持たない）。 */
export async function generateTransparentSource(ai: GoogleGenAI, prompt: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[Agent4:Image] 画像生成 ${attempt}/${MAX_IMAGE_ATTEMPTS}...`);
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
        contents: prompt,
        config: {
          responseModalities: ['IMAGE'],
          // personGeneration はGemini Enterprise Agent Platform専用で、
          // Gemini Developer APIでは拒否される。人物禁止はプロンプトで制御する。
          imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: false },
        },
      });
      const original = extractImage(response);
      const initial = await inspectAlpha(original);
      // 最終QAと同じ5%を境界にする。以前は3%以上で背景除去を省略しつつ
      // 最終QAで5%以上を要求していたため、3〜5%の画像が必ず失敗していた。
      const backgroundNormalized = needsBackgroundRemoval(initial.transparentRatio)
        ? await removeConnectedBackground(original)
        : await sharp(original).png().toBuffer();
      const normalized = await removeRenderedTransparencyGrid(backgroundNormalized);
      const finalStats = await inspectAlpha(normalized);
      if (!finalStats.hasAlpha || finalStats.transparentRatio < 0.05 || finalStats.transparentRatio > 0.98) {
        throw new Error(`透明ピクセル率が基準外です: ${(finalStats.transparentRatio * 100).toFixed(1)}%`);
      }
      if (await hasRenderedTransparencyGrid(normalized)) {
        throw new Error('透過チェッカー模様が画像として描き込まれています。');
      }
      // 背景除去後もなお、色は均一なままアルファだけがまだら状に残っていないかを
      // 確認する（removeConnectedBackgroundは色距離ベースのため、このタイプの
      // ノイズは背景色推定を誤らせて素通りしやすい。実例と検証はcolumn-images.
      // test.tsを参照）。ここで弾いた画像は、上のcatchで再試行に回る。
      const noiseRatio = await alphaNoiseRatio(normalized);
      if (noiseRatio > ALPHA_NOISE_RATIO_THRESHOLD) {
        throw new Error(`背景のアルファが斑点状のノイズとして残っています: ${(noiseRatio * 100).toFixed(1)}%`);
      }
      console.log(`[Agent5:ImageQA] 透明ピクセル率 ${(finalStats.transparentRatio * 100).toFixed(1)}% / ノイズ率 ${(noiseRatio * 100).toFixed(2)}%`);
      return normalized;
    } catch (error) {
      lastError = error;
      console.warn(`[Agent4:Image] 試行${attempt}失敗: ${error instanceof Error ? error.message : error}`);
      // リクエスト設定・権限・課金など、画像を作り直しても解消しないAPIエラーは
      // 無駄に再試行しない。透明度など生成結果の品質エラーだけ再試行する。
      if (/parameter is only supported|invalid argument|permission denied|billing|api key/i.test(String(error))) {
        break;
      }
    }
  }
  throw new Error(`画像生成が${MAX_IMAGE_ATTEMPTS}回ともQAを通過しませんでした: ${lastError}`);
}

/** QA済み透過PNGから、OGP・記事冒頭用のアイキャッチ（1200x630、装飾背景に合成）を作る。 */
export async function createEyecatchImage(source: Buffer): Promise<Buffer> {
  const foreground = await sharp(source)
    .resize(570, 570, { fit: 'contain', withoutEnlargement: true })
    .png()
    .toBuffer();
  const background = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="g" cx="62%" cy="48%" r="48%"><stop offset="0" stop-color="#f2b544" stop-opacity="0.18"/><stop offset="1" stop-color="#14110f" stop-opacity="0"/></radialGradient></defs>
    <rect width="1200" height="630" fill="#14110f"/><rect width="1200" height="630" fill="url(#g)"/>
    <path d="M80 78 H1120 M80 552 H1120" stroke="#d8cbb8" stroke-opacity="0.12"/>
    <circle cx="108" cy="104" r="5" fill="#c8412f"/><circle cx="1092" cy="526" r="5" fill="#f2b544"/>
  </svg>`);
  return sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .webp({ quality: 84, alphaQuality: 95 })
    .toBuffer();
}

/** QA済み透過PNGから、本文中ほどに挿し込む挿絵（900x900、透過のまま）を作る。 */
export async function createIllustrationImage(source: Buffer): Promise<Buffer> {
  return sharp(source)
    .resize(900, 900, { fit: 'contain', withoutEnlargement: true })
    .webp({ quality: 80, alphaQuality: 92 })
    .toBuffer();
}

// Instagram投稿用フィード画像の下部に入れるサイト名。変更時はここだけ直せばよい。
const FEED_SITE_LABEL = '本寺小路ガイド';
// Instagramのフィード表示は4:5が推奨（1:1正方形は上下に余白が入り小さく
// 表示される）ため、この比率で統一する（幅は1:1版から変更していない）。
const FEED_WIDTH = 1080;
const FEED_HEIGHT = 1350;
// イラストはInstagramフィード表示（幅約400px）でも存在感が出るよう大きめに取る。
// 1:1版(800)から、高さが伸びた(1080→1350)ぶんの余裕を活かして少し拡大。
const FEED_ILLUSTRATION_SIZE = 860;
const FEED_CATEGORY_LABEL_HEIGHT = 90;
const FEED_SITE_LABEL_HEIGHT = 110;
// 上端・下端の小さな余白（カテゴリ名・サイト名自体の高さは含まない）。
const FEED_TOP_MARGIN = 56;
const FEED_BOTTOM_MARGIN = 36;
// 「カテゴリ名下端〜イラスト上端」と「イラスト下端〜サイト名上端」が
// 均等になるように、残りの縦スペースを2等分する。
const FEED_MIDDLE_GAP = Math.round(
  (FEED_HEIGHT -
    FEED_TOP_MARGIN -
    FEED_CATEGORY_LABEL_HEIGHT -
    FEED_ILLUSTRATION_SIZE -
    FEED_SITE_LABEL_HEIGHT -
    FEED_BOTTOM_MARGIN) /
    2
);
const FEED_CATEGORY_LABEL_TOP = FEED_TOP_MARGIN;
const FEED_ILLUSTRATION_TOP = FEED_CATEGORY_LABEL_TOP + FEED_CATEGORY_LABEL_HEIGHT + FEED_MIDDLE_GAP;
const FEED_ILLUSTRATION_LEFT = Math.round((FEED_WIDTH - FEED_ILLUSTRATION_SIZE) / 2);
const FEED_SITE_LABEL_TOP = FEED_ILLUSTRATION_TOP + FEED_ILLUSTRATION_SIZE + FEED_MIDDLE_GAP;

let feedLabelFontCache: Buffer | undefined;

async function loadFeedLabelFont(): Promise<Buffer> {
  if (!feedLabelFontCache) {
    feedLabelFontCache = await readFile(path.join(FONTS_DIR, 'NotoSansJP-Regular-subset.ttf'));
  }
  return feedLabelFontCache;
}

/** 1行だけの透過PNGラベルをsatoriで描く（文字は<path>化されるため、実行
 *  環境にCJKフォントが入っていなくても確実に描画できる）共通ヘルパー。 */
async function renderFeedTextLabel(text: string, height: number, fontSize: number, color: string): Promise<Buffer> {
  const font = await loadFeedLabelFont();
  const tree = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: `${FEED_WIDTH}px`,
        height: `${height}px`,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: 'Noto Sans JP',
        fontSize,
        letterSpacing: '0.15em',
        color,
      },
      children: text,
    },
  };
  const svg = await satori(tree, {
    width: FEED_WIDTH,
    height,
    fonts: [{ name: 'Noto Sans JP', data: font, weight: 400, style: 'normal' }],
  });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * QA済み透過PNGから、Instagram投稿用のフィード画像（1080x1350、4:5、
 * createEyecatchImageと同じ装飾背景に合成）を作る。透過のまま投稿すると
 * 透明部分が黒く潰れるプラットフォームがあるため、背景を敷いて書き出す。
 * カテゴリ名（上）・サイト名（下）はsatoriでレンダリング（フォント内蔵、
 * CI環境のフォント有無に依存しない）。新規の画像生成API呼び出しは発生
 * しない（createEyecatchImageと同じsourceを共有する）。
 *
 * フィードを流し見したときに何の記事か分からないという指摘を受け、
 * カテゴリ名（"お酒の豆知識"等）を追加した。記事タイトルは入れない
 * （キャプション側で伝える設計のため）。イラストが主役であることを
 * 維持するため、カテゴリ名・サイト名はどちらも控えめな装飾文字の扱いに
 * とどめ、フォントサイズ・存在感ともイラストより明確に小さくしている。
 */
export async function createFeedImage(source: Buffer, category: string): Promise<Buffer> {
  const foreground = await sharp(source)
    .resize(FEED_ILLUSTRATION_SIZE, FEED_ILLUSTRATION_SIZE, { fit: 'contain', withoutEnlargement: true })
    .png()
    .toBuffer();
  // 左上・右下の点はゴミに見えるとの指摘を受けて削除し、上下の飾り罫線だけ
  // 残す（イラスト・ラベルの新しい縦位置に合わせて位置も調整）。
  const background = Buffer.from(`<svg width="${FEED_WIDTH}" height="${FEED_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="g" cx="62%" cy="42%" r="55%"><stop offset="0" stop-color="#f2b544" stop-opacity="0.18"/><stop offset="1" stop-color="#14110f" stop-opacity="0"/></radialGradient></defs>
    <rect width="${FEED_WIDTH}" height="${FEED_HEIGHT}" fill="#14110f"/><rect width="${FEED_WIDTH}" height="${FEED_HEIGHT}" fill="url(#g)"/>
    <path d="M48 30 H1032 M48 1320 H1032" stroke="#d8cbb8" stroke-opacity="0.12"/>
  </svg>`);
  const [categoryLabel, siteLabel] = await Promise.all([
    // カテゴリ名はOGP・文字ベースフィード画像のラベルと同じ琥珀色(#e8c468)で
    // 揃え、サイト全体でのブランド上の一貫性を保つ。
    renderFeedTextLabel(category, FEED_CATEGORY_LABEL_HEIGHT, 36, '#e8c468'),
    renderFeedTextLabel(FEED_SITE_LABEL, FEED_SITE_LABEL_HEIGHT, 34, 'rgba(216,203,184,0.82)'),
  ]);
  return sharp(background)
    .composite([
      { input: categoryLabel, top: FEED_CATEGORY_LABEL_TOP, left: 0 },
      { input: foreground, top: FEED_ILLUSTRATION_TOP, left: FEED_ILLUSTRATION_LEFT },
      { input: siteLabel, top: FEED_SITE_LABEL_TOP, left: 0 },
    ])
    .webp({ quality: 84, alphaQuality: 95 })
    .toBuffer();
}

/**
 * コラム記事の挿絵一式を生成する。
 *
 * 1枚目（アイキャッチ）: 既存どおり必須。生成に失敗すれば例外を投げ、
 * 呼び出し元（generate-column.tsの試行ループ）に委ねる（挙動は変更していない）。
 *
 * 2枚目（本文中ほどの挿絵、illustrationフィールドを転用）: findMidImageInsertion
 * の条件を満たす場合だけ試みる。画像生成APIの消費が2倍になるため、2枚目の
 * 失敗は例外にせずwarningsに積み、1枚目だけで公開を続行できるようにする。
 * 成功した場合だけ、返り値のbodyへ`![alt](src)`を直接挿入して返す
 * （挿入しなかった場合は入力のbodyをそのまま返す）。
 */
export async function generateColumnImages(
  ai: GoogleGenAI,
  input: ColumnImageInput,
  body: string,
  projectRoot: string
): Promise<ColumnImageResult> {
  const sourceDir = path.join(projectRoot, 'assets-src/columns');
  const publicDir = path.join(projectRoot, 'public/images/columns');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });

  const sourcePath = path.join(sourceDir, `${input.slug}-source.png`);
  const eyecatchPath = path.join(publicDir, `${input.slug}-eyecatch.webp`);
  const feedPath = path.join(publicDir, `${input.slug}-feed.webp`);
  await Promise.all([sourcePath, eyecatchPath, feedPath].map(ensureDoesNotExist));

  const source = await generateTransparentSource(ai, buildColumnImagePrompt(input));
  const eyecatch = await createEyecatchImage(source);
  // Instagram用フィード画像はeyecatchと同じsourceから切り出すため、
  // 追加の画像生成APIコールは発生しない。
  const feed = await createFeedImage(source, input.category);

  const warnings: string[] = [];
  if (eyecatch.length > MAX_PUBLIC_IMAGE_BYTES) {
    warnings.push(`アイキャッチが200KBを超えています（${Math.ceil(eyecatch.length / 1024)}KB）。`);
  }
  if (feed.length > MAX_PUBLIC_IMAGE_BYTES) {
    warnings.push(`フィード画像が200KBを超えています（${Math.ceil(feed.length / 1024)}KB）。`);
  }

  await Promise.all([writeFile(sourcePath, source), writeFile(eyecatchPath, eyecatch), writeFile(feedPath, feed)]);
  console.log(`[Agent5:ImageQA] フィード画像を保存しました（${Math.ceil(feed.length / 1024)}KB）: ${path.relative(projectRoot, feedPath)}`);

  const result: ColumnImageResult = {
    eyecatch: { src: `/images/columns/${input.slug}-eyecatch.webp`, alt: buildColumnImageAlt(input) },
    feed: { src: `/images/columns/${input.slug}-feed.webp`, alt: buildColumnImageAlt(input) },
    body,
    imageStatus: 'draft',
    sourcePath,
    warnings,
  };

  const insertion = findMidImageInsertion(body);
  if (!insertion) {
    warnings.push('本文が短い、または見出しが少ないため2枚目の挿絵は生成していません。');
    return result;
  }

  const illustrationPath = path.join(publicDir, `${input.slug}-illust.webp`);
  const midSourcePath = path.join(sourceDir, `${input.slug}-illust-source.png`);
  try {
    await Promise.all([illustrationPath, midSourcePath].map(ensureDoesNotExist));
    const midSource = await generateTransparentSource(ai, buildColumnMidImagePrompt(input, insertion));
    const illustrationBuffer = await createIllustrationImage(midSource);
    if (illustrationBuffer.length > MAX_PUBLIC_IMAGE_BYTES) {
      warnings.push(`本文挿絵が200KBを超えています（${Math.ceil(illustrationBuffer.length / 1024)}KB）。`);
    }
    await Promise.all([writeFile(midSourcePath, midSource), writeFile(illustrationPath, illustrationBuffer)]);

    const illustration = { src: `/images/columns/${input.slug}-illust.webp`, alt: buildColumnMidImageAlt(input, insertion) };
    result.illustration = illustration;
    result.midSourcePath = midSourcePath;
    result.body = insertMidImageMarkdown(body, insertion, illustration);
  } catch (error) {
    // 2枚目はAPI消費が倍になる追加コストなので、失敗しても1枚目だけで
    // 公開を継続できるよう例外を投げない（呼び出し元の試行ループを回さない）。
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Agent4:Image] 2枚目（本文挿絵）の生成に失敗したため、1枚目のみで続行します: ${message}`);
    warnings.push(`2枚目（本文挿絵）の生成に失敗したため、1枚目のみで続行しました: ${message}`);
  }

  return result;
}
