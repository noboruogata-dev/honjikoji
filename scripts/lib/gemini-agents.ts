/**
 * scripts/lib/gemini-agents.ts
 *
 * generate-spot.ts / generate-news.ts が共有する、マルチエージェント
 * パイプライン（Research → Writer → QA）の共通ユーティリティ。
 *
 * ここに置くのは「どのコンテンツ種別にも依存しない」部分だけ:
 *   - Gemini呼び出しの実行方法（Grounding+構造化出力のフォールバック処理、
 *     クォータ超過の致命的エラー化など）
 *   - JSONパース・Zodエラーのログ整形
 *   - 既存記事の frontmatter（title/slug）を読み込む共通ロジック
 *   - slug生成・YAML文字列エスケープなどの細かいヘルパー
 *
 * ジャンルやプロンプト文面など、コンテンツ種別ごとに異なる部分は
 * 各スクリプト側に残す。
 */

import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z, type ZodError } from 'zod';

export const GEMINI_MODEL = 'gemini-3.6-flash';

// ============================================================
// ニュース記事の共通スキーマ
//
// generate-news.ts（LLMが書いた記事）と generate-spot.ts（店舗公開の
// お知らせをテンプレートから決定論的に組み立てる機能）の両方が、
// 同じ src/content/news/[slug].md フォーマットに書き込む。定義が2箇所で
// ズレるのを防ぐため、ここに一本化する。
//
// 注意: generate-news.ts 自体を import してはいけない。あのファイルは
// モジュール末尾で main().catch(...) が無条件実行されるため、import した
// 瞬間にニュース生成パイプライン全体が副作用として走ってしまう。
// ============================================================

export const NEWS_CATEGORIES = ['NEW SPOT', 'EVENT', 'NOTICE'] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** src/content.config.ts の news Frontmatterスキーマに完全準拠したスキーマ。 */
export const newsFrontmatterSchema = z.object({
  title: z.string().min(1, 'title が空です'),
  pubDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'pubDate は YYYY-MM-DD 形式である必要があります'),
  category: z.enum(NEWS_CATEGORIES),
  summary: z.string().min(1, 'summary が空です'),
  relatedSpotSlug: z.string().min(1).optional(),
});
export type NewsFrontmatter = z.infer<typeof newsFrontmatterSchema>;

/** newsFrontmatterSchema 準拠のデータから、Markdownファイルに書き込む
 *  frontmatterブロック（本文は含まない）を組み立てる。 */
export function buildNewsFrontmatterBlock(fm: NewsFrontmatter): string {
  return [
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
}

/** リトライしても解消しない致命的エラー（APIクォータ超過など）。呼び出し側は即座に処理を止めること。 */
export class FatalPipelineError extends Error {}

// ============================================================
// 汎用ヘルパー
// ============================================================

export function pickRandom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function toYamlString(value: string): string {
  // JSON.stringify のダブルクオート＋エスケープは YAML のダブルクオート文字列としても
  // そのまま有効なので、同じ書式で安全にエスケープできる。
  return JSON.stringify(value);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

// ============================================================
// 試行結果の集計・GitHub Actions Job Summary への出力
//
// generate-spot.ts / generate-news.ts はどちらも「最大N回リトライして、
// 候補なし・重複でスキップし続けた場合はエラーにせず静かに終了する」
// 設計になっている。これ自体は意図通りだが、以前はその「静かに終了」が
// 文字通り無言（＝Actionsの実行一覧が緑のチェックのまま、中で何が
// 起きたか一切分からない）だったため、各試行の結果を集計してログと
// Job Summaryの両方に必ず残すための共通ヘルパー。
// ============================================================

/** 試行結果（例: 'notFound' | 'duplicate' | 'success' | 'error'）の配列を、
 *  「候補なし2回、重複1回」のような日本語サマリ文字列に集計する。
 *  labels に無いキーはキー名をそのまま表示する。 */
export function summarizeOutcomes(outcomes: string[], labels: Record<string, string> = {}): string {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) {
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, n]) => `${labels[key] ?? key}${n}回`)
    .join('、');
}

