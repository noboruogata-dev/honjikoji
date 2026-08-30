/**
 * 既存記事のアイキャッチ（1枚目）だけを、現在のパイプライン（透過QA・
 * ディザリングノイズ検出込み）で再生成する一回限りの復旧用スクリプト。
 * regenerate-column-illust.ts のアイキャッチ版。本文・2枚目・frontmatterの
 * 他フィールドには一切触れず、同じファイルパスへ上書きし、altだけを
 * 新しいモチーフ由来のものに差し替える（モチーフ自体はtitle/summary由来
 * なので通常は変わらない）。
 *
 * 使い方: npm run regenerate:column-eyecatch -- --slug=japanese-sake-label-rules
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import {
  buildColumnImageAlt,
  buildColumnImagePrompt,
  createEyecatchImage,
  generateTransparentSource,
  MAX_PUBLIC_IMAGE_BYTES,
} from './lib/column-images.js';
import { columnFrontmatterSchema } from './lib/column-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COLUMNS_DIR = path.join(PROJECT_ROOT, 'src/content/columns');

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const slug = getArg('slug');
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error('--slug=英小文字ケバブケース を指定してください。');
  }

  const markdownPath = path.join(COLUMNS_DIR, `${slug}.md`);
  const raw = await readFile(markdownPath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`Frontmatterを読み取れません: ${markdownPath}`);
  const parsed = columnFrontmatterSchema.safeParse(parseYaml(match[1]));
  if (!parsed.success) {
    throw new Error(`既存記事のFrontmatterがスキーマ違反です: ${parsed.error.issues.map((i) => i.message).join(' / ')}`);
  }
  if (!parsed.data.eyecatch) {
    throw new Error('この記事にはeyecatchがありません。');
  }
  const oldAlt = parsed.data.eyecatch.alt;
  const eyecatchPath = path.join(PROJECT_ROOT, 'public', parsed.data.eyecatch.src.replace(/^\//, ''));

  const imageInput = {
    slug,
    title: parsed.data.title,
    summary: parsed.data.summary,
    category: parsed.data.category,
    kind: parsed.data.kind,
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('.env に GEMINI_API_KEY を設定してください。');
  const ai = new GoogleGenAI({ apiKey });

  console.log(`[regenerate-column-eyecatch] ${slug} のアイキャッチを再生成します。`);
  const source = await generateTransparentSource(ai, buildColumnImagePrompt(imageInput));
  const eyecatchBuffer = await createEyecatchImage(source);
  if (eyecatchBuffer.length > MAX_PUBLIC_IMAGE_BYTES) {
    console.warn(`[regenerate-column-eyecatch] アイキャッチが200KBを超えています（${Math.ceil(eyecatchBuffer.length / 1024)}KB）。`);
  }

  const sourceDir = path.join(PROJECT_ROOT, 'assets-src/columns');
  await mkdir(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, `${slug}-source.png`);
  await writeFile(sourcePath, source);
  await writeFile(eyecatchPath, eyecatchBuffer);
  console.log(`[regenerate-column-eyecatch] 画像を上書きしました: ${path.relative(process.cwd(), eyecatchPath)}`);
  console.log(`[regenerate-column-eyecatch] 原画を保存しました: ${path.relative(process.cwd(), sourcePath)}`);

  const newAlt = buildColumnImageAlt(imageInput);
  if (newAlt !== oldAlt) {
    const occurrences = raw.split(oldAlt).length - 1;
    if (occurrences !== 1) {
      throw new Error(`旧altの出現回数が想定外です（期待1件、実際${occurrences}件）。手動で確認してください。旧alt: "${oldAlt}"`);
    }
    const updated = raw.split(oldAlt).join(newAlt);
    await writeFile(markdownPath, updated, 'utf-8');
    console.log(`[regenerate-column-eyecatch] altを更新しました:\n  旧: ${oldAlt}\n  新: ${newAlt}`);
  } else {
    console.log('[regenerate-column-eyecatch] altは変更なし（同じモチーフ）。');
  }
  console.log(`[regenerate-column-eyecatch] 完了: ${path.relative(process.cwd(), markdownPath)}`);
}

main().catch((error) => {
  console.error('[regenerate-column-eyecatch] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
