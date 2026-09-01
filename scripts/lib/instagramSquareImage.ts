/**
 * scripts/lib/instagramSquareImage.ts
 *
 * Instagram投稿用の正方形画像（1080×1080）のパス・URLを解決する。
 * scripts/lib/instagramMaterialAgent.ts（自動パイプライン）と
 * scripts/instagram-draft.ts（単体生成）の両方から使う共通ロジック。
 *
 * type別の優先順位:
 * - column: コラムには専用のAIイラストを主役にした正方形画像が既にある
 *   （scripts/lib/column-images.ts の createSquareImage が生成する
 *   public/images/columns/<slug>-square.webp）。これはコラムの世界観を
 *   体現する画像であり、タイトル文字だけの汎用意匠より明確に優れているため、
 *   存在する限り必ずこちらを最優先で使う。存在しない場合（画像未生成の
 *   下書き等）のみ、文字ベースの画像にフォールバックする。
 * - spot/news: 専用イラストが存在しないため、最初から文字ベースの画像
 *   （public/images/instagram/<type>-<slug>-square.webp、
 *   scripts/lib/ogpImage.ts の renderInstagramSquareImage）を使う。既に
 *   生成済みならそれを再利用し、無ければ新規生成する。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkGlyphCoverage, renderInstagramSquareImage, type OgpImageInput } from './ogpImage.js';
import type { InstagramContentType } from './instagram-caption.js';

// astro.config.mjs の `site` と同じ値。
const SITE_URL = 'https://honjikoji.jp';

export interface ResolveSquareImageInput {
  type: InstagramContentType;
  slug: string;
  title: string;
  /** 画像内に出すラベル（例: "居酒屋 ／ 本寺小路" "お知らせ" "街の歴史"）。文字ベース画像でのみ使う。 */
  imageLabel: string;
  projectRoot: string;
}

export type SquareImageSource = 'column-illustration' | 'existing-generated' | 'generated';

export interface ResolveSquareImageResult {
  ok: boolean;
  imagePath?: string;
  imageUrl?: string;
  source?: SquareImageSource;
  error?: string;
}

export async function resolveInstagramSquareImage(input: ResolveSquareImageInput): Promise<ResolveSquareImageResult> {
  if (input.type === 'column') {
    const columnImagePath = path.join(input.projectRoot, 'public/images/columns', `${input.slug}-square.webp`);
    if (existsSync(columnImagePath)) {
      return {
        ok: true,
        imagePath: columnImagePath,
        imageUrl: `${SITE_URL}/images/columns/${input.slug}-square.webp`,
        source: 'column-illustration',
      };
    }
  }

  const fallbackFileName = `${input.type}-${input.slug}-square.webp`;
  const fallbackImagePath = path.join(input.projectRoot, 'public/images/instagram', fallbackFileName);
  const fallbackImageUrl = `${SITE_URL}/images/instagram/${fallbackFileName}`;

  if (existsSync(fallbackImagePath)) {
    return { ok: true, imagePath: fallbackImagePath, imageUrl: fallbackImageUrl, source: 'existing-generated' };
  }

  const ogpInput: OgpImageInput = { type: input.type, title: input.title, label: input.imageLabel };
  const missingChars = await checkGlyphCoverage(ogpInput);
  if (missingChars.length > 0) {
    return {
      ok: false,
      error: `タイトル/ラベルにフォントに無い文字が含まれます（該当文字: ${missingChars.join('')}）`,
    };
  }

  try {
    const buffer = await renderInstagramSquareImage(ogpInput);
    await mkdir(path.dirname(fallbackImagePath), { recursive: true });
    await writeFile(fallbackImagePath, buffer);
    return { ok: true, imagePath: fallbackImagePath, imageUrl: fallbackImageUrl, source: 'generated' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
