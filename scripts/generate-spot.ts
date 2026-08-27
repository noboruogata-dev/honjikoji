/**
 * scripts/generate-spot.ts
 *
 * Gemini API を使って、本寺小路（新潟県三条市）の店舗紹介Markdownを
 * 生成し、src/content/spots/ に保存するスクリプト。
 *
 * 使い方:
 *   npm run generate:spot                          # ランダムな店舗候補から1件生成
 *   npm run generate:spot -- "店名" "ジャンル"        # 店名・ジャンルを指定して生成
 *
 * 事前準備:
 *   .env に GEMINI_API_KEY を設定してください（.env.example 参照）。
 *   https://aistudio.google.com/apikey で取得できます。
 */

import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const MODEL = 'gemini-3.6-flash';

// 引数が無いときにランダムで選ぶ、本寺小路らしい店舗候補。
// 既存サンプル（酒処 三条家 / スナック あかり / らーめん 一心）とは重複しない構成。
const CANDIDATES: { title: string; genre: string }[] = [
  { title: '焼肉 本陣', genre: '焼肉' },
  { title: 'Bar Ember', genre: 'BAR' },
  { title: '割烹 花月', genre: '割烹' },
  { title: '焼鳥 弥七', genre: '焼き鳥' },
  { title: 'スナック りりぃ', genre: 'スナック' },
  { title: '立ち呑み 三条酒場', genre: '立ち飲み' },
  { title: 'おでん 縄のれん', genre: 'おでん' },
  { title: 'Bar 月光', genre: 'BAR' },
  { title: '小料理屋 なかむら', genre: '割烹' },
  { title: '餃子酒場 龍鳳', genre: '居酒屋' },
];

const AREA_CANDIDATES = ['本寺小路メイン通り', '一ノ木戸商店街寄り', '本寺小路の奥まった路地'];

interface GeneratedSpot {
  area: string;
  address: string;
  businessHours: string;
  budget: string;
  features: string[];
  description: string;
  intro: string;
  menuItems: string[];
  recommendFor: string;
  slug: string;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    area: { type: Type.STRING, description: '本寺小路内のエリア（例: 本寺小路メイン通り）' },
    address: { type: Type.STRING, description: '新潟県三条市の架空の詳細住所' },
    businessHours: { type: Type.STRING, description: '営業時間と定休日' },
    budget: { type: Type.STRING, description: '予算目安（例: 3,000円〜4,500円）' },
    features: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '店舗の特徴タグ。3〜5個。例: "カウンターあり", "深夜営業", "日本酒充実", "締めに最適"',
    },
    description: { type: Type.STRING, description: '店舗概要・おすすめポイント（1〜2文、100字前後）' },
    intro: { type: Type.STRING, description: '記事本文の書き出しの1段落（description とは違う切り口で）' },
    menuItems: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'おすすめメニュー。3〜5品',
    },
    recommendFor: { type: Type.STRING, description: '「こんな人におすすめ」の1段落' },
    slug: {
      type: Type.STRING,
      description:
        'ファイル名用の英小文字ケバブケースslug（ローマ字/英訳、例: "yakiniku-honjin"）。日本語不可。',
    },
  },
  required: [
    'area',
    'address',
    'businessHours',
    'budget',
    'features',
    'description',
    'intro',
    'menuItems',
    'recommendFor',
    'slug',
  ],
};

