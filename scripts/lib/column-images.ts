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
  /** Instagram投稿用のフィード画像（1080x1350、4:5）。eyecatchと同じ挿絵
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

// サイトの基調色（暗い夜の路地）。挿絵はこの色を背景として直接描かせる
// （後述のLOCKED_ART_DIRECTION参照）。合成先キャンバスの下地色とも揃える。
const TARGET_BACKGROUND_HEX = '#14110f';
const TARGET_BACKGROUND_RGB: [number, number, number] = [0x14, 0x11, 0x0f];

/**
 * 1枚目・2枚目共通の画風ロック。挿絵の見た目をサイト全体で統一するため、
 * プロンプトを分けても必ずこの一文を含める。
 *
 * 以前は「透明背景（アルファチャンネル）」を指示し、生成後に背景を検出・
 * 除去するQAパイプラインを組んでいたが、Gemini画像生成モデルはネイティブな
 * アルファチャンネル出力に対応しておらず（Google側の既知の制約。透明の
 * 指示をしても市松模様や単色で「描く」だけ）、かつ返却フォーマットが
 * 実質的にJPEG固定になったことで、PNG前提の背景除去（色距離ベースの
 * flood fill）が構造的に成立しなくなった（JPEGの非可逆圧縮ノイズで
 * 背景色の均一性が崩れ、市松模様検出・アルファノイズ検出等が軒並み
 * 誤検知するようになった）。
 *
 * そのため透明指定はやめ、モデルに最初からサイトの背景色（#14110f）で
 * 単色背景を描かせる方式に変更した。背景除去は不要になり、生成画像を
 * そのままリサイズして使う（詳細はgenerateColumnIllustration・
 * createEyecatchImage・createFeedImage参照）。
 */
const LOCKED_ART_DIRECTION = `Locked art direction:
- solid, completely flat background filled with sumi black ${TARGET_BACKGROUND_HEX} — no gradient, no texture, no pattern, no vignette, no other background color
- exactly one central subject or one compact still-life group
- generous empty margin (filled with the same solid background color) around the subject
- Japanese modern, restrained hand-drawn illustration
- thin sumi-ink linework
- flat shapes, minimal shading, no photorealism, no 3D, no anime style
- use only these colors: sumi black #14110f (background), warm off-white #d8cbb8, lantern amber #f2b544, vermilion #c8412f
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

function colorDistance(r: number, g: number, b: number, bg: [number, number, number]): number {
  return Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2);
}

// 角の背景色がTARGET_BACKGROUND_RGBからどれだけ離れていたら「背景指示を
// 守っていない」とみなすか。JPEG圧縮のブロックノイズを吸収できる程度の
// 余裕を持たせる（旧removeConnectedBackgroundの背景認定しきい値44よりは
// 厳しく、単なる圧縮ノイズよりは緩い値として実測ベースで設定）。
export const BACKGROUND_COLOR_TOLERANCE = 30;

/**
 * 生成画像の四隅が指示通りTARGET_BACKGROUND_RGB（サイトの基調色）に
 * 塗られているかを確認する。4隅のうち最も色が離れている値を返す
 * （1箇所でも背景指示を外していれば検出したいため、平均ではなく最大値）。
 *
 * 以前の透過検出（市松模様・アルファノイズ等）と違い、判定はこれ1つだけに
 * 単純化した。モデルがネイティブなアルファチャンネルに対応しておらず
 * JPEG出力になったことで背景除去の前提が崩れたため、背景色そのものを
 * 直接指示・直接検証する設計に変更した（LOCKED_ART_DIRECTIONのコメント
 * 参照）。
 */
export async function backgroundColorDistance(buffer: Buffer): Promise<number> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const cornerOffsets = [0, (width - 1) * 4, (height - 1) * width * 4, (height * width - 1) * 4];
  const distances = cornerOffsets.map((offset) =>
    colorDistance(data[offset], data[offset + 1], data[offset + 2], TARGET_BACKGROUND_RGB)
  );
  return Math.max(...distances);
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

/** 画像生成APIが実際に返したフォーマット（現状jpegだが将来変わっても
 *  対応できるよう、拡張子固定にせずsharpで実測する）に合わせた拡張子。
 *  デバッグ用の原画保存（assets-src/columns/）で、中身と拡張子が食い違う
 *  ファイルを残さないために使う。 */
export async function sourceFileExtension(buffer: Buffer): Promise<string> {
  const { format } = await sharp(buffer).metadata();
  return format ?? 'bin';
}

/**
 * 指定プロンプトから、サイトの基調色（#14110f）を背景にした挿絵を生成する。
 * 四隅がその背景色から大きく外れていないか（＝背景指示を守っているか）を
 * 確認し、最大MAX_IMAGE_ATTEMPTS回まで試みる。1枚目・2枚目のどちらもこの
 * 関数を通す（プロンプトが違うだけで検証ロジックは共通）。
 *
 * 返り値はモデルが返した画像をそのまま返す（現状JPEGだが、この関数は
 * フォーマットに依存しない。呼び出し側のcreateEyecatchImage等がsharpで
 * 読み込み・リサイズする際にフォーマットを問わず扱える）。透明背景を
 * 前提にした背景除去は行わない（LOCKED_ART_DIRECTIONのコメント参照）。
 */
export async function generateColumnIllustration(ai: GoogleGenAI, prompt: string): Promise<Buffer> {
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
      const image = extractImage(response);
      const distance = await backgroundColorDistance(image);
      if (distance > BACKGROUND_COLOR_TOLERANCE) {
        throw new Error(`背景色が指示（#14110f）から外れています（色距離: ${distance.toFixed(1)}）。`);
      }
      console.log(`[Agent5:ImageQA] 背景色チェックOK（色距離: ${distance.toFixed(1)}）`);
      return image;
    } catch (error) {
      lastError = error;
      console.warn(`[Agent4:Image] 試行${attempt}失敗: ${error instanceof Error ? error.message : error}`);
      // リクエスト設定・権限・課金など、画像を作り直しても解消しないAPIエラーは
      // 無駄に再試行しない。背景色など生成結果の品質エラーだけ再試行する。
      if (/parameter is only supported|invalid argument|permission denied|billing|api key/i.test(String(error))) {
        break;
      }
    }
  }
  throw new Error(`画像生成が${MAX_IMAGE_ATTEMPTS}回ともQAを通過しませんでした: ${lastError}`);
}

