/**
 * scripts/generate-spot.ts
 *
 * Gemini API（Google Search Grounding）を使って、新潟県三条市「本寺小路」
 * 「本町」エリアに実在する飲食店を自律的にリサーチ・選定し、紹介記事の
 * Markdownを生成して src/content/spots/ に保存するスクリプト。
 *
 * 処理は2段階:
 *   1. リサーチ（Google Search Groundingあり）: 実在店舗を検索・選定し、
 *      分かった事実だけを自由記述テキストでまとめさせる。
 *   2. 整形（Groundingなし・構造化JSON出力）: 1のテキストだけを事実源として、
 *      Frontmatterスキーマに沿ったJSONへ変換させる（情報の捏造を禁止）。
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
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const MODEL = 'gemini-3.6-flash';
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

const NOT_FOUND_MARKER = 'NOT_FOUND';

interface ExistingSpot {
  titles: string[];
  slugs: string[];
}

interface FormattedSpot {
  title: string;
  genre: string;
  address: string;
  budget: string;
  openHours: string;
  regularHoliday: string;
  vibes: string[];
  description: string;
  body: string;
  slug: string;
}

const formatResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '正式な店名' },
    genre: {
      type: Type.STRING,
      description: `次のいずれか1つ: ${GENRES.join(' / ')}`,
    },
    address: { type: Type.STRING, description: '新潟県三条市 本町周辺の正確な住所' },
    budget: { type: Type.STRING, description: '予算目安（例: ￥3,000〜￥5,000）' },
    openHours: { type: Type.STRING, description: '営業時間（定休日は含めない）' },
    regularHoliday: { type: Type.STRING, description: '定休日（不明な場合は "不明" または "不定休"）' },
    vibes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '特徴タグ3〜6個。例: "隠れ家", "カウンター席あり", "深夜営業"',
    },
    description: { type: Type.STRING, description: '魅力的な要約（100字前後）' },
    body: {
      type: Type.STRING,
      description:
        '800〜1200字程度のMarkdown本文。名物料理・お酒のこだわり・お店の歴史や雰囲気・おすすめの利用シーンに触れる。リサーチ結果に記載のない情報は創作しない。',
    },
    slug: {
      type: Type.STRING,
      description: 'ファイル名用の英小文字ケバブケースslug（ローマ字/英訳、例: "izakaya-sanjoya"）。日本語不可。',
    },
  },
  required: [
    'title',
    'genre',
    'address',
    'budget',
    'openHours',
    'regularHoliday',
    'vibes',
    'description',
    'body',
    'slug',
  ],
};

function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function toYamlString(value: string): string {
  // JSON.stringify のダブルクオート＋エスケープは YAML のダブルクオート文字列としても
  // そのまま有効なので、同じ書式で安全にエスケープできる。
  return JSON.stringify(value);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase();
}

async function getExistingSpots(): Promise<ExistingSpot> {
  await mkdir(SPOTS_DIR, { recursive: true });
  const files = (await readdir(SPOTS_DIR)).filter((file) => file.endsWith('.md'));

  const titles: string[] = [];
  const slugs = files.map((file) => file.replace(/\.md$/, ''));

  for (const file of files) {
    const raw = await readFile(path.join(SPOTS_DIR, file), 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    try {
      const data = parseYaml(match[1]) as { title?: unknown };
      if (typeof data?.title === 'string' && data.title.trim()) {
        titles.push(data.title.trim());
      }
    } catch {
      // フロントマターのパースに失敗しても、スラッグの重複チェックだけは有効にする。
    }
  }

  return { titles, slugs };
}

async function uniqueSlug(baseSlug: string, existingSlugs: string[]): Promise<string> {
  const existing = new Set(existingSlugs);
  const safeBase = baseSlug || `spot-${Date.now()}`;
  if (!existing.has(safeBase)) return safeBase;

  let n = 2;
  while (existing.has(`${safeBase}-${n}`)) n += 1;
  return `${safeBase}-${n}`;
}

function buildResearchPrompt(
  excludeTitles: string[],
  hintTitle?: string,
  hintGenre?: string
): string {
  const exclusionText =
    excludeTitles.length > 0
      ? `次の店舗はすでに紹介済みです。絶対に選ばないでください:\n${excludeTitles
          .map((title) => `- ${title}`)
          .join('\n')}`
      : '（まだ紹介済みの店舗はありません）';

  const target = hintTitle
    ? `今回リサーチしてほしい店舗:「${hintTitle}」${hintGenre ? `（ジャンルの想定: ${hintGenre}）` : ''}\nこの店舗が新潟県三条市の本寺小路・本町エリアに実在し、除外リストに含まれていないかを確認したうえで調べてください。`
    : `今回は、新潟県三条市の「本寺小路」「本町」エリアに実在し、現在も営業している飲食店を1軒、あなた自身の判断で選んでください。
${hintGenre ? `できればジャンルは「${hintGenre}」系を優先的に検討してください（見つからなければ他ジャンルでも構いません）。` : ''}
定番の有名店だけでなく、まだあまり知られていない店も積極的に候補に入れてください。`;

  return `あなたは新潟県三条市の歓楽街「本寺小路」「本町」エリアの飲食店に詳しいリサーチャーです。
Google検索を使って実在する飲食店（居酒屋・BAR・スナック・割烹・焼肉・焼き鳥・ラーメン・おでん・立ち飲み・小料理屋 等）についてファクトチェックしながら調査してください。

${target}

${exclusionText}

調べて分かった範囲で、以下の情報を日本語のテキストでまとめてください。
- 正式な店名
- ジャンル
- 住所（新潟県三条市 本町周辺の正確な住所）
- 営業時間
- 定休日
- 予算目安
- 名物料理・お酒・雰囲気・店の歴史など、紹介記事に使えそうな特徴
- 参照した情報源（サイト名やURLが分かれば）

重要な注意点:
- 実在しない店舗を創作しないでください。
- 調べても分からない項目は、無理に埋めず「不明」と明記してください。
- 除外リストの店舗、または本寺小路・本町エリア以外の店舗しか見つからない場合は、
  他の情報は一切書かず、テキストの1行目に半角で "${NOT_FOUND_MARKER}" とだけ出力してください。`;
}

function buildFormatPrompt(researchText: string, hintTitle?: string): string {
  return `あなたは新潟県三条市の歓楽街「本寺小路」を紹介する夜の街ガイドサイトのライターです。
以下は、実在店舗についてのリサーチ結果（事実源）です。この内容だけを事実として扱い、
書かれていない情報を創作・推測で補わないでください。金額・営業時間・定休日などが
「不明」となっている項目は、フロントマターにも「不明」とそのまま記載してください。

--- リサーチ結果 ---
${researchText}
--- ここまで ---

${hintTitle ? `店名は必ず「${hintTitle}」に対応する正式名称にしてください。` : ''}

紹介記事本文（body）の執筆ルール:
- 800〜1200字程度、Markdown形式。
- 他サイトや口コミの文章をそのまま転載せず、あなた自身の言葉でオリジナルの紹介コラムとして書き下ろすこと。
- 名物料理、お酒のこだわり、お店の歴史や雰囲気、おすすめの利用シーンに触れること。
  ただし、リサーチ結果に具体的な記載がない場合は、断定的な固有の料理名などを創作せず、
  一般的・控えめな表現に留めること。
- 文体は敬体（です・ます調）で、本寺小路の夜の情緒が伝わるように。
- 見出し（## など）を使ってもよいが、必須ではない。

vibes（特徴タグ）は3〜6個。可能であれば次の中から当てはまるものを含めてよい（無理に含めなくてもよい）:
${SCENE_TAGS.map((tag) => `- ${tag}`).join('\n')}
そのほか、雰囲気を表す短いタグ（例: "隠れ家", "カウンター席あり", "個室あり", "日本酒充実"）を自由に追加すること。`;
}

async function callResearch(
  ai: GoogleGenAI,
  excludeTitles: string[],
  hintTitle?: string,
  hintGenre?: string
): Promise<string> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildResearchPrompt(excludeTitles, hintTitle, hintGenre),
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('リサーチ用のGemini呼び出しから空のレスポンスが返されました。');
  }

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  if (chunks.length > 0) {
    console.log('[generate-spot] 参照した情報源:');
    for (const chunk of chunks) {
      if (chunk.web?.uri) {
        console.log(`  - ${chunk.web.title ?? chunk.web.uri} (${chunk.web.uri})`);
      }
    }
  }

  return text;
}

async function callFormat(ai: GoogleGenAI, researchText: string, hintTitle?: string): Promise<FormattedSpot> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildFormatPrompt(researchText, hintTitle),
    config: {
      responseMimeType: 'application/json',
      responseSchema: formatResponseSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('整形用のGemini呼び出しから空のレスポンスが返されました。');
  }

  let parsed: FormattedSpot;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[generate-spot] レスポンスのJSONパースに失敗しました:', text);
    throw err;
  }

  const requiredKeys: (keyof FormattedSpot)[] = [
    'title',
    'genre',
    'address',
    'budget',
    'openHours',
    'regularHoliday',
    'vibes',
    'description',
    'body',
    'slug',
  ];
  const missing = requiredKeys.filter((key) => parsed[key] === undefined || parsed[key] === null);
  if (missing.length > 0) {
    throw new Error(`Geminiのレスポンスに必須項目が不足しています: ${missing.join(', ')}`);
  }

  return parsed;
}

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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { titles: excludeTitles, slugs: existingSlugs } = await getExistingSpots();

    console.log(
      `[generate-spot] (${attempt}/${MAX_ATTEMPTS}) リサーチ中... 除外対象: ${excludeTitles.length}件`
    );

    const preferredGenre = hintGenre ?? (hintTitle ? undefined : pickRandom(GENRES));
    const researchText = await callResearch(ai, excludeTitles, hintTitle, preferredGenre);

    if (researchText.trim().startsWith(NOT_FOUND_MARKER)) {
      console.warn(
        `[generate-spot] (${attempt}/${MAX_ATTEMPTS}) 除外リスト以外の実在店舗を見つけられませんでした。リトライします...`
      );
      continue;
    }

    console.log('[generate-spot] 記事を整形中...');
    const generated = await callFormat(ai, researchText, hintTitle);

    const isDuplicate = excludeTitles.some(
      (title) => normalizeTitle(title) === normalizeTitle(generated.title)
    );
    if (isDuplicate) {
      console.warn(
        `[generate-spot] (${attempt}/${MAX_ATTEMPTS}) 「${generated.title}」はすでに掲載済みでした。リトライします...`
      );
      continue;
    }

    const slug = await uniqueSlug(slugify(generated.slug), existingSlugs);
    const pubDate = new Date().toISOString().slice(0, 10);
    const mapQuery = `${generated.title} 三条市`;

    const frontmatter = [
      '---',
      `title: ${toYamlString(generated.title)}`,
      `genre: ${toYamlString(generated.genre)}`,
      `address: ${toYamlString(generated.address)}`,
      `mapQuery: ${toYamlString(mapQuery)}`,
      `budget: ${toYamlString(generated.budget)}`,
      `openHours: ${toYamlString(generated.openHours)}`,
      `regularHoliday: ${toYamlString(generated.regularHoliday)}`,
      'vibes:',
      ...generated.vibes.map((vibe) => `  - ${toYamlString(vibe)}`),
      `description: ${toYamlString(generated.description)}`,
      `pubDate: ${pubDate}`,
      '---',
      '',
      '',
    ].join('\n');

    const filePath = path.join(SPOTS_DIR, `${slug}.md`);
    await writeFile(filePath, frontmatter + generated.body.trim() + '\n', 'utf-8');

    console.log(`[generate-spot] 保存しました: ${path.relative(process.cwd(), filePath)}`);
    console.log(`[generate-spot] 店舗: ${generated.title}（${generated.genre}）`);
    return;
  }

  throw new Error(
    `${MAX_ATTEMPTS}回試行しましたが、未掲載の実在店舗を確定できませんでした。除外リストが多すぎる可能性があります。`
  );
}

main().catch((err) => {
  console.error('[generate-spot] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