function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function toYamlString(value: string): string {
  // JSON.stringify のダブルクオート＋エスケープは YAML のダブルクオート文字列としても
  // そのまま有効なので、既存サンプルと同じ書式で安全にエスケープできる。
  return JSON.stringify(value);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function uniqueSlug(baseSlug: string): Promise<string> {
  await mkdir(SPOTS_DIR, { recursive: true });
  const existing = new Set(
    (await readdir(SPOTS_DIR)).map((file) => file.replace(/\.md$/, ''))
  );

  const safeBase = baseSlug || `spot-${Date.now()}`;
  if (!existing.has(safeBase)) return safeBase;

  let n = 2;
  while (existing.has(`${safeBase}-${n}`)) n += 1;
  return `${safeBase}-${n}`;
}

function buildPrompt(title: string, genre: string): string {
  return `あなたは新潟県三条市の歓楽街「本寺小路（ほんじこうじ）」を紹介する
夜の街ガイドサイトのライターです。以下の架空の店舗について、
サイトのトーン（気取らない、常連と一見が混ざり合う下町の歓楽街の情緒）に
合わせた紹介コンテンツをJSONで生成してください。

- 店名: ${title}
- ジャンル: ${genre}
- エリアは次の候補から本寺小路らしいものを1つ選ぶか、近い雰囲気で作ってください: ${AREA_CANDIDATES.join(' / ')}
- 住所・電話番号などの実在情報は書かず、あくまで架空の設定として自然な体裁にしてください（例:「新潟県三条市本町◯丁目 本寺小路沿い」）。
- 実在の店舗・人物と誤認されないよう、固有名詞は創作してください。
- 文体は既存記事に合わせ、敬体（です・ます調）で。
- features は日本語の短いタグを3〜5個。`;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      '[generate-spot] GEMINI_API_KEY が設定されていません。.env に GEMINI_API_KEY=... を追加してください（.env.example 参照）。'
    );
    process.exit(1);
  }

  const [argTitle, argGenre] = process.argv.slice(2);

  const { title, genre } = argTitle
    ? { title: argTitle, genre: argGenre ?? pickRandom(CANDIDATES).genre }
    : pickRandom(CANDIDATES);

  console.log(`[generate-spot] 生成対象: ${title}（${genre}）`);

  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(title, genre),
    config: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Gemini APIから空のレスポンスが返されました。');
  }

  let generated: GeneratedSpot;
  try {
    generated = JSON.parse(text);
  } catch (err) {
    console.error('[generate-spot] レスポンスのJSONパースに失敗しました:', text);
    throw err;
  }

  const requiredKeys: (keyof GeneratedSpot)[] = [
    'area',
    'address',
    'businessHours',
    'budget',
    'features',
    'description',
    'intro',
    'menuItems',
    'recommendFor',
    'slug',
  ];
  const missing = requiredKeys.filter((key) => generated[key] === undefined || generated[key] === null);
  if (missing.length > 0) {
    throw new Error(`Geminiのレスポンスに必須項目が不足しています: ${missing.join(', ')}`);
  }

  const slug = await uniqueSlug(slugify(generated.slug));
  const publishedAt = new Date().toISOString().slice(0, 10);

  const frontmatter = [
    '---',
    `title: ${toYamlString(title)}`,
    `genre: ${toYamlString(genre)}`,
    `area: ${toYamlString(generated.area)}`,
    `address: ${toYamlString(generated.address)}`,
    `businessHours: ${toYamlString(generated.businessHours)}`,
    `budget: ${toYamlString(generated.budget)}`,
    'features:',
    ...generated.features.map((feature) => `  - ${toYamlString(feature)}`),
    `description: ${toYamlString(generated.description)}`,
    `publishedAt: ${publishedAt}`,
    '---',
    '',
    '',
  ].join('\n');

  const body = [
    generated.intro,
    '',
    '## おすすめメニュー',
    '',
    ...generated.menuItems.map((item) => `- ${item}`),
    '',
    '## こんな人におすすめ',
    '',
    generated.recommendFor,
    '',
  ].join('\n');

  const filePath = path.join(SPOTS_DIR, `${slug}.md`);
  await writeFile(filePath, frontmatter + body, 'utf-8');

  console.log(`[generate-spot] 保存しました: ${path.relative(process.cwd(), filePath)}`);
}

main().catch((err) => {
  console.error('[generate-spot] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exit(1);
});
