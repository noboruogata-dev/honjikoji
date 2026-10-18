/**
 * scripts/regenerate-column-images.ts
 *
 * 既存コラムの挿絵（アイキャッチ・Instagramフィード画像・本文中ほどの挿絵）を、
 * 現在のパイプライン（記事固有の被写体の発想＋構図パターン）で作り直す。
 * 新規記事の生成（generate-column.ts）と同じgenerateColumnImagesを、
 * 既存画像を上書きするモードで呼ぶ。
 *
 * - 本文の文章・frontmatterの他の項目（imageStatus等）には触れない。変わるのは
 *   画像ファイルと、そのalt（frontmatterのeyecatch.alt・illustration.alt、
 *   本文中の挿絵の![alt](src)）だけ。
 * - 2枚目（illustration）が元々ある記事だけ2枚目も作り直す（無い記事に
 *   新しく挿絵を足さない）。
 * - 生成に失敗した記事は、既存の画像・本文を一切変更しない（画像の書き込みは
 *   生成に成功した後にまとめて行われる）。
 *
 * 使い方:
 *   npm run regenerate:column-images -- --slug=<slug>
 *   npm run regenerate:column-images -- --slug=<slug> --eyecatch-composition=triptych --mid-composition=glow-silhouette
 *
 * 構図は省略するとslugから自動選択される。複数記事を続けて作り直すときに
 * 構図が偏らないよう調整したい場合だけ、上のオプションで指定する
 * （指定できるkeyはscripts/lib/column-art-direction.tsのCOMPOSITION_PATTERNS）。
 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { findMidImageInsertion, generateColumnImages } from './lib/column-images.js';
import { columnFrontmatterSchema } from './lib/column-pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COLUMNS_DIR = path.join(PROJECT_ROOT, 'src/content/columns');

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * frontmatterの`<key>:`ブロック（eyecatch / illustration）の中のalt行だけを置換する。
 * eyecatchとillustrationで同じaltの記事があるため、alt文字列そのものでの置換はしない。
 * ブロックやalt行が見つからなければ例外（生成に着手する前に呼んで検査にも使う）。
 */
function replaceBlockAlt(frontmatterText: string, key: 'eyecatch' | 'illustration', newAlt: string): string {
  const pattern = new RegExp(`(^${key}:\\n(?:[ \\t]+.*\\n)*?[ \\t]+alt: )".*"`, 'm');
  if (!pattern.test(frontmatterText)) {
    throw new Error(`frontmatterの${key}.alt（ダブルクォートの1行）が見つかりません。手動で確認してください。`);
  }
  return frontmatterText.replace(pattern, (_, head: string) => `${head}${JSON.stringify(newAlt)}`);
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
  const { eyecatch, illustration } = parsed.data;
  if (!eyecatch) throw new Error('この記事にはeyecatchがありません。新規生成はgenerate-column-image.tsを使ってください。');

  const frontmatterEnd = match.index! + match[0].length;
  const separator = raw.slice(frontmatterEnd).match(/^\n*/)![0];
  const originalBody = raw.slice(frontmatterEnd + separator.length);

  // 既存の2枚目の画像行を本文から外す（generateColumnImagesが同じ位置へ新しい
  // 行を挿入し直す。挿入位置は本文の見出し構造だけで決まるため前回と同じ）。
  //
  // frontmatterにillustrationがあっても、本文にその画像行が無い記事がある
  // （レビュー時に本文から外された等。illustrationフィールド自体はどのページでも
  // 表示に使われない）。その場合は人が外した判断を尊重し、2枚目には触れない。
  let bodyForGeneration = originalBody;
  let regenerateMid = false;
  if (illustration) {
    const imageLine = new RegExp(`\\n*!\\[[^\\]]*\\]\\(${escapeRegExp(illustration.src)}\\)\\n*`);
    if (imageLine.test(originalBody)) {
      bodyForGeneration = originalBody.replace(imageLine, '\n\n');
      if (!findMidImageInsertion(bodyForGeneration)) {
        throw new Error('2枚目の挿入位置を決められません（本文が変わった可能性があります）。');
      }
      regenerateMid = true;
    } else {
      console.warn(`[regenerate-column-images] 本文に2枚目の画像行（${illustration.src}）が無いため、2枚目は作り直しません。`);
    }
  }

  // alt行を書き換えられることを、画像生成（API消費・ファイル上書き）の前に確認しておく。
  replaceBlockAlt(match[0], 'eyecatch', eyecatch.alt);
  if (regenerateMid) replaceBlockAlt(match[0], 'illustration', illustration!.alt);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('.env に GEMINI_API_KEY を設定してください。');
  const ai = new GoogleGenAI({ apiKey });

  console.log(`[regenerate-column-images] ${slug} を作り直します（2枚目: ${regenerateMid ? 'あり' : 'なし'}）`);
  const result = await generateColumnImages(
    ai,
    { slug, title: parsed.data.title, summary: parsed.data.summary, category: parsed.data.category, kind: parsed.data.kind },
    bodyForGeneration,
    PROJECT_ROOT,
    {
      overwrite: true,
      includeMid: regenerateMid,
      compositions: { eyecatch: getArg('eyecatch-composition'), mid: getArg('mid-composition') },
    }
  );
  for (const warning of result.warnings) console.warn(`[regenerate-column-images] [WARN] ${warning}`);

  let frontmatterText = match[0];
  frontmatterText = replaceBlockAlt(frontmatterText, 'eyecatch', result.eyecatch.alt);
  let finalBody = originalBody;
  if (illustration && regenerateMid) {
    if (result.illustration) {
      frontmatterText = replaceBlockAlt(frontmatterText, 'illustration', result.illustration.alt);
      finalBody = result.body;
    } else {
      // 2枚目の生成だけ失敗した場合は、画像は上書きされていないので、
      // 既存の2枚目（画像・alt・本文の画像行）をそのまま残す。
      console.warn('[regenerate-column-images] 2枚目の再生成に失敗したため、2枚目は既存のまま残します。');
    }
  }

  const updated = `${frontmatterText}${separator}${finalBody.trim()}\n`;
  await writeFile(markdownPath, updated, 'utf-8');
  console.log(`[regenerate-column-images] 完了: ${path.relative(process.cwd(), markdownPath)}`);
  console.log(`  アイキャッチ: ${result.eyecatch.alt}`);
  if (result.illustration) console.log(`  2枚目: ${result.illustration.alt}`);
}

main().catch((error) => {
  console.error('[regenerate-column-images] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
