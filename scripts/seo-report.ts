/**
 * scripts/seo-report.ts
 *
 * Search Console の直近28日分の数値を取得し、改善候補の記事・クエリを
 * レポートする（SEO自動運転の「⑤分析」部分）。記事は一切書き換えない
 * （読み取り専用）。リライト（⑥）は scripts/seo-rewrite.ts が行う。
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
import { writeFile } from 'node:fs/promises';
import { appendStepSummary } from './lib/gemini-agents.js';
import { formatReport } from './lib/seoCandidates.js';
import { fetchCandidates } from './lib/seoData.js';
import { notifySlackText } from './lib/slackText.js';

function parseArgs(argv: string[]): { days: number; out?: string } {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const days = Number(get('days') ?? 28);
  return { days: Number.isFinite(days) && days > 0 ? days : 28, out: get('out') };
}

async function main() {
  const { days, out } = parseArgs(process.argv.slice(2));
  const { siteUrl, startDate, endDate, candidates } = await fetchCandidates(days);
  const report = formatReport(candidates, { startDate, endDate });

  console.log('');
  console.log(report);
  await appendStepSummary(report);

  if (out) {
    await writeFile(out, JSON.stringify({ siteUrl, startDate, endDate, ...candidates }, null, 2));
    console.log(`[seo-report] 候補JSONを書き出しました: ${out}`);
  }

  const { totals } = candidates;
  await notifySlackText(
    process.env.SLACK_WEBHOOK_URL,
    [
      `📈 本寺小路ガイド 週次SEOレポート（${startDate}〜${endDate}）`,
      `クリック ${totals.clicks} / 表示 ${totals.impressions}`,
      `CTR改善候補 ${candidates.lowCtr.length}件・あと一歩 ${candidates.striking.length}件・追記候補 ${candidates.uncovered.length}記事・新規ネタ ${candidates.gaps.length}件`,
      process.env.GITHUB_RUN_URL ? `詳細: ${process.env.GITHUB_RUN_URL}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    '[seo-report]'
  );
}

main().catch((err) => {
  console.error('[seo-report] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
