/**
 * src/lib/spotExterior.ts
 *
 * scripts/prepare-spot-exterior.ts が public/images/spots/ へ書き出した
 * 店舗の外観イラストを、詳細ページ（SpotExterior.astro）から安全に参照する
 * ためのヘルパー。src/lib/ogpImagePath.tsと同じ「実在チェック→無ければ
 * undefined」方式（イラストが無い店舗のページは黙って非表示にフォール
 * バックする。生成が追いついていない店舗が多数を占める前提のため）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

// process.cwd()基準で解決する（ogpImagePath.tsと同じ理由。ビルド時にこの
// モジュールがsrc/とは異なる場所へ再配置されて解決に失敗するのを防ぐ）。
const SPOTS_IMAGE_DIR = path.resolve(process.cwd(), 'public/images/spots');

/** 生成済み外観イラストのルート相対パスを返す。無ければundefined。 */
export function resolveSpotExteriorImage(slug: string): string | undefined {
  const filename = `${slug}.png`;
  return existsSync(path.join(SPOTS_IMAGE_DIR, filename)) ? `/images/spots/${filename}` : undefined;
}