/**
 * GitHub Actions の Job Summary（$GITHUB_STEP_SUMMARY）にMarkdownを追記する。
 * ローカル実行など環境変数が無い場合は何もしない（no-op）。書き込み失敗は
 * 本処理を止める理由にならないため、warnするだけで握りつぶす。
 */
export async function appendStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    await appendFile(summaryPath, `${markdown.replace(/\n+$/, '')}\n\n`, 'utf-8');
  } catch (err) {
    console.warn(
      '[gemini-agents] GITHUB_STEP_SUMMARY への書き込みに失敗しました（処理は継続します）:',
      err instanceof Error ? err.message : err
    );
  }
}

export function uniqueSlug(baseSlug: string, existingSlugs: string[], fallbackPrefix = 'entry'): string {
  const existing = new Set(existingSlugs);
  const safeBase = baseSlug || `${fallbackPrefix}-${Date.now()}`;
  if (!existing.has(safeBase)) return safeBase;

  let n = 2;
  while (existing.has(`${safeBase}-${n}`)) n += 1;
  return `${safeBase}-${n}`;
}

// ============================================================
// 既存記事の読み込み（重複防止・関連付け用）
// ============================================================

export interface ExistingEntries {
  titles: string[];
  slugs: string[];
}

/** 指定ディレクトリ配下の *.md から、frontmatterの title とファイル名（slug）を集める。 */
export async function getExistingEntries(dir: string): Promise<ExistingEntries> {
  await mkdir(dir, { recursive: true });
  const files = (await readdir(dir)).filter((file) => file.endsWith('.md'));

  const titles: string[] = [];
  const slugs = files.map((file) => file.replace(/\.md$/, ''));

  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf-8');
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

/**
 * 指定ディレクトリ内の {slug}.md を読み、frontmatter（YAML）をパースして
 * オブジェクトとして返す。ファイルが無い・frontmatterが無い・パース失敗の
 * 場合は null（呼び出し側で個別にスキップ判断できるよう、例外は投げない）。
 */
export async function readFrontmatter(dir: string, slug: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, `${slug}.md`), 'utf-8');
  } catch {
    return null;
  }

  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  try {
    const data = parseYaml(match[1]);
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Gemini呼び出しの低レベルユーティリティ
// ============================================================

function isQuotaError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /RESOURCE_EXHAUSTED/i.test(msg) || /"code"\s*:\s*429/.test(msg);
}

/** tools（Grounding）と responseSchema の併用が拒否された（400系）ように見えるかを判定する。 */
function looksLikeToolSchemaConflict(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /"code"\s*:\s*400/.test(msg) && /(tool|function)/i.test(msg) && /(schema|response_mime_type|json)/i.test(msg);
}

function requireText(response: GenerateContentResponse, context: string): string {
  const text = response.text;
  if (!text) throw new Error(`${context}: レスポンスが空でした。`);
  return text;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('レスポンスからJSONオブジェクトを抽出できませんでした。');
  }
  return candidate.slice(start, end + 1);
}

export function logGroundingSources(response: GenerateContentResponse, label: string) {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const withUri = chunks.filter((chunk) => chunk.web?.uri);
  if (withUri.length === 0) return;

  console.log(`${label} 参照した情報源 (${withUri.length}件):`);
  for (const chunk of withUri) {
    console.log(`  - ${chunk.web?.title ?? chunk.web?.uri} (${chunk.web?.uri})`);
  }
}

/**
 * Google Search Grounding + 構造化JSON出力でGeminiを呼び出す。
 * 併用がAPI側で拒否された場合はプレーンJSONモード（コードフェンス除去）に自動フォールバックする。
 * クォータ超過（429）は再試行しても無駄なので FatalPipelineError として投げる。
 */
