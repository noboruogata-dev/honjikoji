/**
 * scripts/check-business-status.ts
 *
 * 掲載中の全店舗（src/content/spots/）のplaceIdについて、Google Places API
 * (New) の businessStatus を確認し、閉店（CLOSED_PERMANENTLY）・一時休業
 * （CLOSED_TEMPORARILY）の店舗を一覧報告する。記事の書き込みは一切しない
 * （読み取り専用）。
 *
 * 閉店した店を掲載し続けるのは地域メディアとして最も避けたい状態なので、
 * 新規記事側はAgent3（scripts/generate-spot.ts）が生成時にブロックする。
 * ただし「掲載後に閉店した」店はそこを通らないため、この定期点検が必要に
 * なる（.github/workflows/check-business-status.yml が週次で実行する）。
 *
 * businessStatus はGoogle Maps Platform利用規約上、frontmatter等への永続
 * 保存が許可されていない。この スクリプトは取得値を標準出力に報告するだけで、
 * ファイルへは書き込まない。閉店が疑われた店舗の記事をどうするか（非公開に
 * するか、閉店の追記を入れるか）は、現地・公式情報での確認を経た人間の判断に
 * 委ねる。
 *
 * 終了コード: 閉店（CLOSED_PERMANENTLY）が1件以上あれば 1、それ以外は 0。
 * （一時休業・取得失敗は再開・一過性の障害がありうるため 0 のまま。）
 *
 * 使い方: npm run spots:check-status
 */
import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from './lib/gemini-agents.js';
import { resolveBusinessStatus, type BusinessStatus } from './lib/googlePlaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');

/** API呼び出しの間隔（ミリ秒）。店舗数ぶん連続で叩くため最低限は空ける。 */
const REQUEST_INTERVAL_MS = 200;

type CheckResult = {
  slug: string;
  title: string;
  /** placeIdが未設定の店舗は確認できない（undefined）。 */
  status: BusinessStatus | 'NO_PLACE_ID' | 'UNKNOWN';
};

const STATUS_LABELS: Record<CheckResult['status'], string> = {
  OPERATIONAL: '営業中',
  CLOSED_TEMPORARILY: '一時休業',
  CLOSED_PERMANENTLY: '閉店',
  NO_PLACE_ID: 'placeId未設定（確認不可）',
  UNKNOWN: '取得できず',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.error(
      '[check-business-status] GOOGLE_PLACES_API_KEY が設定されていません。確認できません。'
    );
    process.exit(1);
  }

  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));
  const results: CheckResult[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);
    const title =
      frontmatter && typeof frontmatter.title === 'string' ? frontmatter.title : slug;
    const placeId =
      frontmatter && typeof frontmatter.placeId === 'string' && frontmatter.placeId.length > 0
        ? frontmatter.placeId
        : undefined;

    if (!placeId) {
      results.push({ slug, title, status: 'NO_PLACE_ID' });
      continue;
    }

    const status = await resolveBusinessStatus(placeId, apiKey);
    results.push({ slug, title, status: status ?? 'UNKNOWN' });
    await sleep(REQUEST_INTERVAL_MS);
  }

  const closed = results.filter((r) => r.status === 'CLOSED_PERMANENTLY');
  const temporarily = results.filter((r) => r.status === 'CLOSED_TEMPORARILY');
  const unchecked = results.filter(
    (r) => r.status === 'NO_PLACE_ID' || r.status === 'UNKNOWN'
  );
  const operational = results.filter((r) => r.status === 'OPERATIONAL');

  console.log('============================================================');
  console.log(' 本寺小路ガイド 掲載店舗の営業状態（Google businessStatus）');
  console.log('============================================================');
  console.log(`対象: ${results.length}件`);
  console.log('');

  for (const r of results) {
    const mark =
      r.status === 'CLOSED_PERMANENTLY'
        ? '🔴'
        : r.status === 'CLOSED_TEMPORARILY'
          ? '🟡'
          : r.status === 'OPERATIONAL'
            ? '🟢'
            : '⚪️';
    console.log(`  ${mark} ${r.slug}（${r.title}）: ${STATUS_LABELS[r.status]}`);
  }

  console.log('');
  console.log('------------------------------------------------------------');
  console.log(
    `営業中: ${operational.length}件 / 一時休業: ${temporarily.length}件 / 閉店: ${closed.length}件 / 未確認: ${unchecked.length}件`
  );
  console.log('------------------------------------------------------------');

  if (closed.length > 0) {
    console.log('');
    console.log('🔴 閉店（CLOSED_PERMANENTLY）が検出されました。現地・公式情報で');
    console.log('   確認のうえ、該当記事の扱いを判断してください:');
    for (const r of closed) {
      console.log(`     - src/content/spots/${r.slug}.md（${r.title}）`);
    }
    console.log('============================================================');
    process.exit(1);
  }

  if (temporarily.length > 0) {
    console.log('');
    console.log('🟡 一時休業の店舗があります（再開しうるため警告のみ）:');
    for (const r of temporarily) {
      console.log(`     - ${r.slug}（${r.title}）`);
    }
  }

  console.log('============================================================');
}

main().catch((err) => {
  console.error(
    '[check-business-status] エラーが発生しました:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
