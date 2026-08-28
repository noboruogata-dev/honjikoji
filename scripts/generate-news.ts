/**
 * scripts/generate-news.ts
 *
 * 新潟県三条市「本寺小路」エリアの最新の話題（新規開店・イベント・お知らせ）を、
 * scripts/generate-spot.ts と同じ3エージェント構成でリサーチ・執筆・検証し、
 * Markdown記事として src/content/news/ に保存するスクリプト。
 *
 *   Agent 1: Research Agent — Google Search Groundingで「三条市 本寺小路
 *            イベント」「三条市 歓楽街 祭り」「三条市 新規オープン 飲食店」
 *            などを調査し、1つの話題を選んで事実情報を厳密なJSONで抽出する。
 *   Agent 2: Writer Agent   — Agent 1のJSONだけを事実源として、街の回遊を
 *            促すニュース記事本文（body・300〜500字）と、一覧カード/OGP用の
 *            短い要約（summary・100字前後）を分けて執筆する（Grounding無し）。
 *            bodyは読みやすさのため、段落数・見出し・1段落の文字数について
 *            構造要件を守るよう指示している。
 *   Agent 3: QA & Schema Validator Agent — Zodでフロントマターを厳密に検証し、
 *            bodyの構造要件（段落数・見出し数・最長段落文字数）も決定論的に
 *            チェックしたうえで、通過したものだけを src/content/news/[slug].md
 *            に保存する（LLM呼び出しなし、コードのみ。構造要件は非ブロッキングの
 *            WARNで、満たさなくても保存はされる）。
 *
 * 使い方:
 *   npm run generate:news
 *
 * 事前準備:
 *   .env に GEMINI_API_KEY を設定してください（.env.example 参照）。
 */

import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  analyzeArticleStructure,
  callGroundedJsonAgent,
  callPlainJsonAgent,
  checkArticleStructure,
  FatalPipelineError,
  getExistingEntries,
  logZodIssues,
  normalizeText,
  parseJsonOrThrow,
  slugify,
  toYamlString,
  uniqueSlug,
} from './lib/gemini-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWS_DIR = path.resolve(__dirname, '../src/content/news');
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const MAX_ATTEMPTS = 3;

const CATEGORIES = ['NEW SPOT', 'EVENT', 'NOTICE'] as const;
type Category = (typeof CATEGORIES)[number];

const SEARCH_QUERIES = ['三条市 本寺小路 イベント', '三条市 歓楽街 祭り', '三条市 新規オープン 飲食店'];

// ============================================================
// Zod スキーマ
// ============================================================

// Agent 1（Research）の出力スキーマ。
const researchSchema = z.object({
  notFound: z.boolean(),
  headline: z.string(),
  category: z.string(),
  facts: z.string(),
  relatedSpotSlug: z.string().optional().default(''),
  slug: z.string(),
  sources: z.array(z.string()).optional(),
});
type ResearchResult = z.infer<typeof researchSchema>;

// Agent 2（Writer）の出力スキーマ。
// summary（frontmatter・一覧カード・OGP用の短い要約）と body（記事本文）は
// 別物として分離する。以前は summary をそのまま本文としても保存しており、
// 「短い要約」と「読み応えのある本文」を両立できなかったため。
const writerSchema = z.object({
  title: z.string(),
  summary: z.string(),
  body: z.string(),
});
type WriterResult = z.infer<typeof writerSchema>;

// Agent 3（QA）が最終検証する、src/content.config.ts の news Frontmatterスキーマに
// 完全準拠したスキーマ。
const newsFrontmatterSchema = z.object({
  title: z.string().min(1, 'title が空です'),
  pubDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'pubDate は YYYY-MM-DD 形式である必要があります'),
  category: z.enum(CATEGORIES),
  summary: z.string().min(1, 'summary が空です'),
  relatedSpotSlug: z.string().min(1).optional(),
});
type NewsFrontmatter = z.infer<typeof newsFrontmatterSchema>;

// ============================================================
// Gemini向け構造化出力スキーマ（Type ベース）
// ============================================================

