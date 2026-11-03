/**
 * scripts/seo-report.ts
 *
 * Search Console の直近28日分の数値を取得し、改善候補の記事・クエリを
 * レポートする（SEO自動運転の「⑤分析」部分）。記事は一切書き換えない
 * （読み取り専用）。リライト（⑥）はこのレポートの JSON を入力にした
 * 別スクリプトで行う想定。
 *
 * 出力:
 *   - 標準出力 / GitHub Actions の Job Summary に Markdown レポート
 *   - --out=<path> 指定時は候補一覧を JSON で書き出す（ワークフローでは
 *     アーティファクトとして保存する）
 *   - SLACK_WEBHOOK_URL があれば要約をSlackへ通知（任意）
 *
 * Search Console のデータはリポジトリにはコミットしない（Job Summary と
 * アーティファクトに残すだけ）。
 *
 * 必要な環境変数: GSC_SERVICE_ACCOUNT_JSON, GSC_SITE_URL（.env.example参照）
 *
 * 使い方: npm run seo:report [-- --days=28 --out=seo-report.json]
 */
import 'dotenv/config';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendStepSummary, readFrontmatter } from './lib/gemini-agents.js';
import { getAccessToken, parseServiceAccountKey, querySearchAnalytics } from './lib/searchConsole.js';
import { formatReport, selectCandidates, type ArticleInfo, type Collection } from './lib/seoCandidates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, '../src/content');
const COLLECTIONS: Collection[] = ['spots', 'columns', 'news'];

/** Search Console の確定データは2〜3日遅れるため、終了日は3日前にする。 */
const DATA_LAG_DAYS = 3;

function parseArgs(argv: string[]): { days: number; out?: string } {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const days = Number(get('days') ?? 28);
  return { days: Number.isFinite(days) && days > 0 ? days : 28, out: get('out') };
}

function isoDateDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function loadArticles(): Promise<ArticleInfo[]> {
  const articles: ArticleInfo[] = [];
  for (const collection of COLLECTIONS) {
    const dir = path.join(CONTENT_DIR, collection);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const slug = file.replace(/\.md$/, '');
      const fm = await readFrontmatter(dir, slug);
      if (!fm) continue;
      const title = typeof fm.title === 'string' ? fm.title : slug;
      const description =
        typeof fm.description === 'string' ? fm.description : typeof fm.summary === 'string' ? fm.summary : '';
      articles.push({ collection, slug, title, description });
    }
  }
  return articles;
}

async function notifySlack(webhookUrl: string | undefined, text: string): Promise<void> {
  if (!webhookUrl) {
    console.log('[seo-report] SLACK_WEBHOOK_URL が未設定のため、Slack通知をスキップします。');
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.warn(`[seo-report] Slack通知に失敗しました（HTTP ${res.status}）。処理は続行します。`);
  } catch (err) {
    console.warn('[seo-report] Slack通知に失敗しました。処理は続行します:', err instanceof Error ? err.message : err);
  }
}

async function main() {
  const { days, out } = parseArgs(process.argv.slice(2));
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) throw new Error('GSC_SITE_URL が設定されていません（例: sc-domain:honjikoji.jp）。');
  const key = parseServiceAccountKey(process.env.GSC_SERVICE_ACCOUNT_JSON);

  const endDate = isoDateDaysAgo(DATA_LAG_DAYS);
  const startDate = isoDateDaysAgo(DATA_LAG_DAYS + days - 1);
  console.log(`[seo-report] 対象期間: ${startDate} 〜 ${endDate}（${siteUrl}）`);

  const token = await getAccessToken(key);
  const [pageRaw, pageQueryRaw] = await Promise.all([
    querySearchAnalytics(token, siteUrl, { startDate, endDate, dimensions: ['page'] }),
    querySearchAnalytics(token, siteUrl, { startDate, endDate, dimensions: ['page', 'query'] }),
  ]);
  console.log(`[seo-report] 取得: ページ ${pageRaw.length}行 / ページ×クエリ ${pageQueryRaw.length}行`);

  const pageRows = pageRaw.map((r) => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
  const pageQueryRows = pageQueryRaw.map((r) => ({
    page: r.keys[0],
    query: r.keys[1],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));

  const articles = await loadArticles();
  const candidates = selectCandidates(pageRows, pageQueryRows, articles);
  const report = formatReport(candidates, { startDate, endDate });

  console.log('');
  console.log(report);
  await appendStepSummary(report);

  if (out) {
    await writeFile(out, JSON.stringify({ siteUrl, startDate, endDate, ...candidates }, null, 2));
    console.log(`[seo-report] 候補JSONを書き出しました: ${out}`);
  }

  const { totals } = candidates;
  await notifySlack(
    process.env.SLACK_WEBHOOK_URL,
    [
      `📈 本寺小路ガイド 週次SEOレポート（${startDate}〜${endDate}）`,
      `クリック ${totals.clicks} / 表示 ${totals.impressions}`,
      `CTR改善候補 ${candidates.lowCtr.length}件・あと一歩 ${candidates.striking.length}件・追記候補 ${candidates.uncovered.length}記事・新規ネタ ${candidates.gaps.length}件`,
      process.env.GITHUB_RUN_URL ? `詳細: ${process.env.GITHUB_RUN_URL}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

main().catch((err) => {
  console.error('[seo-report] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
