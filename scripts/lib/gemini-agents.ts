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
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { ZodError } from 'zod';

export const GEMINI_MODEL = 'gemini-3.6-flash';

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