export async function callGroundedJsonAgent(
  ai: GoogleGenAI,
  opts: { label: string; prompt: string; responseSchema: object }
): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: opts.prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
        responseSchema: opts.responseSchema,
      },
    });
    const text = requireText(response, opts.label);
    logGroundingSources(response, opts.label);
    return text;
  } catch (err) {
    if (isQuotaError(err)) {
      throw new FatalPipelineError(
        'Google Search Grounding呼び出しがクォータ超過（429）で失敗しました。Google Cloud側の課金設定・APIの有効化状況をご確認ください。'
      );
    }
    if (!looksLikeToolSchemaConflict(err)) throw err;

    console.warn(`${opts.label} 構造化出力とGrounding併用が拒否されたため、プレーンJSONモードにフォールバックします。`);
    const fallbackResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `${opts.prompt}\n\n出力は説明文やMarkdownのコードフェンスを付けず、有効なJSONオブジェクトのみを1つ出力してください。`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });
    const fallbackText = requireText(fallbackResponse, `${opts.label}（フォールバック）`);
    logGroundingSources(fallbackResponse, opts.label);
    return extractJsonObject(fallbackText);
  }
}

/** Grounding無し・構造化JSON出力のみでGeminiを呼び出す（Writerエージェント向け）。 */
export async function callPlainJsonAgent(
  ai: GoogleGenAI,
  opts: { label: string; prompt: string; responseSchema: object }
): Promise<string> {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: opts.prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: opts.responseSchema,
    },
  });
  return requireText(response, opts.label);
}

export function parseJsonOrThrow(rawText: string, label: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    console.error(`${label} JSONパースに失敗しました。生レスポンス:`, rawText);
    throw new Error(`${label}のレスポンスをJSONとして解析できませんでした。`);
  }
}

/** Zodの safeParse 失敗結果を整形してログ出力する。 */
export function logZodIssues(result: { success: false; error: ZodError }, label: string) {
  console.error(`${label} レスポンスがスキーマに準拠していません:`);
  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
}

// ============================================================
// 記事本文の構造解析（generate-spot.ts / generate-news.ts の
// Agent3が共通で使う、決定論的な可読性チェック）
// ============================================================

export interface ArticleStructure {
  charCount: number;
  paragraphCount: number;
  /** "## " / "### " 等、見出し行の数 */
  headingCount: number;
  /** 段落（見出し行を除く）のうち最も文字数が多いものの文字数。段落が無ければ0。 */
  maxParagraphChars: number;
}

/** Markdown本文を空行区切りで段落分割し、文字数・段落数・見出し数を数える。 */
export function analyzeArticleStructure(body: string): ArticleStructure {
  const trimmed = body.trim();
  const charCount = [...trimmed].length;

  const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const headingBlocks = blocks.filter((b) => /^#{1,6}\s/.test(b));
  const paragraphBlocks = blocks.filter((b) => !/^#{1,6}\s/.test(b));

  const maxParagraphChars = paragraphBlocks.reduce(
    (max, p) => Math.max(max, [...p.replace(/\n/g, '')].length),
    0
  );

  return {
    charCount,
    paragraphCount: paragraphBlocks.length,
    headingCount: headingBlocks.length,
    maxParagraphChars,
  };
}

/**
 * 構造要件（200字超で2段落以上・400字超で見出し1つ以上・1段落150字程度）を
 * 満たしているか決定論的にチェックし、満たさない項目のメッセージ一覧を返す
 * （空配列なら問題なし）。呼び出し側はこれを console.warn するだけで、
 * 保存自体はブロックしない（既存の文字数チェックと同じ非ブロッキング方針）。
 */
export function checkArticleStructure(structure: ArticleStructure): string[] {
  const warnings: string[] = [];
  const { charCount, paragraphCount, headingCount, maxParagraphChars } = structure;

  if (charCount > 200 && paragraphCount < 2) {
    warnings.push(
      `本文が${charCount}字あるのに段落が${paragraphCount}個しかありません（200字超は2段落以上が目安）。`
    );
  }
  if (charCount > 400 && headingCount < 1) {
    warnings.push(`本文が${charCount}字あるのに見出し(##)がありません（400字超は見出し1つ以上が目安）。`);
  }
  if (maxParagraphChars > 150) {
    warnings.push(`最も長い段落が${maxParagraphChars}字あります（1段落150字程度が目安）。`);
  }

  return warnings;
}
