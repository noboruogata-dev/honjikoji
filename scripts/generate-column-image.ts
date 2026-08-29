/** 既存のコラム下書きに、画像を後付けする。
 *  アイキャッチ（1枚目）は常に生成する。本文中ほどの挿絵（2枚目）は
 *  findMidImageInsertionの条件（見出し数・文字数）を満たす場合だけ生成し、
 *  成功したら本文へ`![alt](src)`を直接挿入する（満たさない・失敗した場合は
 *  本文は変更しない）。 */
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { buildColumnImagePrompt, buildColumnMidImagePrompt, findMidImageInsertion, generateColumnImages } from './lib/column-images.js';
import { columnFrontmatterSchema } from './lib/column-pipeline.js';
import { toYamlString } from './lib/gemini-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COLUMNS_DIR = path.join(PROJECT_ROOT, 'src/content/columns');

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function imageFrontmatterLines(result: Awaited<ReturnType<typeof generateColumnImages>>): string[] {
  const lines: string[] = [];
  if (result.illustration) {
    lines.push('illustration:', `  src: ${toYamlString(result.illustration.src)}`, `  alt: ${toYamlString(result.illustration.alt)}`);
  }
  lines.push('eyecatch:', `  src: ${toYamlString(result.eyecatch.src)}`, `  alt: ${toYamlString(result.eyecatch.alt)}`, 'imageStatus: draft');
  return lines;
}

async function main() {
  const slug = getArg('slug');
  const dryRun = process.argv.includes('--dry-run');
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error('--slug=英小文字ケバブケース を指定してください。');
  }

  const markdownPath = path.join(COLUMNS_DIR, `${slug}.md`);
  const raw = await readFile(markdownPath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`Frontmatterを読み取れません: ${markdownPath}`);
  const parsedYaml = parseYaml(match[1]);
  const parsed = columnFrontmatterSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    throw new Error(`既存記事のFrontmatterがスキーマ違反です: ${parsed.error.issues.map((issue) => issue.message).join(' / ')}`);
  }
  if (parsed.data.illustration || parsed.data.eyecatch || parsed.data.imageStatus) {
    throw new Error('既に画像Frontmatterがあります。上書きしません。');
  }

  const body = raw.slice(match.index! + match[0].length).replace(/^\n+/, '');

  const input = {
    slug,
    title: parsed.data.title,
    summary: parsed.data.summary,
    category: parsed.data.category,
    kind: parsed.data.kind,
  };
  if (dryRun) {
    console.log('dry-run: 画像APIは呼び出さず、記事も変更しません。\n');
    console.log('----- 1枚目（アイキャッチ）プロンプト -----\n');
    console.log(buildColumnImagePrompt(input));
    const insertion = findMidImageInsertion(body);
    if (insertion) {
      console.log('\n----- 2枚目（本文挿絵）プロンプト -----\n');
      console.log(buildColumnMidImagePrompt(input, insertion));
    } else {
      console.log('\n本文が短い、または見出しが少ないため2枚目の挿絵は生成しません。');
    }
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('.env に GEMINI_API_KEY を設定してください。');
  const ai = new GoogleGenAI({ apiKey });
  const result = await generateColumnImages(ai, input, body, PROJECT_ROOT);
  for (const warning of result.warnings) console.warn(`[Agent5:ImageQA] [WARN] ${warning}`);

  const frontmatterInsertion = `\n${imageFrontmatterLines(result).join('\n')}`;
  const beforeClosingFence = raw.slice(0, match.index! + match[0].length - 4);
  const updated = `${beforeClosingFence}${frontmatterInsertion}\n---\n\n${result.body.trim()}\n`;
  await writeFile(markdownPath, updated, 'utf-8');
  console.log(`画像を追加しました: ${path.relative(process.cwd(), markdownPath)}`);
  console.log(`1枚目原画: ${path.relative(process.cwd(), result.sourcePath)}`);
  if (result.midSourcePath) console.log(`2枚目原画: ${path.relative(process.cwd(), result.midSourcePath)}`);
}

main().catch((error) => {
  console.error('[generate-column-image] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
