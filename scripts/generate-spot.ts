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
 *            WARNで、満たさなくても保存はされる）。GOOGLE_PLACES_API_KEY が
 *            設定されていれば、Text Searchで店名・住所からPlace IDも解決して
 *            保存する（scripts/lib/googlePlaces.ts。解決できなくても保存は続行）。
 *
 * 営業時間まわりの設計（2系統）:
 *   系統1（詳細ページの表示）: Place IDがあれば、詳細ページが表示のたびに
 *     Place Details (New) をライブ取得して表示する（src/components/LivePlaceHours.astro
 *     と functions/api/place-hours.ts）。Places API由来のコンテンツはビルド時にも
 *     このリポジトリにも一切保存しない（Google Maps Platform利用規約で
 *     opening hoursの保存・キャッシュが許可されていないため）。
 *   系統2（サイト内の営業中判定・フィルタ・路地マップ点灯など）: 引き続き
 *     このAgent3がopenHours/regularHolidayから決定論的に導出するhours
 *     （src/lib/hours.ts）を使う。Places APIとは無関係の既存ロジックのまま。
 *
 * 注意: youtubeVideos はこのパイプラインでは絶対に生成・推測しない。
 * 実在する動画IDをLLMが幻覚する（または存在するが別動画を取り違える）
 * リスクを避けるため、意図的にAgent1/Agent2のどちらにも出力させていない。
 * youtubeVideos は運営者の手動編集、または scripts/match-youtube.ts による
 * 決定論的な自動マッチング（LLM不使用）でのみ設定される。
 * socialLinks はAgent 1のGoogle Search Groundingで公式性を確認できた候補だけを
 * 収集し、Agent 3がSNSごとのURL形式を決定論的に検証してから設定する。
 *
 * 使い方:
 *   npm run generate:spot                      # 自律選定（除外リストは既存記事から自動生成）
 *   npm run generate:spot -- "店名"              # 指定した実在店舗をリサーチして生成
 *   npm run generate:spot -- "店名" "ジャンル"     # ジャンルのヒントも指定
 *
 * 事前準備:
 *   .env に GEMINI_API_KEY を設定してください（.env.example 参照）。
 *   https://aistudio.google.com/apikey で取得できます。
 *   GOOGLE_PLACES_API_KEY は任意です（未設定でもplaceIdが付かないだけで動作します）。
 */

import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SOCIAL_PLATFORMS, validateResearchedSocialLinks } from './lib/socialLinks';
import {
  analyzeArticleStructure,
  appendStepSummary,
  buildNewsFrontmatterBlock,
  callGroundedJsonAgent,
  callPlainJsonAgent,
  checkArticleStructure,
  FatalPipelineError,
  getExistingEntries,
  logZodIssues,
  newsFrontmatterSchema,
  normalizeText,
  parseJsonOrThrow,
  pickRandom,
  readFrontmatter,
  slugify,
  summarizeOutcomes,
  todayInTokyo,
  toYamlString,
  uniqueSlug,
} from './lib/gemini-agents.js';
import { parseBudgetRange } from './lib/budgetParser.js';
import { isIrregularHoliday, parseOpenHoursToHours } from './lib/openHoursParser.js';
import { resolvePlaceId, resolveRegularOpeningHoursPeriods } from './lib/googlePlaces.js';
import { compareHoursWithGoogle } from './lib/hoursComparison.js';
import { runInstagramMaterialAgent } from './lib/instagramMaterialAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const NEWS_DIR = path.resolve(__dirname, '../src/content/news');
// scripts/match-youtube.ts が書き出すファイルと同じパス（リポジトリルート直下）。
const UNMATCHED_VIDEOS_PATH = path.resolve(__dirname, '../unmatched-videos.json');
const MAX_ATTEMPTS = 3;

// 各試行が最終的にどうなったかを記録し、全滅した場合でも「何が起きたか」を
// ログとJob Summaryに必ず残すための集計用ラベル。
type AttemptOutcome = 'notFound' | 'duplicate' | 'success' | 'error';
const OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  notFound: '候補なし',
  duplicate: '重複',
  success: '成功',
  error: 'エラー',
};

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
  socialLinks: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS),
        url: z.string(),
        evidenceUrl: z.string(),
      })
    )
    .optional()
    .default([]),
  // 参考ヒントリスト（燕三条TV動画由来の店名候補）のうち、Google検索で現在の
  // 営業状況を確認できなかった店名。ヒントを渡していない試行では空配列になる。
  unconfirmedHintStores: z.array(z.string()).optional().default([]),
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
  // Google Places API (New) のText Searchで解決できた場合のみ設定する
  // （解決できなければ未設定のまま。content.config.tsのコメント参照）。
  placeId: z.string().optional(),
  budget: z.string().min(1, 'budget が空です'),
  // budgetからscripts/lib/budgetParser.tsで導出できた場合のみ設定する
  // （導出できなければ未設定のまま）。
  budgetMin: z.number().int().positive().optional(),
  budgetMax: z.number().int().positive().optional(),
  openHours: z.string().min(1, 'openHours が空です'),
  regularHoliday: z.string().min(1, 'regularHoliday が空です'),
  vibes: z.array(z.string().min(1)).min(1, 'vibes が空です'),
  isNew: z.boolean().default(false),
  // openHours/regularHolidayからscripts/lib/openHoursParser.tsで導出できた
  // 場合のみ設定する（導出できなければ未設定のまま。誤った営業時間よりは
  // hours欠落＝unknown表示の方が安全という方針）。
  hours: z
    .array(
      z.object({
        days: z.array(z.number().int().min(0).max(6)),
        open: z.string().regex(/^\d{1,2}:\d{2}$/),
        close: z.string().regex(/^\d{1,2}:\d{2}$/),
      })
    )
    .optional(),
  // regularHolidayに「不定休」を含む場合のみtrue（isIrregularHoliday）。
  // hours/budgetMaxと同じ完全な任意フィールドで、falseは書き込まない。
  isIrregular: z.boolean().optional(),
  socialLinks: z
    .array(
      z.object({
        platform: z.enum(SOCIAL_PLATFORMS),
        url: z.url(),
      })
    )
    .optional(),
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
    socialLinks: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          platform: {
            type: Type.STRING,
            description: 'instagram / facebook / x / line のいずれか',
          },
          url: { type: Type.STRING, description: '店舗公式SNSアカウントのHTTPS完全URL' },
          evidenceUrl: {
            type: Type.STRING,
            description: 'そのSNSが店舗公式だと確認できる公式サイトまたは信頼できる店舗情報ページのHTTPS URL',
          },
        },
        required: ['platform', 'url', 'evidenceUrl'],
      },
      description: '公式性を高い確度で確認できたSNSのみ。不明・候補・推測は含めず空配列にする。',
    },
    unconfirmedHintStores: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        '参考情報として提示された店名リストのうち、検索しても現在の営業状況（実在・現存しているか）を確認できなかった店名。ヒントが提示されていない、またはヒント以外の店を選んだ場合は空配列。',
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
    'socialLinks',
    'unconfirmedHintStores',
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

