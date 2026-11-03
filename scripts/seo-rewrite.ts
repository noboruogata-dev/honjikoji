/**
 * scripts/seo-rewrite.ts
 *
 * SEO自動運転の「⑥リライト」。Search Console の改善候補（seo-report.ts と
 * 同じ選定ロジック）から最大3記事を選び、Gemini で次を行う:
 *
 *   1. 検索結果用タイトル（seoTitle）と説明文（description/summary）の改善案
 *      → 決定論的な検証（長さ・店名・記事に無い数字の混入・別表記の出所）を
 *        通ったものだけ反映する
 *   2. 「メニュー」で検索されているのに本文に価格情報が少ない店舗記事は、
 *      Google Search Grounding でメニューを調査し、引用付きで裏付けが取れた
 *      場合だけ「メニューと価格の例」の節を追加する
 *
 * このスクリプトはファイルを書き換えるだけで、コミット・PR作成はしない
 * （.github/workflows/seo-rewrite.yml が行う。main へ直接は公開しない）。
 * 書き換えの方針は scripts/lib/seoRewrite.ts の冒頭コメント参照。
 *
 * 使い方:
 *   npm run seo:rewrite [-- --days=28 --max=3 --pr-body=pr-body.md --dry-run]
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import {
  appendStepSummary,
  callGroundedJsonAgent,
  callPlainJsonAgent,
  FatalPipelineError,
  logZodIssues,
  parseJsonOrThrow,
  todayInTokyo,
} from './lib/gemini-agents.js';
import { fetchCandidates } from './lib/seoData.js';
import {
  appendToBody,
  applyMetaEdits,
  buildAlternateNamesNote,
  buildMenuPrompt,
  buildMenuSection,
  buildMetaPrompt,
  buildPrBody,
  dropRedundantAlternateNames,
  insertSectionBeforeLastHeading,
  menuResearchSchema,
  metaProposalResponseSchema,
  metaProposalSchema,
  pickTargets,
  REWRITE_LIMITS,
  validateMenuResearch,
  validateMetaProposal,
  type RewriteResult,
  type RewriteTarget,
} from './lib/seoRewrite.js';
import { notifySlackText } from './lib/slackText.js';

const LABEL = '[seo-rewrite]';
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function parseArgs(argv: string[]) {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const days = Number(get('days') ?? 28);
  const max = Number(get('max') ?? REWRITE_LIMITS.maxTargets);
  return {
    days: Number.isFinite(days) && days > 0 ? days : 28,
    max: Number.isFinite(max) && max > 0 ? max : REWRITE_LIMITS.maxTargets,
    prBody: get('pr-body'),
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * 直近 cooldownDays 日以内に seo(rewrite) コミットで変更された記事。
 * 効果を測る前に同じ記事を何度も書き換えないため。
 * （ワークフローは fetch-depth を深めにして checkout すること）
 */
function recentlyRewrittenKeys(): Set<string> {
  try {
    const out = execFileSync(
      'git',
      ['log', `--since=${REWRITE_LIMITS.cooldownDays}.days`, '--grep=^seo(rewrite)', '--name-only', '--format='],
      { cwd: REPO_ROOT, encoding: 'utf-8' }
    );
    const keys = new Set<string>();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^src\/content\/(spots|columns|news)\/(.+)\.md$/);
      if (m) keys.add(`${m[1]}/${m[2]}`);
    }
    return keys;
  } catch {
    console.warn(`${LABEL} git log を読めなかったため、直近リライト済みの除外をスキップします。`);
    return new Set();
  }
}

async function proposeMeta(ai: GoogleGenAI, target: RewriteTarget) {
  const label = `${LABEL} [meta ${target.article.slug}]`;
  const errors: string[] = [];
  // 1回目で検証に落ちたら、落ちた理由を添えてもう1回だけ試す。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt =
      attempt === 1
        ? buildMetaPrompt(target)
        : `${buildMetaPrompt(target)}\n\n# 前回の提案は次の理由で不採用でした。直してください\n${errors.map((e) => `- ${e}`).join('\n')}`;
    const rawText = await callPlainJsonAgent(ai, { label, prompt, responseSchema: metaProposalResponseSchema });
    const parsed = metaProposalSchema.safeParse(parseJsonOrThrow(rawText, label));
    if (!parsed.success) {
      logZodIssues(parsed, label, rawText);
      errors.splice(0, errors.length, '出力形式が不正でした。');
      continue;
    }
    const proposal = {
      ...parsed.data,
      alternateNames: dropRedundantAlternateNames(parsed.data.alternateNames, target.article),
    };
    const problems = validateMetaProposal(proposal, target);
    if (problems.length === 0) return { proposal, errors: [] };
    console.warn(`${label} 提案が検証を通りませんでした（${attempt}回目）:\n  - ${problems.join('\n  - ')}`);
    errors.splice(0, errors.length, ...problems);
  }
  return { proposal: undefined, errors };
}

