/**
 * scripts/instagram-draft.ts
 *
 * 既に公開済みの記事1件から、Instagram投稿素材を単体で作り直す。
 * scripts/lib/instagramMaterialAgent.ts は記事生成の成功直後にしか呼ばれない
 * ため、過去記事に対して実行する手段がなかった（コラムは週1本しか出ない
 * ため、過去記事から素材を作れると投稿ネタに困らない、という運用上の要望）。
 *
 * 使い方:
 *   npm run instagram:draft -- --type=column --slug=japanese-sake-label-rules
 *   npm run instagram:draft -- --type=spot --slug=bar-keywest
 *   npm run instagram:draft -- --type=news --slug=site-launch
 *   npm run instagram:draft -- --type=column --slug=xxx --dry-run
 *
 * --dry-run: Slackへは送らず、生成したキャプション・画像パスをコンソールに
 *   出力するだけにする。
 *
 * 正方形画像（public/images/instagram/<type>-<slug>-square.webp）が既に
 * あればそれを再利用し、新規の画像生成（satori+sharp）は行わない。無ければ
 * 生成する。
 *
 * 事前準備:
 *   .env に GEMINI_API_KEY を設定してください。
 *   Slackへ送るには .env に SLACK_WEBHOOK_URL も設定してください
 *   （未設定でも動作しますが、通知はスキップされます。--dry-runなら不要）。
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstagramCaptionAgent, type InstagramContentType } from './lib/instagram-caption.js';
import { checkGlyphCoverage, renderInstagramSquareImage } from './lib/ogpImage.js';
import { notifyInstagramMaterial } from './lib/slackNotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://honjikoji.jp';

const CONTENT_DIRS: Record<InstagramContentType, string> = {
  spot: path.join(PROJECT_ROOT, 'src/content/spots'),
  news: path.join(PROJECT_ROOT, 'src/content/news'),
  column: path.join(PROJECT_ROOT, 'src/content/columns'),
};

const CONTENT_LABELS: Record<InstagramContentType, string> = {
  spot: '店舗記事',
  news: 'お知らせ',
  column: 'コラム',
};

interface ParsedArgs {
  type: InstagramContentType;
  slug: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const getArg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);

  const type = getArg('type');
  const slug = getArg('slug');
  const dryRun = argv.includes('--dry-run');

  if (type !== 'spot' && type !== 'news' && type !== 'column') {
    throw new Error('--type=spot|news|column を指定してください。');
  }
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error('--slug=英小文字ケバブケース を指定してください。');
  }

  return { type, slug, dryRun };
}

interface LoadedContent {
  title: string;
  summary: string;
  body: string;
  imageLabel: string;
  urlPath: string;
}

/** frontmatterと本文を、raw Markdownから読み込む（他のgenerate-*.tsと同じ正規表現方式）。 */
async function readRaw(dir: string, slug: string): Promise<{ frontmatter: string; body: string }> {
  const filePath = path.join(dir, `${slug}.md`);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`記事が見つかりません: ${path.relative(PROJECT_ROOT, filePath)}`);
  }
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) throw new Error(`Frontmatterを読み取れません: ${path.relative(PROJECT_ROOT, filePath)}`);
  const body = raw.slice(match.index + match[0].length).replace(/^\n+/, '');
  return { frontmatter: match[1], body };
}

/** YAMLの `key: "value"` / `key: value` 行から値を1つだけ雑に抜き出す（js-yaml等を使わない簡易実装で十分な範囲のみ対象）。 */
function extractYamlString(frontmatter: string, key: string): string | undefined {
  const lineMatch = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter);
  if (!lineMatch) return undefined;
  const raw = lineMatch[1].trim();
  const quoted = /^"([\s\S]*)"$/.exec(raw);
  return quoted ? quoted[1].replace(/\\"/g, '"') : raw;
}