function buildResearchPrompt(
  excludeTitles: string[],
  hintTitle?: string,
  hintGenre?: string,
  videoHints: string[] = []
): string {
  const exclusionText =
    excludeTitles.length > 0
      ? `次の店舗はすでに紹介済みです。絶対に選ばないでください:\n${excludeTitles
          .map((title) => `- ${title}`)
          .join('\n')}`
      : '（まだ紹介済みの店舗はありません）';

  const videoHintsText =
    videoHints.length > 0
      ? `
【第2段階で使ってよい参考情報】
地元メディア「燕三条TV」が過去に本寺小路エリアで取材した、当サイトにまだ掲載されていない
可能性がある店名リストです（動画タイトルから機械的に抽出しただけの情報で、現存・営業中かは
一切確認されていません。古いものは2020年頃の取材です）:
${videoHints.map((name) => `- ${name}`).join('\n')}
この中から選ぶ場合は、Google検索で「現在も実在し営業中であること」を必ず自分で確認してください。
検索しても確認が取れなかった店名は、unconfirmedHintStores に列挙してください（選ばなかった場合も、
確認を試みて分からなかった店名があれば列挙して構いません）。確認できない店は選ばず、他を探すか
notFound にしてください。`
      : '';

  const target = hintTitle
    ? `今回リサーチしてほしい店舗:「${hintTitle}」${hintGenre ? `（ジャンルの想定: ${hintGenre}）` : ''}
この店舗が新潟県三条市の本寺小路・本町エリアに実在し、除外リストに含まれていないかを確認したうえで調べてください。`
    : `新潟県三条市の「本寺小路」「本町」エリアに実在し、現在も営業している飲食店を1軒、あなた自身の判断で選んでください。
${hintGenre ? `できればジャンルは「${hintGenre}」系を優先的に検討してください（見つからなければ他ジャンルでも構いません）。` : ''}

このリサーチは必ず次の2段階で行ってください。第1段階で見つからなくても、
そこで諦めて notFound にはせず、必ず第2段階まで進めてください。

【第1段階・最優先】次の観点で「新店舗」を探してください:
- ここ1年以内に新規オープンした店
- リニューアルオープン・移転オープンした店
- SNSやグルメサイトで最近「オープンしました」「移転しました」と話題になっている店
見つかればここで確定してよく、第2段階は不要です。

【第2段階・第1段階で見つからなかった場合は必ず実行】
新しさは問わず、本寺小路・本町エリアに実在し現在も営業している飲食店を1軒選んでください
（定番の有名店・老舗・まだ知られていない個人店なども対象。除外リストとの重複さえ避ければよい）。
${videoHintsText}`;

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
- socialLinks: 店舗の公式SNSアカウント。次の条件をすべて満たすものだけを配列に入れる:
  - platform は instagram / facebook / x / line のいずれか
  - url はプロフィールまたはLINE友だち追加画面へのHTTPS完全URL。投稿・検索・共有URLは禁止
  - evidenceUrl は、そのアカウントが当該店舗の公式だと確認できる公式サイトまたは信頼できる店舗情報ページのHTTPS URL
  - 店名・所在地・公式サイトからの直接リンク等で同一店舗だと高い確度で確認できること
  - 表記揺れ、同名店、地域不明など少しでも曖昧なら絶対に推測せず、配列に入れないこと
  - 公式SNSを確認できない場合は空配列
- unconfirmedHintStores: 上記の参考情報リストを提示された場合のみ使用。検索しても現在の
  営業状況を確認できなかった店名の配列（無ければ空配列）

重要な注意点:
- 実在しない店舗を創作しないでください。
- 除外リストの店舗、または本寺小路・本町エリア以外の店舗しか見つからない場合は、
  notFound を true にし、他のフィールドは空文字列（配列は空配列、isNewはfalse）にしてください。
  ただし notFound にする前に、必ず第1段階・第2段階の両方を試したことを確認してください。`;
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
- Instagram、Facebook、X、LINEなどのSNSアカウントやURLを本文・descriptionへ書かないでください。
  socialLinks はAgent 1とAgent 3が管理するFrontmatter専用フィールドです。

description（Frontmatter用の要約）は100字前後で、記事の魅力が一目で伝わるように。`;
}

// ============================================================
// 参考ヒントの読み込み（scripts/match-youtube.ts が書き出す unmatched-videos.json）
// ============================================================

interface UnmatchedVideosFile {
  videos?: Array<{ area?: string; storeManual?: string | null }>;
}

/**
 * scripts/match-youtube.ts が書き出す unmatched-videos.json から、本寺小路エリア
 * （area === 'honjikoji'）かつ storeManual が人手で埋められている店名を集め、
 * すでに掲載済みの店名（excludeTitles）を除いた「未確認の候補ヒント」を返す。
 *
 * 注意: この店名リストは動画タイトルからの機械的な抽出＋人手補完であり、
 * 現在も実在・営業しているかは一切確認されていない（古いものは2020年頃の
 * 取材）。あくまでAgent1が検索の起点にする「ヒント」であり、事実源としては
 * 弱いため、Agent1側に必ず現況確認を求めるプロンプトとセットで使うこと。
 * ファイルが無い・壊れている場合はヒント無し（空配列）で継続する
 * （このパイプライン自体を止める理由にはしない）。
 */