const researchResponseSchema = {
  type: Type.OBJECT,
  properties: {
    notFound: {
      type: Type.BOOLEAN,
      description: '除外リスト以外の該当する話題が見つからなかった場合は true',
    },
    headline: { type: Type.STRING, description: '話題を要約する簡潔な見出し（下書き。後で編集される）' },
    category: {
      type: Type.STRING,
      description: `次のいずれか1つ: ${CATEGORIES.join(' / ')}（NEW SPOT=新規開店・リニューアル、EVENT=祭り・イベント、NOTICE=その他のお知らせ）`,
    },
    facts: {
      type: Type.STRING,
      description: '調べて分かった事実（日時・場所・詳細など）。不明な部分は「不明」と明記し、絶対に創作しない。',
    },
    relatedSpotSlug: {
      type: Type.STRING,
      description: '既知店舗リストに一致する話題であればそのslug、なければ空文字',
    },
    slug: {
      type: Type.STRING,
      description: 'ファイル名用の英小文字ケバブケースslug（ローマ字/英訳）。日本語不可。',
    },
    sources: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '参照したサイト名やURL（分かる範囲で）',
    },
  },
  required: ['notFound', 'headline', 'category', 'facts', 'relatedSpotSlug', 'slug'],
};

const writerResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '30字前後の簡潔な見出し' },
    summary: {
      type: Type.STRING,
      description:
        '100字前後。一覧カード・OGP説明文に使う短い要約。bodyの書き出しと同じ文にしないこと。',
    },
    body: {
      type: Type.STRING,
      description:
        '300〜500字程度、Markdown形式。街の回遊を促す、明るく読みやすいニュース記事本文。',
    },
  },
  required: ['title', 'summary', 'body'],
};

// ============================================================
// プロンプト構築
// ============================================================

interface KnownSpot {
  title: string;
  slug: string;
}

function buildResearchPrompt(excludeTopics: string[], knownSpots: KnownSpot[]): string {
  const exclusionText =
    excludeTopics.length > 0
      ? `次の話題はすでに記事化済みです。同じ話題を選ばないでください:\n${excludeTopics
          .map((topic) => `- ${topic}`)
          .join('\n')}`
      : '（まだ記事化済みの話題はありません）';

  const knownSpotsText =
    knownSpots.length > 0
      ? `当サイトで既に紹介済みの店舗一覧（ニュースがこれらの店舗に関するものであれば、対応するslugをrelatedSpotSlugに設定してください。関係なければ空文字のままにしてください）:\n${knownSpots
          .map((spot) => `- ${spot.title} (slug: ${spot.slug})`)
          .join('\n')}`
      : '';

  return `あなたは新潟県三条市の歓楽街「本寺小路」エリアの最新情報を追うニュースリサーチャーです。
Google検索を使って、次のような観点から話題を調べてください:
- 「${SEARCH_QUERIES[0]}」
- 「${SEARCH_QUERIES[1]}」
- 「${SEARCH_QUERIES[2]}」

本寺小路・本町エリアに関連する、なるべく新しく具体的な話題を1つ選んでください（新規開店・リニューアルオープン・地域のお祭りやイベント・その他街の話題など）。

${exclusionText}

${knownSpotsText}

出力は厳密なJSON形式で、次の情報を可能な限り正確に埋めてください。
- headline: 話題を要約する簡潔な見出し（下書き）
- category: ${CATEGORIES.join(' / ')} のいずれか
- facts: 調べて分かった事実（日時・場所・詳細など）をまとめたテキスト。分からない部分は「不明」と明記し、絶対に創作しないこと。
- relatedSpotSlug: 上記の既知店舗リストに一致する話題であればそのslug、なければ空文字
- slug: ファイル名用の英小文字ケバブケースslug（ローマ字/英訳）
- sources: 参照したサイト名やURL（分かる範囲で）

重要な注意点:
- 実在しない話題を創作しないでください。
- 除外リストと重複する話題、または本寺小路・三条市に関連しない話題しか見つからない場合は、
  notFound を true にし、他のフィールドは空文字列（配列は空配列）にしてください。`;
}