async function loadContent(type: InstagramContentType, slug: string): Promise<LoadedContent> {
  const dir = CONTENT_DIRS[type];
  const { frontmatter, body } = await readRaw(dir, slug);

  const title = extractYamlString(frontmatter, 'title');
  if (!title) throw new Error('titleを読み取れませんでした。');

  if (type === 'column') {
    const draft = extractYamlString(frontmatter, 'draft');
    if (draft === 'true') {
      throw new Error('下書き（draft: true）のコラムは対象外です。--publishで公開してから実行してください。');
    }
    const category = extractYamlString(frontmatter, 'category') || '本寺小路夜話';
    const summary = extractYamlString(frontmatter, 'summary') || '';
    return { title, summary, body, imageLabel: category, urlPath: `/columns/${slug}/` };
  }

  if (type === 'spot') {
    const genre = extractYamlString(frontmatter, 'genre');
    const summary = extractYamlString(frontmatter, 'description') || '';
    return {
      title,
      summary,
      body,
      imageLabel: genre ? `${genre} ／ 本寺小路` : '本寺小路',
      urlPath: `/spots/${slug}/`,
    };
  }

  // news
  const summary = extractYamlString(frontmatter, 'summary') || '';
  return { title, summary, body, imageLabel: 'お知らせ', urlPath: `/news/${slug}/` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('.env に GEMINI_API_KEY を設定してください。');
  }
  const ai = new GoogleGenAI({ apiKey });

  console.log('============================================================');
  console.log(` Instagram投稿素材 単体生成（--type=${args.type} --slug=${args.slug}${args.dryRun ? ' --dry-run' : ''}）`);
  console.log('============================================================');

  const content = await loadContent(args.type, args.slug);
  console.log(`[instagram-draft] 記事を読み込みました: 「${content.title}」`);

  console.log('[instagram-draft] Instagramキャプションを生成中...');
  const caption = await runInstagramCaptionAgent(ai, {
    type: args.type,
    title: content.title,
    summary: content.summary,
    body: content.body,
  });
  if (!caption) {
    throw new Error('キャプションの生成に失敗しました。ログを確認してください。');
  }
  console.log('[instagram-draft] キャプションを生成しました。');
  if (caption.lengthNote) {
    console.warn(`[instagram-draft] ⚠️ ${caption.lengthNote}`);
  }

  const imageDir = path.join(PROJECT_ROOT, 'public/images/instagram');
  const imageFileName = `${args.type}-${args.slug}-square.webp`;
  const imagePath = path.join(imageDir, imageFileName);

  if (existsSync(imagePath)) {
    console.log(`[instagram-draft] 正方形画像は既存のものを使います: ${path.relative(PROJECT_ROOT, imagePath)}`);
  } else {
    const missingChars = await checkGlyphCoverage({ type: args.type, title: content.title, label: content.imageLabel });
    if (missingChars.length > 0) {
      throw new Error(
        `タイトル/ラベルにフォントに無い文字が含まれるため、正方形画像を生成できません（該当文字: ${missingChars.join('')}）。scripts/assets/fonts/README.md を参照してください。`
      );
    }
    console.log('[instagram-draft] 正方形画像を生成中...');
    await mkdir(imageDir, { recursive: true });
    const imageBuffer = await renderInstagramSquareImage({ type: args.type, title: content.title, label: content.imageLabel });
    await writeFile(imagePath, imageBuffer);
    console.log(`[instagram-draft] 正方形画像を保存しました: ${path.relative(PROJECT_ROOT, imagePath)}`);
  }

  const articleUrl = `${SITE_URL}${content.urlPath}`;
  const imageUrl = `${SITE_URL}/images/instagram/${imageFileName}`;

  console.log('\n----- 投稿文面 -----\n');
  console.log(caption.fullText);
  console.log('\n----- 画像 -----\n');
  console.log(imageUrl);
  console.log('\n----- 記事URL -----\n');
  console.log(articleUrl);

  if (args.dryRun) {
    console.log('\n[instagram-draft] --dry-run のため、Slackへは送信しません。');
    return;
  }

  const result = await notifyInstagramMaterial({
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    contentLabel: CONTENT_LABELS[args.type],
    title: content.title,
    articleUrl,
    imageUrl,
    captionFullText: caption.fullText,
    lengthNote: caption.lengthNote,
  });

  if (result.sent) {
    console.log('\n[instagram-draft] Slackに通知しました。');
  } else if (result.reason === 'not-configured') {
    console.log('\n[instagram-draft] SLACK_WEBHOOK_URL が未設定のため、Slack通知はスキップされました。');
  } else {
    console.warn(`\n[instagram-draft] Slack通知に失敗しました（${result.reason}）。上記の文面・画像URLを手動で使ってください。`);
  }
}

main().catch((err) => {
  console.error('[instagram-draft] エラーが発生しました:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