/**
 * 正方形の挿絵の縁だけをなだらかに透過させる疑似ビネットマスク（dest-in用）。
 *
 * 挿絵は不透明な正方形としてAIから返る（LOCKED_ART_DIRECTION参照）ため、
 * 装飾背景（光彩グラデーション）の上にそのまま重ねると、正方形の縁で
 * 光彩が四角くぶつ切りになる（「箱」のように見える）。被写体自体は
 * 十分な余白を持って中央に描かれる指示になっているので、縁の余白部分
 * だけをこのマスクで滑らかに透過させれば、被写体を欠けさせずに背景の
 * 光彩を縁まで自然に透けさせられる。
 *
 * 中心から70%の位置まで完全不透明、そこから100%（＝正方形の辺）まで
 * 透明へフェードする円形グラデーション。
 */
async function createEdgeFeatherMask(size: number): Promise<Buffer> {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="m" cx="50%" cy="50%" r="60%">
      <stop offset="70%" stop-color="#fff" stop-opacity="1"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#m)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * 生成した挿絵から、OGP・記事冒頭用のアイキャッチ（1200x630、装飾背景に
 * 合成）を作る。挿絵自体が既にサイトの基調色（#14110f）を背景に持つため
 * 透過合成そのものは不要だが、正方形の縁は上記createEdgeFeatherMaskで
 * フェードさせ、装飾背景の光彩が縁まで自然に見えるようにする。
 */
export async function createEyecatchImage(source: Buffer): Promise<Buffer> {
  const size = 570;
  const resized = await sharp(source)
    .resize(size, size, { fit: 'contain', withoutEnlargement: true, background: TARGET_BACKGROUND_HEX })
    .ensureAlpha()
    .png()
    .toBuffer();
  const mask = await createEdgeFeatherMask(size);
  const foreground = await sharp(resized)
    .composite([{ input: mask, blend: 'dest-in' }])
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

/** 生成した挿絵から、本文中ほどに挿し込む挿絵（900x900）を作る。正方形の
 *  挿絵をそのままリサイズするだけ（背景は挿絵自体が既に持っている）。 */
export async function createIllustrationImage(source: Buffer): Promise<Buffer> {
  return sharp(source)
    .resize(900, 900, { fit: 'contain', withoutEnlargement: true, background: TARGET_BACKGROUND_HEX })
    .webp({ quality: 80 })
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
 * 生成した挿絵から、Instagram投稿用のフィード画像（1080x1350、4:5、
 * createEyecatchImageと同じ装飾背景に合成）を作る。挿絵自体が既にサイトの
 * 基調色（#14110f）を背景に持つため、透過合成は不要。
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
  const resizedIllustration = await sharp(source)
    .resize(FEED_ILLUSTRATION_SIZE, FEED_ILLUSTRATION_SIZE, { fit: 'contain', withoutEnlargement: true, background: TARGET_BACKGROUND_HEX })
    .ensureAlpha()
    .png()
    .toBuffer();
  const illustrationMask = await createEdgeFeatherMask(FEED_ILLUSTRATION_SIZE);
  const foreground = await sharp(resizedIllustration)
    .composite([{ input: illustrationMask, blend: 'dest-in' }])
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

  const eyecatchPath = path.join(publicDir, `${input.slug}-eyecatch.webp`);
  const feedPath = path.join(publicDir, `${input.slug}-feed.webp`);
  await Promise.all([eyecatchPath, feedPath].map(ensureDoesNotExist));

  const source = await generateColumnIllustration(ai, buildColumnImagePrompt(input));
  // 画像生成APIが返す実際のフォーマット（現状JPEG）に合わせて拡張子を
  // 決める。中身と拡張子が食い違うファイルを残さないため（デバッグ用
  // アーティファクトとしてワークフローがアップロードするため人が開くこともある）。
  const sourceExt = await sourceFileExtension(source);
  const sourcePath = path.join(sourceDir, `${input.slug}-source.${sourceExt}`);
  await ensureDoesNotExist(sourcePath);
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
  let midSourcePath = '';
  try {
    await ensureDoesNotExist(illustrationPath);
    const midSource = await generateColumnIllustration(ai, buildColumnMidImagePrompt(input, insertion));
    const midSourceExt = await sourceFileExtension(midSource);
    midSourcePath = path.join(sourceDir, `${input.slug}-illust-source.${midSourceExt}`);
    await ensureDoesNotExist(midSourcePath);
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