function buildWriterPrompt(research: ResearchResult): string {
  return `あなたは新潟県三条市の歓楽街「本寺小路」のニュース欄を担当するライターです。
以下はリサーチ担当エージェントが調べた話題の事実情報です。この内容だけを事実として扱い、
書かれていない情報を創作しないでください。他サイトの文章をそのまま転載しないでください。

--- リサーチ結果 ---
見出し案: ${research.headline}
カテゴリ: ${research.category}
事実メモ:
${research.facts}
--- ここまで ---

執筆ルール:
- title: 30字前後の簡潔な見出し。
- summary: 100字前後。一覧カード・OGP説明文に使う短い要約。bodyとは独立した
  文章にすること（bodyの書き出しと同一文・ほぼ同じ文にしない）。
- body: 300〜500字程度、Markdown形式。街の回遊を促す、明るく読みやすい文体
  （です・ます調）で、読んだ人が「行ってみよう」「寄ってみよう」と思えるように
  書くこと。事実メモにない情報を創作しないこと。
  以下の構造要件を必ず守ること（読みやすさのため）:
  - 200字を超える場合は、必ず2段落以上（空行区切り）に分けること
  - 400字を超える場合は、「## 」で始まる見出しを1つ以上入れること
  - 1段落は最大でも150字程度に収めること`;
}

// ============================================================
// Agent 1: Research Agent (Google Search Grounding)
// ============================================================

async function runResearchAgent(
  ai: GoogleGenAI,
  excludeTopics: string[],
  knownSpots: KnownSpot[]
): Promise<ResearchResult> {
  const label = '[Agent1:Research]';
  console.log(`${label} 起動。Google Search Groundingで本寺小路の最新話題をリサーチ中...`);

  const rawText = await callGroundedJsonAgent(ai, {
    label,
    prompt: buildResearchPrompt(excludeTopics, knownSpots),
    responseSchema: researchResponseSchema,
  });

  const parsedJson = parseJsonOrThrow(rawText, label);
  const result = researchSchema.safeParse(parsedJson);
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent1(Research)のレスポンスがスキーマ違反です。');
  }

  if (result.data.notFound) {
    console.warn(`${label} 除外リスト以外の該当する話題が見つかりませんでした。`);
  } else {
    console.log(`${label} 完了。選定した話題: 「${result.data.headline}」（${result.data.category}）`);
    if (result.data.relatedSpotSlug) {
      console.log(`${label} 関連店舗slug: ${result.data.relatedSpotSlug}`);
    }
  }

  return result.data;
}

// ============================================================
// Agent 2: Writer Agent (通常のGemini Flash・Grounding無し)
// ============================================================

async function runWriterAgent(ai: GoogleGenAI, research: ResearchResult): Promise<WriterResult> {
  const label = '[Agent2:Writer]';
  console.log(`${label} 起動。Agent1の調査結果をもとにニュース記事を執筆中...`);

  const rawText = await callPlainJsonAgent(ai, {
    label,
    prompt: buildWriterPrompt(research),
    responseSchema: writerResponseSchema,
  });

  const parsedJson = parseJsonOrThrow(rawText, label);
  const result = writerSchema.safeParse(parsedJson);
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent2(Writer)のレスポンスがスキーマ違反です。');
  }

  const charCount = [...result.data.body].length;
  console.log(`${label} 完了。記事を生成しました（本文${charCount}字）。`);
  if (charCount < 200 || charCount > 700) {
    console.warn(`${label} 文字数が目安（300〜500字）から外れています（${charCount}字）。内容は保存されます。`);
  }

  return result.data;
}

// ============================================================
// Agent 3: QA & Schema Validator Agent（LLM呼び出しなし、コードのみ）
// ============================================================

