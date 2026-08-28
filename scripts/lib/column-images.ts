import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { ColumnCategory, ColumnKind } from './column-pipeline.js';

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
export const MAX_IMAGE_ATTEMPTS = 2;
export const MAX_PUBLIC_IMAGE_BYTES = 200 * 1024;

export interface ColumnImageInput {
  slug: string;
  title: string;
  summary: string;
  category: ColumnCategory;
  kind: ColumnKind;
}

export interface ColumnImageResult {
  illustration: { src: string; alt: string };
  eyecatch: { src: string; alt: string };
  imageStatus: 'draft';
  sourcePath: string;
  warnings: string[];
}

export interface ColumnImageDerivatives {
  illustration: Buffer;
  eyecatch: Buffer;
}

const CATEGORY_MOTIFS: Record<ColumnCategory, string> = {
  'お酒の豆知識': '一組の徳利と猪口',
  '街の歴史': '古い路地の格子戸と小さな行灯',
  '店と人': '暖簾の前に静かに置かれた一つの盃',
  '夜の作法': '会計盆の上に置かれた一つの猪口',
};

export function chooseColumnMotif(input: ColumnImageInput): string {
  const text = `${input.title} ${input.summary}`;
  if (input.category === 'お酒の豆知識') {
    if (/(燗|温度|熱燗|ぬる燗)/.test(text)) return '湯気が細く立つ一組の徳利と猪口';
    if (/(米|酒米|精米)/.test(text)) return '数粒の酒米を添えた一つの徳利';
    if (/(麹|発酵)/.test(text)) return '麹蓋と小さな一つの徳利';
  }
  if (input.category === '街の歴史' && /(鍛冶|金物|刃物)/.test(text)) {
    return '古い鍛冶槌と小さな行灯を組み合わせた静物';
  }
  return CATEGORY_MOTIFS[input.category];
}

export function buildColumnImagePrompt(input: ColumnImageInput): string {
  const motif = chooseColumnMotif(input);
  return `Create one editorial illustration for a Japanese nightlife culture column.

Subject: ${motif}
Article context: ${input.title} — ${input.summary}
Content kind: ${input.kind}

Locked art direction:
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
- for historical themes, create a symbolic scene rather than claiming an exact historical reconstruction

Return only the illustration image.`;
}

export function buildColumnImageAlt(input: ColumnImageInput): string {
  return `${input.title}を象徴する${chooseColumnMotif(input)}の和モダンな挿絵`;
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

/** 透過を表す市松模様そのものが画素として描かれた画像を検出する。 */
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
    return data[offset + 3] >= 250 && max - min < 12 && min > 120;
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

async function generateTransparentSource(ai: GoogleGenAI, input: ColumnImageInput): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[Agent4:Image] 画像生成 ${attempt}/${MAX_IMAGE_ATTEMPTS}...`);
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
        contents: buildColumnImagePrompt(input),
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
      console.log(`[Agent5:ImageQA] 透明ピクセル率 ${(finalStats.transparentRatio * 100).toFixed(1)}%`);
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

export async function generateColumnImages(
  ai: GoogleGenAI,
  input: ColumnImageInput,
  projectRoot: string
): Promise<ColumnImageResult> {
  const sourceDir = path.join(projectRoot, 'assets-src/columns');
  const publicDir = path.join(projectRoot, 'public/images/columns');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });

  const sourcePath = path.join(sourceDir, `${input.slug}-source.png`);
  const illustrationPath = path.join(publicDir, `${input.slug}-illust.webp`);
  const eyecatchPath = path.join(publicDir, `${input.slug}-eyecatch.webp`);
  await Promise.all([sourcePath, illustrationPath, eyecatchPath].map(ensureDoesNotExist));

  const source = await generateTransparentSource(ai, input);
  const { illustration, eyecatch } = await createColumnImageDerivatives(source);

  const warnings: string[] = [];
  if (illustration.length > MAX_PUBLIC_IMAGE_BYTES) warnings.push(`本文挿絵が200KBを超えています（${Math.ceil(illustration.length / 1024)}KB）。`);
  if (eyecatch.length > MAX_PUBLIC_IMAGE_BYTES) warnings.push(`アイキャッチが200KBを超えています（${Math.ceil(eyecatch.length / 1024)}KB）。`);

  // すべての検証・派生が完了してから一括保存し、途中生成物を残しにくくする。
  await Promise.all([
    writeFile(sourcePath, source),
    writeFile(illustrationPath, illustration),
    writeFile(eyecatchPath, eyecatch),
  ]);

  const alt = buildColumnImageAlt(input);
  return {
    illustration: { src: `/images/columns/${input.slug}-illust.webp`, alt },
    eyecatch: { src: `/images/columns/${input.slug}-eyecatch.webp`, alt },
    imageStatus: 'draft',
    sourcePath,
    warnings,
  };
}

/** QA済み透過PNGから、本文挿絵とOG用アイキャッチを決定論的に作る。 */
export async function createColumnImageDerivatives(source: Buffer): Promise<ColumnImageDerivatives> {
  const illustration = await sharp(source)
    .resize(900, 900, { fit: 'contain', withoutEnlargement: true })
    .webp({ quality: 80, alphaQuality: 92 })
    .toBuffer();

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
  const eyecatch = await sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .webp({ quality: 84, alphaQuality: 95 })
    .toBuffer();

  return { illustration, eyecatch };
}
