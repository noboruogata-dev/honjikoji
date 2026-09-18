/**
 * scripts/spots-missing-hours.ts
 *
 * src/content/spots/ の記事のうち、構造化営業時間（hours）が未設定の店舗
 * slug・店名を一覧表示する（読み取り専用・書き込みは一切しない）。
 *
 * 2026年9月、営業時間の自動収集をAgent1（generate-spot.ts）の調査対象から
 * 外した（FALLBACK_HOURS_TEXTのコメント参照）ため、新規記事のhoursは
 * 基本的に未設定のまま公開される。手動でopenHours/regularHolidayを埋めて
 * `npm run generate:spot -- --backfill-hours` を実行する運用の入り口として、
 * 「どの店から手を付けるべきか」を一覧できるようにする。
 *
 * 使い方: npm run spots:missing-hours
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from './lib/gemini-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');

async function main() {
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const missing: { slug: string; title: string }[] = [];
  const present: string[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);
    if (!frontmatter) {
      unreadable.push(slug);
      continue;
    }
    if (frontmatter.hours === undefined) {
      const title = typeof frontmatter.title === 'string' ? frontmatter.title : slug;
      missing.push({ slug, title });
    } else {
      present.push(slug);
    }
  }

  console.log('============================================================');
  console.log(' 本寺小路ガイド 営業時間(hours)未設定の店舗一覧');
  console.log('============================================================');

  if (missing.length === 0) {
    console.log('未設定の店舗はありません。全店にhoursが設定済みです。');
  } else {
    console.log(`${missing.length}件（全${files.length}件中）:\n`);
    for (const { slug, title } of missing) {
      console.log(`  - ${slug}\n      店名: ${title}`);
    }
  }

  console.log('\n------------------------------------------------------------');
  console.log(
    `設定済み: ${present.length}件${unreadable.length > 0 ? ` / frontmatter読み取り失敗: ${unreadable.length}件（${unreadable.join(', ')}）` : ''}`
  );
  console.log('------------------------------------------------------------');
  console.log('手動で openHours/regularHoliday を編集後、以下でhoursを導出できます:');
  console.log('  npm run generate:spot -- --backfill-hours');
  console.log('============================================================');
}

main().catch((err) => {
  console.error('[spots-missing-hours] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