async function runQaAgent(
  research: ResearchResult,
  writer: WriterResult,
  existingSlugs: string[]
): Promise<string> {
  const label = '[Agent3:QA]';
  console.log(`${label} 起動。Frontmatterスキーマ（Zod）を検証中...`);

  const candidate: Record<string, unknown> = {
    title: writer.title,
    pubDate: new Date().toISOString().slice(0, 10),
    category: research.category,
    summary: writer.summary,
    relatedSpotSlug: research.relatedSpotSlug || undefined,
  };

  const result = newsFrontmatterSchema.safeParse(candidate);
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent3(QA)がFrontmatterのスキーマ違反を検出しました。');
  }

  const fm: NewsFrontmatter = result.data;
  const slug = uniqueSlug(slugify(research.slug), existingSlugs, 'news');
  console.log(`${label} 検証OK。保存先slug: ${slug}`);

  // 構造要件（段落数・見出し数・最長段落文字数）の決定論的チェック。
  // 満たさなくても保存はブロックしない（既存の文字数チェックと同じ方針）。
  const structure = analyzeArticleStructure(writer.body);
  const structureWarnings = checkArticleStructure(structure);
  for (const warning of structureWarnings) {
    console.warn(`${label} [構造チェック] ${warning}`);
  }

  const frontmatter = [
    '---',
    `title: ${toYamlString(fm.title)}`,
    `pubDate: ${fm.pubDate}`,
    `category: ${toYamlString(fm.category)}`,
    `summary: ${toYamlString(fm.summary)}`,
    ...(fm.relatedSpotSlug ? [`relatedSpotSlug: ${toYamlString(fm.relatedSpotSlug)}`] : []),
    '---',
    '',
    '',
  ].join('\n');

  const filePath = path.join(NEWS_DIR, `${slug}.md`);
  await writeFile(filePath, frontmatter + writer.body.trim() + '\n', 'utf-8');

  console.log(`${label} 完了。保存しました: ${path.relative(process.cwd(), filePath)}`);
  return filePath;
}

// ============================================================
// オーケストレーター
// ============================================================

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      '[generate-news] GEMINI_API_KEY が設定されていません。.env に GEMINI_API_KEY=... を追加してください（.env.example 参照）。'
    );
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });

  console.log('============================================================');
  console.log(' 本寺小路ガイド ニュース自動生成パイプライン');
  console.log(' Agent1(Research) -> Agent2(Writer) -> Agent3(QA & Save)');
  console.log('============================================================');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n----- 試行 ${attempt}/${MAX_ATTEMPTS} -----`);

    try {
      const { titles: excludeTopics, slugs: existingSlugs } = await getExistingEntries(NEWS_DIR);
      const { titles: spotTitles, slugs: spotSlugs } = await getExistingEntries(SPOTS_DIR);
      const knownSpots: KnownSpot[] = spotTitles.map((title, i) => ({ title, slug: spotSlugs[i] }));

      console.log(
        `[generate-news] 既存ニュース: ${existingSlugs.length}件（除外対象話題: ${excludeTopics.length}件） / 既知店舗: ${knownSpots.length}件`
      );

      const research = await runResearchAgent(ai, excludeTopics, knownSpots);

      if (research.notFound) {
        console.warn('[generate-news] 該当する話題が見つからなかったため、リトライします。');
        continue;
      }

      const isDuplicate = excludeTopics.some(
        (topic) => normalizeText(topic) === normalizeText(research.headline)
      );
      if (isDuplicate) {
        console.warn(`[generate-news] 「${research.headline}」はすでに記事化済みでした。リトライします。`);
        continue;
      }

      const writer = await runWriterAgent(ai, research);
      const filePath = await runQaAgent(research, writer, existingSlugs);

      console.log('\n============================================================');
      console.log(` 完了: 「${writer.title}」（${research.category}）を保存しました。`);
      console.log(` -> ${path.relative(process.cwd(), filePath)}`);
      console.log('============================================================');
      return;
    } catch (err) {
      if (err instanceof FatalPipelineError) {
        console.error(`\n[generate-news] 致命的エラーのため処理を安全に停止します: ${err.message}`);
        process.exitCode = 1;
        return;
      }

      console.error(
        `[generate-news] 試行 ${attempt}/${MAX_ATTEMPTS} でエラーが発生しました:`,
        err instanceof Error ? err.message : err
      );

      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${MAX_ATTEMPTS}回試行しましたが、ニュース記事の生成に失敗しました。処理を停止します。`);
      }
      console.log('[generate-news] リトライします...');
    }
  }
}

main().catch((err) => {
  console.error('[generate-news] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
