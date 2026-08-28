/**
 * scripts/generate-spot.ts
 *
 * 新潟県三条市「本寺小路」「本町」エリアに実在する飲食店を、3つのエージェントの
 * パイプラインで自律的にリサーチ・執筆・検証し、Markdown記事として
 * src/content/spots/ に保存するスクリプト。
 *
 *   Agent 1: Research Agent  — Google Search Grounding付きGeminiで実在店舗を
 *            1軒選定し、事実情報を厳密なJSONで抽出する。新規開店・リニューアル
 *            情報を優先的に探索し、開店から約1年以内なら isNew フラグを立てる。
 *   Agent 2: Writer Agent    — Agent 1のJSONだけを事実源として、地元メディア
 *            らしい紹介記事（800〜1200字）を執筆する（Grounding無し）。読みやすさの
 *            ため、段落数・見出し・1段落の文字数について構造要件を守るよう指示する。
 *   Agent 3: QA & Schema Validator Agent — Zodでフロントマターを厳密に検証し、
 *            bodyの構造要件（段落数・見出し数・最長段落文字数）も決定論的に
 *            チェックしたうえで、通過したものだけを src/content/spots/[slug].md
 *            に保存する（LLM呼び出しなし、コードのみ。構造要件は非ブロッキングの
 *            WARNで、満たさなくても保存はされる）。
 *
 * 注意: youtubeVideos はこのパイプラインでは絶対に生成・推測しない。
 * 実在する動画IDをLLMが幻覚する（または存在するが別動画を取り違える）
 * リスクを避けるため、意図的にAgent1/Agent2のどちらにも出力させていない。
 * このフィールドは運営者の手動編集、または scripts/match-youtube.ts による
 * 決定論的な自動マッチング（LLM不使用）でのみ設定される。
 *
 * 使い方:
 *   npm run generate:spot                      # 自律選定（除外リストは既存記事から自動生成）
 *   npm run generate:spot -- "店名"              # 指定した実在店舗をリサーチして生成
 *   npm run generate:spot -- "店名" "ジャンル"     # ジャンルのヒントも指定
 *
 * 事前準備:
 *   .env に GEMINI_API_KEY を設定してください（.env.example 参照）。
 *   https://aistudio.google.com/apikey で取得できます。
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
  pickRandom,
  slugify,
  toYamlString,
  uniqueSlug,
} from './lib/gemini-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const MAX_ATTEMPTS = 3;

const GENRES = [
  '居酒屋',
  'BAR',
  'スナック',
  '割烹',
  '焼肉',
  '焼き鳥',
  'ラーメン',
  'おでん',
  '立ち飲み',
  '小料理屋',
];

// 一覧ページのシーン別フィルターと対応させる、任意で付与を検討させるタグ。
const SCENE_TAGS = ['1軒目におすすめ', '2次会・締めに最適', '深夜営業'];

// ============================================================
// Zod スキーマ
// ============================================================

// Agent 1（Research）の出力スキーマ。
const researchSchema = z.object({
  notFound: z.boolean(),
  title: z.string(),
  genre: z.string(),
  address: z.string(),
  openHours: z.string(),
  regularHoliday: z.string(),
  budget: z.string(),
  vibes: z.array(z.string()),
  isNew: z.boolean(),
  facts: z.string(),
  slug: z.string(),
  sources: z.array(z.string()).optional(),
});
type ResearchResult = z.infer<typeof researchSchema>;

// Agent 2（Writer）の出力スキーマ。
const writerSchema = z.object({
  description: z.string(),
  body: z.string(),
});
type WriterResult = z.infer<typeof writerSchema>;

// Agent 3（QA）が最終検証する、src/content.config.ts のFrontmatterスキーマに
// 完全準拠したスキーマ。日付は書き込み前の文字列表現（YYYY-MM-DD）で検証する。
const spotFrontmatterSchema = z.object({
  title: z.string().min(1, 'title が空です'),
  genre: z.string().min(1, 'genre が空です'),
  address: z.string().min(1, 'address が空です'),
  mapQuery: z.string().min(1, 'mapQuery が空です'),
  budget: z.string().min(1, 'budget が空です'),
  openHours: z.string().min(1, 'openHours が空です'),
  regularHoliday: z.string().min(1, 'regularHoliday が空です'),
  vibes: z.array(z.string().min(1)).min(1, 'vibes が空です'),
  isNew: z.boolean().default(false),
  description: z.string().min(1, 'description が空です'),
  pubDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'pubDate は YYYY-MM-DD 形式である必要があります'),
});
type SpotFrontmatter = z.infer<typeof spotFrontmatterSchema>;

// ============================================================
// Gemini向け構造化出力スキーマ（Type ベース）
// ============================================================

const researchResponseSchema = {
  type: Type.OBJECT,
  properties: {
    notFound: {
      type: Type.BOOLEAN,
      description: '除外リスト以外の実在店舗が見つからなかった場合は true',
    },
    title: { type: Type.STRING, description: '正式な店名' },
    genre: { type: Type.STRING, description: `次のいずれか1つ: ${GENRES.join(' / ')}` },
    address: { type: Type.STRING, description: '新潟県三条市 本町周辺の正確な住所' },
    openHours: { type: Type.STRING, description: '営業時間（定休日は含めない）' },
    regularHoliday: { type: Type.STRING, description: '定休日（不明な場合は "不明" または "不定休"）' },
    budget: { type: Type.STRING, description: '予算目安（例: ￥3,000〜￥5,000）' },
    vibes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '特徴タグ3〜6個。例: "隠れ家", "カウンター席あり", "深夜営業"',
    },
    isNew: {
      type: Type.BOOLEAN,
      description:
        '開店・リニューアルオープンから約1年以内の新しい店舗だと分かった場合は true。不明・古くからの店舗なら false。',
    },
    facts: {
      type: Type.STRING,
      description:
        '名物料理・お酒のこだわり・店内の雰囲気・お店の歴史（開店/リニューアル時期が分かれば含める）など、紹介記事の執筆に使える事実のメモ。不明な項目は「不明」と明記し創作しない。',
    },
    slug: {
      type: Type.STRING,
      description: 'ファイル名用の英小文字ケバブケースslug（ローマ字/英訳、例: "izakaya-sanjoya"）。日本語不可。',
    },
    sources: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '参照したサイト名やURL（分かる範囲で）',
    },
  },
  required: [
    'notFound',
    'title',
    'genre',
    'address',
    'openHours',
    'regularHoliday',
    'budget',
    'vibes',
    'isNew',
    'facts',
    'slug',
  ],
};

const writerResponseSchema = {
  type: Type.OBJECT,
  properties: {
    description: { type: Type.STRING, description: '魅力的な要約（100字前後）' },
    body: {
      type: Type.STRING,
      description:
        '800〜1200字程度のMarkdown本文。おすすめメニュー・店内の雰囲気・利用シーン（1軒目/2軒目/締めなど）に触れる。',
    },
  },
  required: ['description', 'body'],
};

// ============================================================
// プロンプト構築
// ============================================================

function buildResearchPrompt(excludeTitles: string[], hintTitle?: string, hintGenre?: string): string {
  const exclusionText =
    excludeTitles.length > 0
      ? `次の店舗はすでに紹介済みです。絶対に選ばないでください:\n${excludeTitles
          .map((title) => `- ${title}`)
          .join('\n')}`
      : '（まだ紹介済みの店舗はありません）';

  const target = hintTitle
    ? `今回リサーチしてほしい店舗:「${hintTitle}」${hintGenre ? `（ジャンルの想定: ${hintGenre}）` : ''}
この店舗が新潟県三条市の本寺小路・本町エリアに実在し、除外リストに含まれていないかを確認したうえで調べてください。`
    : `新潟県三条市の「本寺小路」「本町」エリアに実在し、現在も営業している飲食店を1軒、あなた自身の判断で選んでください。
${hintGenre ? `できればジャンルは「${hintGenre}」系を優先的に検討してください（見つからなければ他ジャンルでも構いません）。` : ''}
【最優先】まずは次の観点で「新店舗」を積極的に探してください:
- ここ1年以内に新規オープンした店
- リニューアルオープン・移転オープンした店
- SNSやグルメサイトで最近「オープンしました」「移転しました」と話題になっている店
新店舗が見つからない場合に限り、定番の有名店やまだあまり知られていない老舗も候補に入れてください。`;

  return `あなたは新潟県三条市の歓楽街「本寺小路」「本町」エリアの飲食店リサーチを専門とするエージェントです。
Google検索を使って実在する飲食店（居酒屋・BAR・スナック・割烹・焼肉・焼き鳥・ラーメン・おでん・立ち飲み・小料理屋 等）についてファクトチェックしながら調査してください。

${target}

${exclusionText}

出力は厳密なJSON形式で、次の情報を可能な限り正確に埋めてください。
- title: 正式な店名
- genre: ${GENRES.join(' / ')} のいずれか
- address: 新潟県三条市 本町周辺の正確な住所
- openHours: 営業時間（定休日は含めない）
- regularHoliday: 定休日（不明な場合は "不明" または "不定休"）
- budget: 予算目安（例: ￥3,000〜￥5,000）
- vibes: 特徴タグ3〜6個（例: "隠れ家", "カウンター席あり", "深夜営業"）。可能であれば次の中から当てはまるものを含めてよい（無理に含めなくてもよい）: ${SCENE_TAGS.join(' / ')}
- isNew: 開店・リニューアルオープンから約1年以内と判断できる場合は true、それ以外・不明な場合は false
- facts: 名物料理・お酒のこだわり・店内の雰囲気・お店の歴史（開店/リニューアル時期の情報があれば必ず含める）など、紹介記事の執筆に使える事実をまとめたテキスト。分からない項目は「不明」と明記し、絶対に創作しないこと。
- slug: ファイル名用の英小文字ケバブケースslug（ローマ字/英訳）
- sources: 参照したサイト名やURL（分かる範囲で）

重要な注意点:
- 実在しない店舗を創作しないでください。
- 除外リストの店舗、または本寺小路・本町エリア以外の店舗しか見つからない場合は、
  notFound を true にし、他のフィールドは空文字列（配列は空配列、isNewはfalse）にしてください。`;
}

function buildWriterPrompt(research: ResearchResult): string {
  return `あなたは新潟県三条市の歓楽街「本寺小路」を紹介する、地元メディアのライターです。
以下はリサーチ担当エージェントが調べた実在店舗の事実情報です。この内容だけを事実として扱い、
書かれていない情報を創作・推測で補わないでください。「不明」となっている項目には無理に触れなくて構いません。
他サイトや口コミの文章をそのまま転載しないでください。

--- リサーチ結果 ---
店名: ${research.title}
ジャンル: ${research.genre}
住所: ${research.address}
営業時間: ${research.openHours}
定休日: ${research.regularHoliday}
予算目安: ${research.budget}
特徴タグ: ${research.vibes.join(', ')}
新店舗か: ${research.isNew ? 'はい（開店・リニューアルから概ね1年以内）' : 'いいえ、または不明'}
事実メモ:
${research.facts}
--- ここまで ---

紹介記事本文（body）の執筆ルール:
- 800〜1200字程度、Markdown形式。
- あなた自身の言葉で、地元メディアらしい温かみと情緒のあるオリジナルコラムとして書き下ろすこと。
- おすすめメニュー、店内の雰囲気、利用シーン（1軒目/2軒目/締めなど）に触れること。
  ただし、事実メモに具体的な記載がない場合は、断定的な固有の料理名などを創作せず、一般的・控えめな表現に留めること。
- 新店舗である場合は、その新しさ・オープンの経緯にも自然に触れること（無理に強調しすぎないこと）。
- 文体は敬体（です・ます調）で、本寺小路の夜の情緒が伝わるように。
- 以下の構造要件を必ず守ること（読みやすさのため。800〜1200字なら通常は
  自然に満たせるはずです）:
  - 200字を超える場合は、必ず2段落以上（空行区切り）に分けること
  - 400字を超える場合は、「## 」で始まる見出しを1つ以上入れること
  - 1段落は最大でも150字程度に収めること
- 動画やYouTubeへの言及・リンク・埋め込みは一切書かないでください。
  youtubeVideos はこの記事執筆の範囲外で、別の仕組み（運営者の手動設定、または
  決定論的な自動マッチング処理）でのみ設定されるフィールドです。事実メモに
  動画に関する情報が含まれていても、本文では触れないでください。

description（Frontmatter用の要約）は100字前後で、記事の魅力が一目で伝わるように。`;
}

// ============================================================
// Agent 1: Research Agent (Google Search Grounding)
// ============================================================

async function runResearchAgent(
  ai: GoogleGenAI,
  excludeTitles: string[],
  hintTitle?: string,
  hintGenre?: string
): Promise<ResearchResult> {
  const label = '[Agent1:Research]';
  console.log(`${label} 起動。Google Search Groundingで実在店舗をリサーチ中（新店舗を優先探索）...`);

  const rawText = await callGroundedJsonAgent(ai, {
    label,
    prompt: buildResearchPrompt(excludeTitles, hintTitle, hintGenre),
    responseSchema: researchResponseSchema,
  });

  const parsedJson = parseJsonOrThrow(rawText, label);
  const result = researchSchema.safeParse(parsedJson);
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent1(Research)のレスポンスがスキーマ違反です。');
  }

  if (result.data.notFound) {
    console.warn(`${label} 除外リスト以外の実在店舗が見つかりませんでした。`);
  } else {
    console.log(
      `${label} 完了。選定店舗: 「${result.data.title}」（${result.data.genre}）${result.data.isNew ? ' [NEW]' : ''}`
    );
    console.log(`${label} 住所: ${result.data.address} / 営業時間: ${result.data.openHours} / 定休日: ${result.data.regularHoliday}`);
    console.log(`${label} vibes: ${result.data.vibes.join(', ') || '(なし)'}`);
  }

  return result.data;
}

// ============================================================
// Agent 2: Writer Agent (通常のGemini Flash・Grounding無し)
// ============================================================

async function runWriterAgent(ai: GoogleGenAI, research: ResearchResult): Promise<WriterResult> {
  const label = '[Agent2:Writer]';
  console.log(`${label} 起動。Agent1の調査結果をもとに紹介記事を執筆中...`);

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
  console.log(`${label} 完了。本文を生成しました（${charCount}字）。`);
  if (charCount < 700 || charCount > 1400) {
    console.warn(`${label} 本文の文字数が目安（800〜1200字）から外れています（${charCount}字）。内容は保存されます。`);
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
    title: research.title,
    genre: research.genre,
    address: research.address,
    mapQuery: `${research.title} 三条市`,
    budget: research.budget,
    openHours: research.openHours,
    regularHoliday: research.regularHoliday,
    vibes: research.vibes,
    isNew: research.isNew,
    description: writer.description,
    pubDate: new Date().toISOString().slice(0, 10),
  };

  const result = spotFrontmatterSchema.safeParse(candidate);
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent3(QA)がFrontmatterのスキーマ違反を検出しました。');
  }

  const fm: SpotFrontmatter = result.data;

  if (!GENRES.includes(fm.genre)) {
    console.warn(`${label} genre "${fm.genre}" は既定リスト外ですが、そのまま採用します。`);
  }

  const slug = uniqueSlug(slugify(research.slug), existingSlugs, 'spot');
  console.log(`${label} 検証OK。保存先slug: ${slug}${fm.isNew ? '（新店舗フラグ: ON）' : ''}`);

  // 構造要件（段落数・見出し数・最長段落文字数）の決定論的チェック。
  // generate-news.ts と同じ非ブロッキング方針（満たさなくても保存は続行）。
  const structure = analyzeArticleStructure(writer.body);
  const structureWarnings = checkArticleStructure(structure);
  for (const warning of structureWarnings) {
    console.warn(`${label} [構造チェック] ${warning}`);
  }

  const frontmatter = [
    '---',
    `title: ${toYamlString(fm.title)}`,
    `genre: ${toYamlString(fm.genre)}`,
    `address: ${toYamlString(fm.address)}`,
    `mapQuery: ${toYamlString(fm.mapQuery)}`,
    `budget: ${toYamlString(fm.budget)}`,
    `openHours: ${toYamlString(fm.openHours)}`,
    `regularHoliday: ${toYamlString(fm.regularHoliday)}`,
    'vibes:',
    ...fm.vibes.map((vibe) => `  - ${toYamlString(vibe)}`),
    `isNew: ${fm.isNew}`,
    `description: ${toYamlString(fm.description)}`,
    `pubDate: ${fm.pubDate}`,
    '---',
    '',
    '',
  ].join('\n');

  const filePath = path.join(SPOTS_DIR, `${slug}.md`);
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
      '[generate-spot] GEMINI_API_KEY が設定されていません。.env に GEMINI_API_KEY=... を追加してください（.env.example 参照）。'
    );
    process.exit(1);
  }

  const [hintTitle, hintGenre] = process.argv.slice(2);
  const ai = new GoogleGenAI({ apiKey });

  console.log('============================================================');
  console.log(' 本寺小路ガイド 自動記事生成パイプライン（新店舗優先）');
  console.log(' Agent1(Research) -> Agent2(Writer) -> Agent3(QA & Save)');
  console.log('============================================================');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n----- 試行 ${attempt}/${MAX_ATTEMPTS} -----`);

    try {
      const { titles: excludeTitles, slugs: existingSlugs } = await getExistingEntries(SPOTS_DIR);
      console.log(
        `[generate-spot] 既存記事: ${existingSlugs.length}件（除外対象タイトル: ${excludeTitles.length}件）`
      );

      const preferredGenre = hintGenre ?? (hintTitle ? undefined : pickRandom(GENRES));
      const research = await runResearchAgent(ai, excludeTitles, hintTitle, preferredGenre);

      if (research.notFound) {
        console.warn('[generate-spot] 候補が見つからなかったため、リトライします。');
        continue;
      }

      const isDuplicate = excludeTitles.some(
        (title) => normalizeText(title) === normalizeText(research.title)
      );
      if (isDuplicate) {
        console.warn(`[generate-spot] 「${research.title}」はすでに掲載済みでした。リトライします。`);
        continue;
      }

      const writer = await runWriterAgent(ai, research);
      const filePath = await runQaAgent(research, writer, existingSlugs);

      console.log('\n============================================================');
      console.log(
        ` 完了: 「${research.title}」（${research.genre}）${research.isNew ? '[NEW] ' : ''}を保存しました。`
      );
      console.log(` -> ${path.relative(process.cwd(), filePath)}`);
      console.log('============================================================');
      return;
    } catch (err) {
      if (err instanceof FatalPipelineError) {
        console.error(`\n[generate-spot] 致命的エラーのため処理を安全に停止します: ${err.message}`);
        process.exitCode = 1;
        return;
      }

      console.error(
        `[generate-spot] 試行 ${attempt}/${MAX_ATTEMPTS} でエラーが発生しました:`,
        err instanceof Error ? err.message : err
      );

      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${MAX_ATTEMPTS}回試行しましたが、記事の生成に失敗しました。処理を停止します。`);
      }
      console.log('[generate-spot] リトライします...');
    }
  }
}

main().catch((err) => {
  console.error('[generate-spot] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
