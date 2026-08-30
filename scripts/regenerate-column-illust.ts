/**
 * 既存記事の2枚目（本文中ほどの挿絵）だけを、現在のパイプライン
 * （透過QA・ディザリングノイズ検出込み）で再生成する一回限りの復旧用スクリプト。
 *
 * 1枚目（アイキャッチ）・本文・frontmatterの他フィールドには一切触れない。
 * 挿入位置（findMidImageInsertion）は本文が変わっていなければ前回と同じ
 * 位置に決定論的に定まるため、画像ファイルを同じパスへ上書きし、
 * altテキスト（フロントマター・本文の![alt](src)の両方）だけを
 * 新しいモチーフ由来のものに差し替える。
 *
 * 使い方: npm run regenerate:column-illust -- --slug=japanese-sake-label-rules
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import {
  buildColumnMidImageAlt,
  buildColumnMidImagePrompt,
  createIllustrationImage,
  findMidImageInsertion,
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
  if (!parsed.data.illustration) {
    throw new Error('この記事にはillustration（2枚目）がありません。新規追加はgenerate-column-image.tsを使ってください。');
  }
  const oldAlt = parsed.data.illustration.alt;
  const illustPath = path.join(PROJECT_ROOT, 'public', parsed.data.illustration.src.replace(/^\//, ''));

  const body = raw.slice(match.index! + match[0].length).replace(/^\n+/, '');
  const insertion = findMidImageInsertion(body);
  if (!insertion) {
    throw new Error('findMidImageInsertionが挿入位置を決められません（本文が変わった可能性があります）。');
  }

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

  console.log(`[regenerate-column-illust] ${slug} の2枚目を再生成します（挿入位置: ${insertion.contextAfter.slice(0, 30)}...）`);
  const midSource = await generateTransparentSource(ai, buildColumnMidImagePrompt(imageInput, insertion));
  const illustrationBuffer = await createIllustrationImage(midSource);
  if (illustrationBuffer.length > MAX_PUBLIC_IMAGE_BYTES) {
    console.warn(`[regenerate-column-illust] 本文挿絵が200KBを超えています（${Math.ceil(illustrationBuffer.length / 1024)}KB）。`);
  }

  const sourceDir = path.join(PROJECT_ROOT, 'assets-src/columns');
  await mkdir(sourceDir, { recursive: true });
  const midSourcePath = path.join(sourceDir, `${slug}-illust-source.png`);
  await writeFile(midSourcePath, midSource);
  await writeFile(illustPath, illustrationBuffer);
  console.log(`[regenerate-column-illust] 画像を上書きしました: ${path.relative(process.cwd(), illustPath)}`);
  console.log(`[regenerate-column-illust] 原画を保存しました: ${path.relative(process.cwd(), midSourcePath)}`);

  const newAlt = buildColumnMidImageAlt(imageInput, insertion);
  const occurrences = raw.split(oldAlt).length - 1;
  if (occurrences !== 2) {
    throw new Error(
      `旧altの出現回数が想定外です（期待2件、実際${occurrences}件）。frontmatterと本文の![alt](src)以外にも` +
        `一致箇所があるため、安全のため自動置換を中止します。手動で確認してください。旧alt: "${oldAlt}"`
    );
  }
  const updated = raw.split(oldAlt).join(newAlt);
  await writeFile(markdownPath, updated, 'utf-8');
  console.log(`[regenerate-column-illust] altを更新しました:\n  旧: ${oldAlt}\n  新: ${newAlt}`);
  console.log(`[regenerate-column-illust] 完了: ${path.relative(process.cwd(), markdownPath)}`);
}

main().catch((error) => {
  console.error('[regenerate-column-illust] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
