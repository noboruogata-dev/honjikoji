/**
 * scripts/generate-guides-manifest.ts
 *
 * テーマ別まとめページ（/guides/<slug>/）ごとの該当店舗数を数え、
 * guides-manifest.json（リポジトリルート、gitignore対象）に書き出す。
 *
 * astro:content はAstroのビルドパイプライン内でしか解決できない仮想モジュール
 * のため、astro.config.mjs の sitemap filter からは使えない（generate-ogp-images.ts
 * と同じ制約）。そこでこのスクリプトが生frontmatterを直接読み、
 * src/lib/guides.ts と同じ判定関数（matches）を使って件数を計算し、
 * 「どのガイドがnoindexか」をJSONとして先出ししておく。astro.config.mjs側は
 * このJSONを読むだけでよく、判定ロジック自体は1箇所（guides.ts）にしか無い。
 *
 * npm run build 実行時に prebuild フックとして自動実行される（package.json参照）。
 * sitemap統合（astro:build:done）より前、build開始前に走るため、
 * このJSONは常に最新の状態でsitemap生成時に読まれる。
 *
 * 使い方:
 *   npm run generate:guides-manifest
 */

import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from './lib/gemini-agents.js';
import { GUIDES, GUIDE_MIN_SPOTS_FOR_INDEX, type GuideSpotInput } from '../src/lib/guides.js';
import type { HourRule } from '../src/lib/hours.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SPOTS_DIR = path.join(PROJECT_ROOT, 'src/content/spots');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'guides-manifest.json');

/** 生frontmatterをGuideSpotInputへ最低限の型安全性を持って正規化する。
 *  content.config.tsのzodスキーマと二重管理にならないよう、ここでは
 *  「配列でなければ空配列」程度の緩い防御に留める（本来のバリデーションは
 *  Astroビルド本体のcontent collectionsが担う）。 */
function toGuideSpotInput(fm: Record<string, unknown>): GuideSpotInput {
  const vibes = Array.isArray(fm.vibes) ? fm.vibes.filter((v): v is string => typeof v === 'string') : [];
  const hours = Array.isArray(fm.hours) ? (fm.hours as HourRule[]) : undefined;
  const budgetMin = typeof fm.budgetMin === 'number' ? fm.budgetMin : undefined;
  return { vibes, hours, budgetMin };
}

async function main() {
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));
  const spots: GuideSpotInput[] = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const fm = await readFrontmatter(SPOTS_DIR, slug);
    if (!fm) continue;
    spots.push(toGuideSpotInput(fm));
  }

  const manifest: Record<string, { count: number; noindex: boolean }> = {};
  for (const guide of GUIDES) {
    const count = spots.filter((spot) => guide.matches(spot)).length;
    manifest[guide.slug] = { count, noindex: count < GUIDE_MIN_SPOTS_FOR_INDEX };
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const noindexed = Object.entries(manifest).filter(([, v]) => v.noindex);
  console.log(`[guides-manifest] ${Object.keys(manifest).length}件中 ${noindexed.length}件がnoindex:`);
  for (const [slug, v] of Object.entries(manifest)) {
    console.log(`  - ${slug}: ${v.count}件${v.noindex ? '（noindex）' : ''}`);
  }
}

main().catch((err) => {
  console.error('[guides-manifest] 生成に失敗しました:', err);
  process.exitCode = 1;
});