async function loadVideoHints(excludeTitles: string[]): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(UNMATCHED_VIDEOS_PATH, 'utf-8');
  } catch {
    return [];
  }

  try {
    const data = JSON.parse(raw) as UnmatchedVideosFile;
    const videos = Array.isArray(data.videos) ? data.videos : [];
    const excludeSet = new Set(excludeTitles.map(normalizeText));
    const names = new Map<string, string>(); // normalizeText(name) -> 元の表記

    for (const video of videos) {
      if (video.area !== 'honjikoji') continue;
      const name = video.storeManual?.trim();
      if (!name) continue;
      const key = normalizeText(name);
      if (excludeSet.has(key)) continue;
      if (!names.has(key)) names.set(key, name);
    }

    return Array.from(names.values());
  } catch (err) {
    console.warn(
      `[generate-spot] ${path.relative(process.cwd(), UNMATCHED_VIDEOS_PATH)} の解析に失敗しました（参考ヒント無しで続行します）:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

// ============================================================
// Agent 1: Research Agent (Google Search Grounding)
// ============================================================

async function runResearchAgent(
  ai: GoogleGenAI,
  excludeTitles: string[],
  hintTitle?: string,
  hintGenre?: string,
  videoHints: string[] = []
): Promise<ResearchResult> {
  const label = '[Agent1:Research]';
  console.log(`${label} 起動。Google Search Groundingで実在店舗をリサーチ中（新店舗を優先探索）...`);
  if (videoHints.length > 0) {
    console.log(`${label} 参考ヒント（燕三条TV動画由来・未確認）: ${videoHints.length}件`);
  }

  const rawText = await callGroundedJsonAgent(ai, {
    label,
    prompt: buildResearchPrompt(excludeTitles, hintTitle, hintGenre, videoHints),
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
    console.log(
      `${label} 公式SNS候補: ${result.data.socialLinks.length > 0 ? result.data.socialLinks.map((link) => `${link.platform}: ${link.url}`).join(', ') : '(確認できず)'}`
    );
  }

  if (result.data.unconfirmedHintStores.length > 0) {
    console.warn(
      `${label} 参考ヒントのうち営業状況を確認できなかった店: ${result.data.unconfirmedHintStores.join(', ')}`
    );
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

interface QaResult {
  filePath: string;
  hoursDerived: boolean;
  /** hoursDerivedがfalseのときのみ設定される、導出できなかった理由。 */
  hoursReason?: string;
  /**
   * Agent1由来のhoursをPlaces APIの値と照合した結果（検証のみ・値は保存しない）。
   * placeId未解決・GOOGLE_PLACES_API_KEY未設定・hours未導出のいずれかなら
   * checked: false（照合自体を行っていない）。
   */
  hoursVerification: { checked: boolean; hasMismatch: boolean; maxDiffMinutes: number; mismatchedDays: string[] };
}

/** SpotFrontmatterのhoursを、content.config.tsが期待するYAML行に変換する（無ければ空配列）。 */
function buildHoursYamlLines(hours: SpotFrontmatter['hours']): string[] {
  if (!hours) return [];
  const lines: string[] = ['hours:'];
  for (const rule of hours) {
    lines.push(`  - days: [${rule.days.join(', ')}]`);
    lines.push(`    open: ${toYamlString(rule.open)}`);
    lines.push(`    close: ${toYamlString(rule.close)}`);
  }
  return lines;
}

/** Agent 3で検証済みのsocialLinksをFrontmatter用YAMLへ変換する。 */
function buildSocialLinksYamlLines(socialLinks: SpotFrontmatter['socialLinks']): string[] {
  if (!socialLinks || socialLinks.length === 0) return [];
  const lines: string[] = ['socialLinks:'];
  for (const link of socialLinks) {
    lines.push(`  - platform: ${toYamlString(link.platform)}`);
    lines.push(`    url: ${toYamlString(link.url)}`);
  }
  return lines;
}

async function runQaAgent(
  research: ResearchResult,
  writer: WriterResult,
  existingSlugs: string[]
): Promise<QaResult> {
  const label = '[Agent3:QA]';
  console.log(`${label} 起動。Frontmatterスキーマ（Zod）を検証中...`);

  // 店名・住所からPlace IDを解決する（GOOGLE_PLACES_API_KEY未設定・該当なし・
  // APIエラーのいずれでも null。処理は継続し、placeIdは未設定のまま保存する）。
  const resolvedPlace = await resolvePlaceId(research.title, research.address, process.env.GOOGLE_PLACES_API_KEY);
  if (resolvedPlace) {
    console.log(`${label} Place IDを解決しました: ${resolvedPlace.placeId}`);
  } else {
    console.warn(
      `${label} Place IDを解決できませんでした（GOOGLE_PLACES_API_KEY未設定、または該当なし）。詳細ページのライブ営業時間表示は無効のまま保存します。`
    );
  }

  // openHours/regularHolidayから構造化hoursを決定論的に導出する（LLM不使用）。
  // 導出できなければhoursは未設定のまま保存する（誤った営業時間よりは
  // hours欠落＝unknown表示の方が安全という方針。scripts/lib/openHoursParser.ts）。
  const hoursResult = parseOpenHoursToHours(research.openHours, research.regularHoliday);

  // Agent1由来のhoursを、Places APIの値と照合する（検証のみ）。Places API側の
  // 値そのものはfrontmatterにもJob Summaryにも保存しない（Google Maps Platform
  // 利用規約上、opening hoursの永続保存は許可されていないため）。ここで残す
  // のは「差分の有無・大きさ（分）・曜日名」という私たち自身が計算した派生
  // 情報のみで、Google側の実際の時刻文字列は一切含めない
  // （scripts/lib/hoursComparison.ts のコメント参照）。
  let hoursVerification: QaResult['hoursVerification'] = {
    checked: false,
    hasMismatch: false,
    maxDiffMinutes: 0,
    mismatchedDays: [],
  };
  if (resolvedPlace && hoursResult.hours) {
    const googlePeriods = await resolveRegularOpeningHoursPeriods(
      resolvedPlace.placeId,
      process.env.GOOGLE_PLACES_API_KEY
    );
    if (googlePeriods) {
      const comparison = compareHoursWithGoogle(hoursResult.hours, googlePeriods);
      hoursVerification = { checked: true, ...comparison };
      if (comparison.hasMismatch) {
        console.warn(
          `${label} [営業時間検証] Places APIとの照合で差分を検出しました（${comparison.mismatchedDays.join('・')}、最大${comparison.maxDiffMinutes}分程度）。Google Mapsで直接ご確認ください。`
        );
      } else {
        console.log(`${label} [営業時間検証] Places APIと一致しました。`);
      }
    } else {
      console.warn(`${label} [営業時間検証] Places APIから営業時間を取得できず、照合をスキップしました。`);
    }
  }

  // regularHolidayに「不定休」を含む店は isIrregular: true を明示的に立てる。
  // hoursは（不定休のため）通常はundefinedのままだが、サイト内の営業中
  // カウント・提灯表示・路地マップの点灯に含めたい場合は、bar-keywest.mdの
  // ように運営者が手動でhoursを追加できる（isIrregular: trueとhoursの併用は
  // 意図的な例外として許容。詳細はcontent.config.tsのコメント参照）。
  const isIrregular = isIrregularHoliday(research.regularHoliday);
  // budgetから予算の下限・上限を決定論的に導出する（LLM不使用）。
  // 抽出できなければundefinedのまま保存する（scripts/lib/budgetParser.ts）。
  const budgetRange = parseBudgetRange(research.budget);
  // Agent 1がGroundingで収集したSNS候補を、許可ドメイン・プロフィールURL形式・
  // HTTPS必須の決定論的ルールで検証する。拒否された候補は保存しない。
  const socialLinkResult = validateResearchedSocialLinks(research.socialLinks);
  for (const reason of socialLinkResult.rejected) {
    console.warn(`${label} [SNS検証] 不採用: ${reason}`);
  }

  const candidate: Record<string, unknown> = {
    title: research.title,
    genre: research.genre,
    address: research.address,
    mapQuery: `${research.title} 三条市`,
    placeId: resolvedPlace?.placeId,
    budget: research.budget,
    budgetMin: budgetRange.min,
    budgetMax: budgetRange.max,
    openHours: research.openHours,
    regularHoliday: research.regularHoliday,
    vibes: research.vibes,
    isNew: research.isNew,
    hours: hoursResult.hours,
    isIrregular: isIrregular || undefined,
    socialLinks: socialLinkResult.accepted.length > 0 ? socialLinkResult.accepted : undefined,
    description: writer.description,
    pubDate: todayInTokyo(),
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

  if (fm.hours) {
    console.log(`${label} 営業時間(hours)を自動導出しました: ${JSON.stringify(fm.hours)}`);
  } else {
    console.warn(
      `${label} 営業時間(hours)を自動導出できませんでした（${hoursResult.reason}）。hoursは未設定（サイト上はunknown表示）のまま保存します。`
    );
  }
  if (fm.isIrregular) {
    console.log(`${label} 不定休と判定したため isIrregular: true を設定しました。`);
  }
  if (fm.socialLinks?.length) {
    console.log(`${label} 公式SNSを${fm.socialLinks.length}件採用しました。`);
  } else {
    console.log(`${label} 公式性を確認できたSNSはないため、socialLinksを省略します。`);
  }

  if (fm.budgetMin === undefined && fm.budgetMax === undefined) {
    console.warn(
      `${label} budget "${research.budget}" から予算の数値を抽出できませんでした。budgetMin/budgetMaxは未設定のまま保存します。`
    );
  } else {
    console.log(`${label} 予算(budgetMin/budgetMax)を自動導出しました: min=${fm.budgetMin ?? '不明'}, max=${fm.budgetMax ?? '不明'}`);
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
    ...(fm.placeId ? [`placeId: ${toYamlString(fm.placeId)}`] : []),
    `budget: ${toYamlString(fm.budget)}`,
    ...(fm.budgetMin !== undefined ? [`budgetMin: ${fm.budgetMin}`] : []),
    ...(fm.budgetMax !== undefined ? [`budgetMax: ${fm.budgetMax}`] : []),
    `openHours: ${toYamlString(fm.openHours)}`,
    `regularHoliday: ${toYamlString(fm.regularHoliday)}`,
    ...(fm.isIrregular ? [`isIrregular: ${fm.isIrregular}`] : []),
    ...buildHoursYamlLines(fm.hours),
    'vibes:',
    ...fm.vibes.map((vibe) => `  - ${toYamlString(vibe)}`),
    `isNew: ${fm.isNew}`,
    ...buildSocialLinksYamlLines(fm.socialLinks),
    `description: ${toYamlString(fm.description)}`,
    `pubDate: ${fm.pubDate}`,
    '---',
    '',
    '',
  ].join('\n');

  const filePath = path.join(SPOTS_DIR, `${slug}.md`);
  await writeFile(filePath, frontmatter + writer.body.trim() + '\n', 'utf-8');

  console.log(`${label} 完了。保存しました: ${path.relative(process.cwd(), filePath)}`);
  return { filePath, hoursDerived: Boolean(fm.hours), hoursReason: hoursResult.reason, hoursVerification };
}

// ============================================================
// Agent 4（非LLM・決定論的）: 公開お知らせの自動生成
//
// 店舗記事の保存に成功した直後、対応する「〇〇の紹介記事を公開しました」
// ニュースを src/content/news/{spotSlug}-published.md として自動生成する。
// LLMは使わない（文面をLLMに書かせると事実誤認のリスクが増え、API消費も
// 増えるため）。Agent1/Agent2がすでに調べた情報（店名・ジャンル・
// description）だけをテンプレートに流し込んで組み立てる、純粋な決定論的
// 処理。GEMINI_API_KEYが無くても動く（--backfill-announcements用）。
//
// 失敗しても店舗記事の保存自体は成功として扱う（お知らせは副次的な
// 成果物であり、これで全体を失敗にはしない）。そのため、この関数は
// 例外を投げず、常にstatusつきの結果オブジェクトを返す。
// ============================================================

interface AnnouncementSource {
  slug: string;
  title: string;
  genre: string;
  description: string;
}

type AnnouncementResult =
  | { status: 'created'; detail: string }
  | { status: 'skipped'; detail: string }
  | { status: 'error'; detail: string };

function ensureTrailingPunctuation(text: string): string {
  const trimmed = text.trim();
  return /[。！？]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function announcementSummaryLine(result: AnnouncementResult): string {
  switch (result.status) {
    case 'created':
      return `お知らせ: 公開しました（${result.detail}）`;
    case 'skipped':
      return `お知らせ: スキップしました（${result.detail}）`;
    case 'error':
      return `お知らせ: 生成に失敗しました（${result.detail}）`;
  }
}

async function runAnnouncementAgent(spot: AnnouncementSource): Promise<AnnouncementResult> {
  const label = '[Agent4:Announcement]';
  const newsSlug = `${spot.slug}-published`;
  const filePath = path.join(NEWS_DIR, `${newsSlug}.md`);

  try {
    const alreadyExists = await access(filePath).then(
      () => true,
      () => false
    );
    if (alreadyExists) {
      console.log(`${label} news/${newsSlug}.md は既に存在するためスキップします。`);
      return { status: 'skipped', detail: `既に存在します: news/${newsSlug}.md` };
    }

    // research/writerが既に調べた事実（店名・ジャンル・description）だけを
    // 使い、新しい事実は作らない。descriptionはAgent2が書いた「魅力的な
    // 要約（100字前後）」の流用で、新規のLLM呼び出しは行わない。
    const desc = ensureTrailingPunctuation(spot.description);
    const title = `「${spot.title}」の紹介記事を公開しました`;
    const summary = `本寺小路の${spot.genre}「${spot.title}」の紹介記事を公開しました。${desc}`;
    const body =
      `本寺小路の${spot.genre}「${spot.title}」の紹介記事を公開しました。${desc}\n\n` +
      `詳しくは店舗ページをご覧ください。`;

    const candidate: Record<string, unknown> = {
      title,
      pubDate: todayInTokyo(),
      category: 'NEW SPOT',
      summary,
      relatedSpotSlug: spot.slug,
    };

    const result = newsFrontmatterSchema.safeParse(candidate);
    if (!result.success) {
      logZodIssues(result, label);
      return { status: 'error', detail: 'newsFrontmatterSchemaの検証に失敗しました。' };
    }

    // 構造要件チェック（テンプレートは固定文言なので、ここが鳴るのは
    // 店舗のdescriptionが極端に長い等、テンプレート側の想定漏れを意味する。
    // LLM出力と同じく非ブロッキングでwarnのみ、保存は継続する）。
    const structure = analyzeArticleStructure(body);
    const structureWarnings = checkArticleStructure(structure);
    for (const warning of structureWarnings) {
      console.warn(`${label} [構造チェック] ${warning}`);
    }

    const frontmatter = buildNewsFrontmatterBlock(result.data);
    await mkdir(NEWS_DIR, { recursive: true });
    await writeFile(filePath, frontmatter + body + '\n', 'utf-8');

    console.log(`${label} 完了。保存しました: ${path.relative(process.cwd(), filePath)}`);
    return { status: 'created', detail: `news/${newsSlug}.md` };
  } catch (err) {
    console.error(
      `${label} お知らせ生成に失敗しました（店舗記事の保存自体は成功として扱います）:`,
      err instanceof Error ? err.message : err
    );
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// --backfill-announcements: 既存の店舗記事のうち、公開お知らせが
// まだ無いものだけを遡って生成する（冪等・GEMINI_API_KEY不要）。
// ============================================================

async function runBackfillAnnouncements(): Promise<void> {
  console.log('============================================================');
  console.log(' 本寺小路ガイド 公開お知らせ 遡及生成（--backfill-announcements）');
  console.log('============================================================');

  await mkdir(SPOTS_DIR, { recursive: true });
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const results: Array<{ slug: string; result: AnnouncementResult }> = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);
    if (!frontmatter) {
      console.warn(`[backfill] ${file} のfrontmatterを読み取れなかったためスキップします。`);
      continue;
    }

    const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
    const genre = typeof frontmatter.genre === 'string' ? frontmatter.genre : '';
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
    if (!title || !description) {
      console.warn(`[backfill] ${file} は title/description が不足しているためスキップします。`);
      continue;
    }

    const result = await runAnnouncementAgent({ slug, title, genre, description });
    results.push({ slug, result });
  }

  const created = results.filter((r) => r.result.status === 'created');
  const skipped = results.filter((r) => r.result.status === 'skipped');
  const errored = results.filter((r) => r.result.status === 'error');

  console.log('\n============================================================');
  console.log(
    ` 完了: 対象${results.length}件中、生成${created.length}件・スキップ${skipped.length}件・失敗${errored.length}件`
  );
  for (const { slug, result } of results) {
    console.log(`  - ${slug}: ${announcementSummaryLine(result)}`);
  }
  console.log('============================================================');

  await appendStepSummary(
    [
      '## 🏮 本寺小路ガイド 公開お知らせ 遡及生成（backfill）',
      '',
      `対象${results.length}件中、生成${created.length}件・スキップ${skipped.length}件・失敗${errored.length}件`,
      '',
      ...results.map(({ slug, result }) => `- ${slug}: ${announcementSummaryLine(result)}`),
    ].join('\n')
  );
}

// ============================================================
// --backfill-hours: 既存の店舗記事のうち、hours（構造化営業時間）が
// まだ無いものだけを openHours/regularHoliday から遡って導出する
// （冪等・GEMINI_API_KEY不要）。
//
// 既存のhoursは絶対に上書きしない（Bar Keywest等、手動で「不定休だが
// 便宜上毎日営業として登録」しているデータを壊さないため）。frontmatter
// 全体をパース→再シリアライズする方式は、js-yamlの出力フォーマットが
// 手書きの元データと微妙に異なり得て意図しない差分を生むため採らず、
// 生のテキストに対して「regularHoliday行の直後にhours:ブロックを挿入する」
// という最小限の文字列操作のみを行う（他のフィールド・本文には一切触れない）。
// ============================================================

type HoursBackfillStatus = 'derived' | 'skipped-existing' | 'not-derived';

interface HoursBackfillResult {
  slug: string;
  status: HoursBackfillStatus;
  detail?: string;
}

function hoursBackfillSummaryLine(result: HoursBackfillResult): string {
  switch (result.status) {
    case 'derived':
      return `導出できました（${result.detail}）`;
    case 'skipped-existing':
      return '既にhoursがあるためスキップしました';
    case 'not-derived':
      return `導出できませんでした（${result.detail}）`;
  }
}

async function runBackfillHours(): Promise<void> {
  console.log('============================================================');
  console.log(' 本寺小路ガイド 営業時間(hours) 遡及生成（--backfill-hours）');
  console.log('============================================================');

  await mkdir(SPOTS_DIR, { recursive: true });
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const results: HoursBackfillResult[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const filePath = path.join(SPOTS_DIR, file);
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);

    if (!frontmatter) {
      results.push({ slug, status: 'not-derived', detail: 'frontmatterを読み取れませんでした' });
      continue;
    }

    if (frontmatter.hours !== undefined) {
      results.push({ slug, status: 'skipped-existing' });
      continue;
    }

    const openHours = typeof frontmatter.openHours === 'string' ? frontmatter.openHours : '';
    const regularHoliday = typeof frontmatter.regularHoliday === 'string' ? frontmatter.regularHoliday : '';
    if (!openHours || !regularHoliday) {
      results.push({ slug, status: 'not-derived', detail: 'openHours/regularHolidayを読み取れませんでした' });
      continue;
    }

    const { hours, reason } = parseOpenHoursToHours(openHours, regularHoliday);
    if (!hours) {
      results.push({ slug, status: 'not-derived', detail: reason });
      continue;
    }

    const raw = await readFile(filePath, 'utf-8');
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    const regularHolidayMatch = frontmatterMatch
      ? /^regularHoliday:.*$/m.exec(frontmatterMatch[1])
      : null;
    if (!frontmatterMatch || !regularHolidayMatch) {
      results.push({
        slug,
        status: 'not-derived',
        detail: 'regularHoliday行が見つからず、安全に挿入できませんでした',
      });
      continue;
    }

    const frontmatterContentStart = frontmatterMatch.index + '---\n'.length;
    const insertAt = frontmatterContentStart + regularHolidayMatch.index + regularHolidayMatch[0].length;
    const hoursBlock = buildHoursYamlLines(hours).join('\n');
    const newRaw = `${raw.slice(0, insertAt)}\n${hoursBlock}${raw.slice(insertAt)}`;
    await writeFile(filePath, newRaw, 'utf-8');

    results.push({ slug, status: 'derived', detail: JSON.stringify(hours) });
  }

  const derived = results.filter((r) => r.status === 'derived');
  const skippedExisting = results.filter((r) => r.status === 'skipped-existing');
  const notDerived = results.filter((r) => r.status === 'not-derived');

  console.log('\n============================================================');
  console.log(
    ` 完了: 対象${results.length}件中、導出${derived.length}件・既存スキップ${skippedExisting.length}件・導出不可${notDerived.length}件`
  );
  for (const result of results) {
    console.log(`  - ${result.slug}: ${hoursBackfillSummaryLine(result)}`);
  }
  console.log('============================================================');

  await appendStepSummary(
    [
      '## 🕐 本寺小路ガイド 営業時間(hours) 遡及生成（backfill）',
      '',
      `対象${results.length}件中、導出${derived.length}件・既存スキップ${skippedExisting.length}件・導出不可${notDerived.length}件`,
      '',
      ...results.map((result) => `- ${result.slug}: ${hoursBackfillSummaryLine(result)}`),
    ].join('\n')
  );
}

// ============================================================
// --backfill-budget: 既存の店舗記事のうち、budgetMin/budgetMaxが
// まだ無いものだけを budget 文字列から遡って導出する
// （冪等・GEMINI_API_KEY不要）。budgetMin/budgetMaxはそれぞれ独立に
// 判定し、既にある方だけを絶対に上書きしない（例: budgetMaxだけ既存の
// 店には、budgetMinだけを追記する）。
// ============================================================

type BudgetBackfillStatus = 'derived' | 'skipped-existing' | 'not-derived';

interface BudgetBackfillResult {
  slug: string;
  status: BudgetBackfillStatus;
  detail?: string;
}

function budgetBackfillSummaryLine(result: BudgetBackfillResult): string {
  switch (result.status) {
    case 'derived':
      return `導出できました（${result.detail}）`;
    case 'skipped-existing':
      return '既にbudgetMin/budgetMaxがあるためスキップしました';
    case 'not-derived':
      return `導出できませんでした（${result.detail}）`;
  }
}

/**
 * budgetMin/budgetMaxのうち新たに追加する行を、frontmatterの生テキストに
 * 挿入する。既存フィールドの位置関係（budget → budgetMin → budgetMax）を
 * 保つため、挿入位置を状況に応じて選ぶ:
 * - budgetMaxが既存でbudgetMinだけ追加する場合 → budgetMax行の直前
 * - budgetMinが既存でbudgetMaxだけ追加する場合 → budgetMin行の直後
 * - どちらも新規追加する場合 → budget行の直後
 * frontmatter全体をjs-yamlで再シリアライズする方式は手書きデータの
 * フォーマットを崩すリスクがあるため採らない（--backfill-hoursと同じ方針）。
 */
function insertBudgetFields(
  raw: string,
  toInsert: { budgetMin?: number; budgetMax?: number }
): string | null {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!frontmatterMatch) return null;
  const fmBlock = frontmatterMatch[1];
  const fmStart = frontmatterMatch.index + '---\n'.length;

  const budgetLineMatch = /^budget:.*$/m.exec(fmBlock);
  if (!budgetLineMatch) return null;
  const budgetMinLineMatch = /^budgetMin:.*$/m.exec(fmBlock);
  const budgetMaxLineMatch = /^budgetMax:.*$/m.exec(fmBlock);

  const lines: string[] = [];
  if (toInsert.budgetMin !== undefined) lines.push(`budgetMin: ${toInsert.budgetMin}`);
  if (toInsert.budgetMax !== undefined) lines.push(`budgetMax: ${toInsert.budgetMax}`);
  if (lines.length === 0) return raw;

  let insertAt: number;
  if (toInsert.budgetMax !== undefined && toInsert.budgetMin === undefined && budgetMinLineMatch) {
    insertAt = fmStart + budgetMinLineMatch.index + budgetMinLineMatch[0].length + 1;
  } else if (toInsert.budgetMin !== undefined && toInsert.budgetMax === undefined && budgetMaxLineMatch) {
    insertAt = fmStart + budgetMaxLineMatch.index;
  } else {
    insertAt = fmStart + budgetLineMatch.index + budgetLineMatch[0].length + 1;
  }

  const insertText = lines.map((l) => `${l}\n`).join('');
  return raw.slice(0, insertAt) + insertText + raw.slice(insertAt);
}

async function runBackfillBudget(): Promise<void> {
  console.log('============================================================');
  console.log(' 本寺小路ガイド 予算(budgetMin/budgetMax) 遡及生成（--backfill-budget）');
  console.log('============================================================');

  await mkdir(SPOTS_DIR, { recursive: true });
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const results: BudgetBackfillResult[] = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const filePath = path.join(SPOTS_DIR, file);
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);

    if (!frontmatter) {
      results.push({ slug, status: 'not-derived', detail: 'frontmatterを読み取れませんでした' });
      continue;
    }

    const needsMin = frontmatter.budgetMin === undefined;
    const needsMax = frontmatter.budgetMax === undefined;
    if (!needsMin && !needsMax) {
      results.push({ slug, status: 'skipped-existing' });
      continue;
    }

    const budget = typeof frontmatter.budget === 'string' ? frontmatter.budget : '';
    if (!budget) {
      results.push({ slug, status: 'not-derived', detail: 'budgetを読み取れませんでした' });
      continue;
    }

    const parsed = parseBudgetRange(budget);
    const toInsert: { budgetMin?: number; budgetMax?: number } = {};
    if (needsMin && parsed.min !== undefined) toInsert.budgetMin = parsed.min;
    if (needsMax && parsed.max !== undefined) toInsert.budgetMax = parsed.max;

    if (toInsert.budgetMin === undefined && toInsert.budgetMax === undefined) {
      results.push({ slug, status: 'not-derived', detail: `budget "${budget}" から数値を抽出できませんでした` });
      continue;
    }

    const raw = await readFile(filePath, 'utf-8');
    const newRaw = insertBudgetFields(raw, toInsert);
    if (newRaw === null) {
      results.push({
        slug,
        status: 'not-derived',
        detail: 'budget行が見つからず、安全に挿入できませんでした',
      });
      continue;
    }
    await writeFile(filePath, newRaw, 'utf-8');

    const parts: string[] = [];
    if (toInsert.budgetMin !== undefined) parts.push(`budgetMin=${toInsert.budgetMin}`);
    if (toInsert.budgetMax !== undefined) parts.push(`budgetMax=${toInsert.budgetMax}`);
    results.push({ slug, status: 'derived', detail: parts.join(', ') });
  }

  const derived = results.filter((r) => r.status === 'derived');
  const skippedExisting = results.filter((r) => r.status === 'skipped-existing');
  const notDerived = results.filter((r) => r.status === 'not-derived');

  console.log('\n============================================================');
  console.log(
    ` 完了: 対象${results.length}件中、導出${derived.length}件・既存スキップ${skippedExisting.length}件・導出不可${notDerived.length}件`
  );
  for (const result of results) {
    console.log(`  - ${result.slug}: ${budgetBackfillSummaryLine(result)}`);
  }
  console.log('============================================================');

  await appendStepSummary(
    [
      '## 💰 本寺小路ガイド 予算(budgetMin/budgetMax) 遡及生成（backfill）',
      '',
      `対象${results.length}件中、導出${derived.length}件・既存スキップ${skippedExisting.length}件・導出不可${notDerived.length}件`,
      '',
      ...results.map((result) => `- ${result.slug}: ${budgetBackfillSummaryLine(result)}`),
    ].join('\n')
  );
}

// ============================================================
// --backfill-place-id: 既存の店舗記事のうち、placeIdがまだ無いものだけを
// 店名・住所からGoogle Places API (New) のText Searchで解決する
// （scripts/lib/googlePlaces.ts）。
//
// 既存のplaceIdは絶対に上書きしない。書き込み前に必ず「slug・店名・住所→
// 解決したPlace ID」の対応表を提示し、標準入力でユーザーの確認（y）を
// 取ってから書き込む（対話専用。確認プロンプトがあるためCI等の非対話環境
// では使えない）。
// ============================================================

type PlaceIdBackfillStatus = 'resolved' | 'skipped-existing' | 'not-resolved';
type PlaceIdSource = 'api' | 'manual';

interface PlaceIdBackfillResult {
  slug: string;
  title: string;
  address: string;
  status: PlaceIdBackfillStatus;
  placeId?: string;
  source?: PlaceIdSource;
  /** 手動指定が既存のplaceIdを上書きする場合のみ設定する（対応表での明示用）。 */
  previousPlaceId?: string;
}

/**
 * コマンドライン引数から `slug=placeId` 形式の手動指定を読み取る
 * （例: `--backfill-place-id bar-keywest=ChIJ...`）。該当しない引数は無視する。
 * 手動指定したslugはText Search自体を呼ばない（APIクォータを消費しない）。
 */
function parseManualPlaceIdOverrides(args: string[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const arg of args) {
    const match = /^([^=\s]+)=([A-Za-z0-9_-]{10,255})$/.exec(arg);
    if (!match) continue;
    overrides.set(match[1], match[2]);
  }
  return overrides;
}

/**
 * placeId行をfrontmatterに書き込む。既に `placeId:` 行があれば置き換え
 * （手動指定での上書き用）、無ければmapQuery行の直後に挿入する。
 * 他フィールド・本文には一切触れない。
 */
function upsertPlaceIdField(raw: string, placeId: string): string | null {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!frontmatterMatch) return null;
  const fmBlock = frontmatterMatch[1];
  const fmStart = frontmatterMatch.index + '---\n'.length;

  const existingLineMatch = /^placeId:.*$/m.exec(fmBlock);
  if (existingLineMatch) {
    const start = fmStart + existingLineMatch.index;
    const end = start + existingLineMatch[0].length;
    return raw.slice(0, start) + `placeId: ${toYamlString(placeId)}` + raw.slice(end);
  }

  const mapQueryLineMatch = /^mapQuery:.*$/m.exec(fmBlock);
  if (!mapQueryLineMatch) return null;

  const insertAt = fmStart + mapQueryLineMatch.index + mapQueryLineMatch[0].length + 1;
  const insertText = `placeId: ${toYamlString(placeId)}\n`;
  return raw.slice(0, insertAt) + insertText + raw.slice(insertAt);
}

async function runBackfillPlaceId(manualOverrides: Map<string, string>): Promise<void> {
  console.log('============================================================');
  console.log(' 本寺小路ガイド Place ID 遡及生成（--backfill-place-id）');
  console.log('============================================================');
  if (manualOverrides.size > 0) {
    console.log(
      `[generate-spot] 手動指定: ${Array.from(manualOverrides.entries())
        .map(([slug, id]) => `${slug}=${id}`)
        .join(', ')}`
    );
  }

  // 手動指定のみで全件まかなえるなら、APIキー未設定でも動作してよい
  // （Text Search自体を呼ばないため）。
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn(
      '[generate-spot] GOOGLE_PLACES_API_KEY が設定されていません。手動指定（slug=placeId）以外はスキップされます。'
    );
  } else {
    console.log(
      `[generate-spot] GOOGLE_PLACES_API_KEY: 先頭6文字 "${apiKey.slice(0, 6)}"・全体${apiKey.length}文字を読み込みました。`
    );
  }

  await mkdir(SPOTS_DIR, { recursive: true });
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const results: PlaceIdBackfillResult[] = [];
  const usedOverrideSlugs = new Set<string>();

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const frontmatter = await readFrontmatter(SPOTS_DIR, slug);

    if (!frontmatter) {
      results.push({ slug, title: slug, address: '', status: 'not-resolved' });
      continue;
    }

    const title = typeof frontmatter.title === 'string' ? frontmatter.title : slug;
    const address = typeof frontmatter.address === 'string' ? frontmatter.address : '';
    const existingPlaceId =
      typeof frontmatter.placeId === 'string' && frontmatter.placeId.length > 0 ? frontmatter.placeId : undefined;

    const manualPlaceId = manualOverrides.get(slug);
    if (manualPlaceId) {
      usedOverrideSlugs.add(slug);
      if (manualPlaceId === existingPlaceId) {
        results.push({ slug, title, address, status: 'skipped-existing', placeId: existingPlaceId });
        continue;
      }
      results.push({
        slug,
        title,
        address,
        status: 'resolved',
        placeId: manualPlaceId,
        source: 'manual',
        previousPlaceId: existingPlaceId,
      });
      continue;
    }

    if (existingPlaceId) {
      results.push({ slug, title, address, status: 'skipped-existing', placeId: existingPlaceId });
      continue;
    }

    if (!address || !apiKey) {
      results.push({ slug, title, address, status: 'not-resolved' });
      continue;
    }

    const resolved = await resolvePlaceId(title, address, apiKey, { verbose: true });
    if (!resolved) {
      results.push({ slug, title, address, status: 'not-resolved' });
      continue;
    }

    results.push({ slug, title, address, status: 'resolved', placeId: resolved.placeId, source: 'api' });
  }

  for (const [slug] of manualOverrides) {
    if (!usedOverrideSlugs.has(slug)) {
      console.warn(`[generate-spot] 手動指定 "${slug}" に該当する記事が見つかりませんでした。無視します。`);
    }
  }

  const resolvedResults = results.filter(
    (r): r is PlaceIdBackfillResult & { placeId: string } => r.status === 'resolved'
  );
  const skippedExisting = results.filter((r) => r.status === 'skipped-existing');
  const notResolved = results.filter((r) => r.status === 'not-resolved');

  console.log('\n============================================================');
  console.log(
    ` 解決結果: 対象${results.length}件中、新規解決${resolvedResults.length}件・既存スキップ${skippedExisting.length}件・解決不可${notResolved.length}件`
  );
  console.log('============================================================');

  if (resolvedResults.length === 0) {
    console.log('[generate-spot] 新規に書き込むPlace IDはありません。終了します。');
    return;
  }

  console.log('\n以下の対応表でfrontmatterに書き込みます（店名・住所 → 解決したPlace ID）:\n');
  for (const r of resolvedResults) {
    const sourceLabel = r.source === 'manual' ? '手動指定' : 'Text Search';
    const overwriteLabel = r.previousPlaceId ? `\n      現在値: ${r.previousPlaceId} → 上書き` : '';
    console.log(
      `  - ${r.slug}\n      店名: ${r.title}\n      住所: ${r.address}\n      Place ID: ${r.placeId}（${sourceLabel}）${overwriteLabel}`
    );
  }
  if (notResolved.length > 0) {
    console.log(`\n解決できなかった店舗（変更なし）: ${notResolved.map((r) => r.slug).join(', ')}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n上記 ${resolvedResults.length} 件をfrontmatterに書き込みますか？ (y/N): `);
  rl.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('[generate-spot] 中断しました。何も書き込んでいません。');
    return;
  }

  let written = 0;
  for (const r of resolvedResults) {
    const filePath = path.join(SPOTS_DIR, `${r.slug}.md`);
    const raw = await readFile(filePath, 'utf-8');
    const newRaw = upsertPlaceIdField(raw, r.placeId);
    if (newRaw === null) {
      console.warn(`[generate-spot] ${r.slug}: mapQuery行が見つからず、安全に挿入できませんでした。スキップします。`);
      continue;
    }
    await writeFile(filePath, newRaw, 'utf-8');
    written += 1;
    console.log(`[generate-spot] ${r.slug}: placeId: ${r.placeId} を書き込みました。`);
  }

  console.log(`\n[generate-spot] 完了: ${written}件のplaceIdを書き込みました。`);
}

// ============================================================
// オーケストレーター
// ============================================================

async function main() {
  // 遡及生成モード: LLM/GEMINI_API_KEYを使わず、既存の店舗記事のうち
  // 公開お知らせが無いものだけを生成して終了する。
  if (process.argv[2] === '--backfill-announcements') {
    await runBackfillAnnouncements();
    return;
  }

  // 遡及生成モード: LLM/GEMINI_API_KEYを使わず、既存の店舗記事のうち
  // hoursが無いものだけを openHours/regularHoliday から導出して終了する。
  // 既存のhoursは絶対に上書きしない。
  if (process.argv[2] === '--backfill-hours') {
    await runBackfillHours();
    return;
  }

  // 遡及生成モード: LLM/GEMINI_API_KEYを使わず、既存の店舗記事のうち
  // budgetMin/budgetMaxが無いものだけを budget から導出して終了する。
  // 既存のbudgetMin/budgetMaxは絶対に上書きしない。
  if (process.argv[2] === '--backfill-budget') {
    await runBackfillBudget();
    return;
  }

  // 遡及生成モード: GEMINI_API_KEY不要。既存の店舗記事のうちplaceIdが無い
  // ものだけをText Search（GOOGLE_PLACES_API_KEY必須）で解決する。書き込み前に
  // 対応表を提示し、標準入力で確認を取る（対話専用）。Text Search経由では
  // 既存のplaceIdを上書きしない。
  // `slug=placeId` 形式の追加引数（例: bar-keywest=ChIJ...）を渡すと、その
  // slugだけはAPIを呼ばず指定値を使う（既存placeIdがあっても上書き対象になる。
  // GOOGLE_PLACES_API_KEY未設定でも手動指定分だけは動作する）。
  if (process.argv[2] === '--backfill-place-id') {
    await runBackfillPlaceId(parseManualPlaceIdOverrides(process.argv.slice(3)));
    return;
  }

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

  const outcomes: AttemptOutcome[] = [];
  // Agent1が検索しても現況を確認できなかった参考ヒント店名（全試行分の集計）。
  // 手動確認して不要ならunmatched-videos.jsonから外す判断材料として、
  // 試行の成否によらずJob Summaryに必ず出す。
  const unconfirmedHintStores = new Set<string>();
  const unconfirmedHintLine = (): string | null =>
    unconfirmedHintStores.size > 0
      ? `- 参考ヒントのうち営業状況を確認できなかった店（要手動確認）: ${Array.from(unconfirmedHintStores).join('、')}`
      : null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n----- 試行 ${attempt}/${MAX_ATTEMPTS} -----`);

    try {
      const { titles: excludeTitles, slugs: existingSlugs } = await getExistingEntries(SPOTS_DIR);
      console.log(
        `[generate-spot] 既存記事: ${existingSlugs.length}件（除外対象タイトル: ${excludeTitles.length}件）`
      );

      // 指定店舗モード（hintTitle指定時）は探索そのものをしないため、
      // 参考ヒントは自律選定モードのときだけ渡す。
      const videoHints = hintTitle ? [] : await loadVideoHints(excludeTitles);

      const preferredGenre = hintGenre ?? (hintTitle ? undefined : pickRandom(GENRES));
      const research = await runResearchAgent(ai, excludeTitles, hintTitle, preferredGenre, videoHints);
      for (const name of research.unconfirmedHintStores) unconfirmedHintStores.add(name);

      if (research.notFound) {
        outcomes.push('notFound');
        console.warn('[generate-spot] 候補が見つからなかったため、リトライします。');
        continue;
      }

      const isDuplicate = excludeTitles.some(
        (title) => normalizeText(title) === normalizeText(research.title)
      );
      if (isDuplicate) {
        outcomes.push('duplicate');
        console.warn(`[generate-spot] 「${research.title}」はすでに掲載済みでした。リトライします。`);
        continue;
      }

      const writer = await runWriterAgent(ai, research);
      const { filePath, hoursDerived, hoursReason, hoursVerification } = await runQaAgent(
        research,
        writer,
        existingSlugs
      );
      outcomes.push('success');

      // 店舗記事の保存が成功した直後に、対応する公開お知らせを生成する。
      // runAnnouncementAgentは例外を投げないため、失敗しても店舗記事の
      // 保存自体は成功のまま処理を続けられる。
      const spotSlug = path.basename(filePath, '.md');
      const announcement = await runAnnouncementAgent({
        slug: spotSlug,
        title: research.title,
        genre: research.genre,
        description: writer.description,
      });

      // Instagram投稿素材（文面・正方形画像・Slack通知）。店舗記事のみが対象
      // （announcement=公開お知らせは同じ店を扱うため、Instagramへ2回投稿する
      // ことはなく対象外。ユーザーとの合意事項）。例外を投げないため、失敗しても
      // 店舗記事の保存自体は成功のまま処理を続けられる。
      const instagramMaterial = await runInstagramMaterialAgent(ai, {
        type: 'spot',
        contentLabel: '店舗記事',
        slug: spotSlug,
        title: research.title,
        summary: writer.description,
        body: writer.body,
        imageLabel: research.genre ? `${research.genre} ／ 本寺小路` : '本寺小路',
        urlPath: `/spots/${spotSlug}/`,
        projectRoot: PROJECT_ROOT,
      });

      const hoursLine = hoursDerived
        ? '営業時間(hours): 自動導出しました'
        : `営業時間(hours): 自動導出できませんでした（${hoursReason}）`;

      // Places APIとの照合結果（検証のみ）。値そのもの（Google側の実際の時刻）は
      // 一切含めない。差分の有無・大きさ・曜日名という派生情報のみを出す
      // （scripts/lib/hoursComparison.ts のコメント参照）。
      const hoursVerificationLine = !hoursVerification.checked
        ? null
        : hoursVerification.hasMismatch
          ? `⚠️ 営業時間の検証: Places APIとの照合で差分を検出しました（${hoursVerification.mismatchedDays.join('・')}、最大${hoursVerification.maxDiffMinutes}分程度）。Google Mapsで直接ご確認のうえ、必要なら手動で修正してください。`
          : '営業時間の検証: Places APIと一致しました。';

      console.log('\n============================================================');
      console.log(
        ` 完了: 「${research.title}」（${research.genre}）${research.isNew ? '[NEW] ' : ''}を保存しました。`
      );
      console.log(` -> ${path.relative(process.cwd(), filePath)}`);
      console.log(` ${announcementSummaryLine(announcement)}`);
      console.log(` ${hoursLine}`);
      if (hoursVerificationLine) console.log(` ${hoursVerificationLine}`);
      console.log('============================================================');

      await appendStepSummary(
        [
          '## 🏮 本寺小路ガイド 自動記事生成（spot）',
          '',
          `「${research.title}」（${research.genre}）${research.isNew ? ' [NEW]' : ''} を保存しました。`,
          '',
          `- ファイル: \`${path.relative(process.cwd(), filePath)}\``,
          `- ${announcementSummaryLine(announcement)}`,
          `- ${hoursLine}`,
          hoursVerificationLine ? `- ${hoursVerificationLine}` : null,
          instagramMaterial.warning ? `- ⚠️ ${instagramMaterial.warning}` : null,
          `- 試行内訳: ${summarizeOutcomes(outcomes, OUTCOME_LABELS)}`,
          unconfirmedHintLine(),
        ]
          .filter((line): line is string => line !== null)
          .join('\n')
      );
      return;
    } catch (err) {
      if (err instanceof FatalPipelineError) {
        outcomes.push('error');
        console.error(`\n[generate-spot] 致命的エラーのため処理を安全に停止します: ${err.message}`);
        process.exitCode = 1;
        await appendStepSummary(
          [
            '## 🏮 本寺小路ガイド 自動記事生成（spot）',
            '',
            `❌ 致命的エラーのため処理を停止しました: ${err.message}`,
            '',
            `- 試行内訳: ${summarizeOutcomes(outcomes, OUTCOME_LABELS)}`,
            unconfirmedHintLine(),
          ]
            .filter((line): line is string => line !== null)
            .join('\n')
        );
        return;
      }

      outcomes.push('error');
      console.error(
        `[generate-spot] 試行 ${attempt}/${MAX_ATTEMPTS} でエラーが発生しました:`,
        err instanceof Error ? err.message : err
      );

      if (attempt === MAX_ATTEMPTS) {
        await appendStepSummary(
          [
            '## 🏮 本寺小路ガイド 自動記事生成（spot）',
            '',
            `❌ ${MAX_ATTEMPTS}回試行しましたが、記事の生成に失敗しました。`,
            '',
            `- 試行内訳: ${summarizeOutcomes(outcomes, OUTCOME_LABELS)}`,
            unconfirmedHintLine(),
          ]
            .filter((line): line is string => line !== null)
            .join('\n')
        );
        throw new Error(`${MAX_ATTEMPTS}回試行しましたが、記事の生成に失敗しました。処理を停止します。`);
      }
      console.log('[generate-spot] リトライします...');
    }
  }

  // ここに到達するのは、MAX_ATTEMPTS回すべてが notFound か duplicate で
  // continue した場合のみ（最終試行がエラーだった場合は上のcatch内でthrow
  // 済みなのでここには来ない）。以前はこのケースが完全な無言終了（ログ無し・
  // exitCode 0 の緑チェックのみ）になっており、「成功しているのに記事が
  // 増えない」原因が実行ログからまったく追えなかった。エラーではなく
  // 意図的なスキップなので exitCode は変更しない（0のまま）。
  const summaryLine = summarizeOutcomes(outcomes, OUTCOME_LABELS);
  console.log('\n============================================================');
  console.log(` 完了: ${MAX_ATTEMPTS}回試行しましたが、新しい記事は生成されませんでした（${summaryLine}）。`);
  console.log(' エラーではなく意図的なスキップです。次回の定期実行で再度リトライされます。');
  if (unconfirmedHintStores.size > 0) {
    console.log(` 参考ヒントのうち営業状況を確認できなかった店: ${Array.from(unconfirmedHintStores).join('、')}`);
  }
  console.log('============================================================');

  await appendStepSummary(
    [
      '## 🏮 本寺小路ガイド 自動記事生成（spot）',
      '',
      `${MAX_ATTEMPTS}回試行しましたが、新しい記事は生成されませんでした。`,
      '',
      `- 試行内訳: ${summaryLine}`,
      unconfirmedHintLine(),
      '',
      '_エラーではなく意図的なスキップです。次回の定期実行で再試行されます。_',
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  );
}

main().catch((err) => {
  console.error('[generate-spot] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