async function researchMenu(ai: GoogleGenAI, target: RewriteTarget) {
  const label = `${LABEL} [menu ${target.article.slug}]`;
  const { text, groundingSourceCount } = await callGroundedJsonAgent(ai, {
    label,
    prompt: buildMenuPrompt(target.article),
    responseSchema: {},
  });
  const parsed = menuResearchSchema.safeParse(parseJsonOrThrow(text, label));
  if (!parsed.success) {
    logZodIssues(parsed, label, text);
    return { research: undefined, errors: ['調査結果の形式が不正でした。'] };
  }
  const errors = validateMenuResearch(parsed.data, groundingSourceCount);
  return errors.length === 0 ? { research: parsed.data, errors } : { research: undefined, errors };
}

async function main() {
  const { days, max, prBody, dryRun } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY が設定されていません。');
  const ai = new GoogleGenAI({ apiKey });

  const { startDate, endDate, candidates, articles } = await fetchCandidates(days);
  const recent = recentlyRewrittenKeys();
  if (recent.size > 0) console.log(`${LABEL} 直近${REWRITE_LIMITS.cooldownDays}日以内にリライト済みのため除外: ${[...recent].join(', ')}`);

  const targets = pickTargets(candidates, articles, recent, max);
  if (targets.length === 0) {
    const message = `${LABEL} リライト対象の記事はありませんでした。`;
    console.log(message);
    await appendStepSummary(message);
    return;
  }
  console.log(`${LABEL} 対象: ${targets.map((t) => `${t.article.collection}/${t.article.slug}`).join(', ')}`);

  const today = todayInTokyo();
  const results: RewriteResult[] = [];

  for (const target of targets) {
    const { article } = target;
    const result: RewriteResult = { target };
    let content = article.raw;

    try {
      const { proposal, errors } = await proposeMeta(ai, target);
      if (proposal) {
        content = applyMetaEdits(content, { seoTitle: proposal.seoTitle, description: proposal.description });
        if (proposal.alternateNames.length > 0) {
          const note = buildAlternateNamesNote(article.title, proposal.alternateNames);
          content = appendToBody(content, (body) => `${body.replace(/\s+$/, '')}\n\n${note}\n`);
        }
        result.meta = { before: { seoTitle: article.seoTitle, description: article.description }, after: proposal };
      } else {
        result.metaSkipped = errors;
      }

      if (target.needsMenu) {
        const { research, errors: menuErrors } = await researchMenu(ai, target);
        if (research) {
          const section = buildMenuSection(research, today);
          content = appendToBody(content, (body) => insertSectionBeforeLastHeading(body, section));
          result.menu = { items: research.items, sourceUrls: research.sourceUrls };
        } else {
          result.menuSkipped = menuErrors;
        }
      }
    } catch (err) {
      if (err instanceof FatalPipelineError) throw err;
      console.error(`${LABEL} ${article.slug} の処理に失敗しました。この記事はスキップします:`, err instanceof Error ? err.message : err);
      result.metaSkipped = [`処理エラー: ${err instanceof Error ? err.message : String(err)}`];
    }

    if (content !== article.raw) {
      if (dryRun) {
        console.log(`${LABEL} [dry-run] ${article.filePath} を書き換える予定でした。`);
      } else {
        await writeFile(article.filePath, content);
        console.log(`${LABEL} 書き換え: ${path.relative(REPO_ROOT, article.filePath)}`);
      }
    }
    results.push(result);
  }

  const body = buildPrBody(results, { startDate, endDate });
  console.log('');
  console.log(body);
  await appendStepSummary(body);
  if (prBody) await writeFile(prBody, body);

  const changed = results.filter((r) => r.meta || r.menu).length;
  await notifySlackText(
    process.env.SLACK_WEBHOOK_URL,
    `✍️ 本寺小路ガイド SEOリライト: ${changed}記事を書き換えました。PRを確認してマージしてください。${process.env.GITHUB_RUN_URL ? `\n${process.env.GITHUB_RUN_URL}` : ''}`,
    LABEL
  );
}

main().catch((err) => {
  console.error(`${LABEL} エラーが発生しました:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
