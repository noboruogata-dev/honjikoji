/**
 * src/lib/ogpImagePath.ts
 *
 * scripts/generate-ogp-images.ts が public/images/ogp/ へ生成した画像を、
 * 各ページ（spots/news/columns の詳細ページ）から安全に参照するための
 * ヘルパー。ファイルが実在するかを毎回チェックし、無ければundefinedを
 * 返す（呼び出し側はLayout.astroのogImageデフォルト（ogp-default.png）に
 * 自然にフォールバックできる）。
 *
 * フォント未対応文字等でgenerate-ogp-images.tsが特定の記事だけ生成に
 * 失敗しても、このチェックのおかげでそのページだけが黙って
 * デフォルト画像に戻る（ビルド自体は壊れない）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

// process.cwd()基準で解決する（import.meta.url相対だと、ビルド時にこの
// モジュールがsrc/とは異なる場所へ再配置されて解決に失敗するため。
// src/pages/map/index.astro と同じ理由・同じ対策）。
const OGP_DIR = path.resolve(process.cwd(), 'public/images/ogp');

export type OgpContentType = 'spot' | 'news' | 'column';

/** 生成済みOGP画像のルート相対パスを返す。無ければundefined。 */
export function resolveOgpImage(type: OgpContentType, slug: string): string | undefined {
  const filename = `${type}-${slug}.png`;
  return existsSync(path.join(OGP_DIR, filename)) ? `/images/ogp/${filename}` : undefined;
}
