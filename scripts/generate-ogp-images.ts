/**
 * scripts/generate-ogp-images.ts
 *
 * 店舗（src/content/spots）・コラム（src/content/columns、draft除く）・
 * ニュース（src/content/news）ごとに、OGP画像（1200×630 PNG）を
 * public/images/ogp/ へ生成する。LLM不使用、satori+sharp（決定論的）。
 *
 * npm run build 実行時に prebuild フックとして自動実行される
 * （package.json参照）。astro:content はAstroのビルドパイプライン内でしか
 * 解決できない仮想モジュールのため、他の generate-*.ts スクリプトと同様に
 * 生Markdownのfrontmatterを直接パースする。
 *
 * キャッシュ: ogp-image-cache.json（リポジトリルート）に
 * `"${type}-${slug}": "<画像に影響する項目のハッシュ>"` を保存し、前回から
 * 変化が無いキー（かつ画像ファイルが実際に存在する）はスキップする。
 * 記事が増えても、実際に変化した分だけしか再生成しないため、ビルド時間が
 * 記事数に比例して線形に伸び続けることを防ぐ。
 *
 * 使い方:
 *   npm run generate:ogp-images
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { appendStepSummary, readFrontmatter } from './lib/gemini-agents.js';
import { renderOgpImage, type OgpContentType } from './lib/ogpImage.js';
import { GUIDES } from '../src/lib/guides.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SPOTS_DIR = path.join(PROJECT_ROOT, 'src/content/spots');
const NEWS_DIR = path.join(PROJECT_ROOT, 'src/content/news');
const COLUMNS_DIR = path.join(PROJECT_ROOT, 'src/content/columns');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'public/images/ogp');
const CACHE_PATH = path.join(PROJECT_ROOT, 'ogp-image-cache.json');

interface ContentItem {
  type: OgpContentType;
  slug: string;
  title: string;
  label: string;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
}

async function collectSpots(): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  for (const file of await listMarkdownFiles(SPOTS_DIR)) {
    const slug = file.replace(/\.md$/, '');
    const fm = await readFrontmatter(SPOTS_DIR, slug);
    const title = typeof fm?.title === 'string' ? fm.title : '';
    if (!title) continue;
    const genre = typeof fm?.genre === 'string' ? fm.genre : '';
    // エリア表記は住所文字列のパースに頼らず、サイト全体で不変の固定値にする
    // （誤って別のエリアを名乗るリスクを避けるため）。
    items.push({ type: 'spot', slug, title, label: genre ? `${genre} ／ 本寺小路` : '本寺小路' });
  }
  return items;
}

async function collectNews(): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  for (const file of await listMarkdownFiles(NEWS_DIR)) {
    const slug = file.replace(/\.md$/, '');
    const fm = await readFrontmatter(NEWS_DIR, slug);
    const title = typeof fm?.title === 'string' ? fm.title : '';
    if (!title) continue;
    // デザイン仕様上、ニュースのラベルはcategoryではなく固定文言「お知らせ」。
    items.push({ type: 'news', slug, title, label: 'お知らせ' });
  }
  return items;
}

async function collectColumns(): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  for (const file of await listMarkdownFiles(COLUMNS_DIR)) {
    const slug = file.replace(/\.md$/, '');
    const fm = await readFrontmatter(COLUMNS_DIR, slug);
    // draftのコラムはページ自体が生成されない（columns/[...slug].astroの
    // getStaticPathsが!data.draftで絞っている）ため、画像生成も対象外にする
    // （無駄な生成を避ける）。
    if (fm?.draft === true) continue;
    const title = typeof fm?.title === 'string' ? fm.title : '';
    if (!title) continue;
    const category = typeof fm?.category === 'string' ? fm.category : '';
    items.push({ type: 'column', slug, title, label: category || '本寺小路夜話' });
  }
  return items;
}

// テーマ別まとめページ（/guides/<slug>/）はmarkdownファイルを持たず、
// src/lib/guides.tsのコード上の定義がそのまま情報源になる。frontmatter読み込みは不要。
function collectGuides(): ContentItem[] {
  return GUIDES.map((guide) => ({ type: 'guide', slug: guide.slug, title: guide.title, label: 'テーマガイド' }));
}

function cacheKey(item: ContentItem): string {
  return `${item.type}-${item.slug}`;
}

/** 画像の見た目に影響する項目だけをハッシュ化する（本文等の変更では再生成しない）。 */
function computeHash(item: ContentItem): string {
  const payload = JSON.stringify({ type: item.type, title: item.title, label: item.label });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

type ItemStatus = 'generated' | 'skipped-cached' | 'failed';

interface ItemResult {
  key: string;
  status: ItemStatus;
  detail?: string;
  bytes?: number;
}

function summaryLine(result: ItemResult): string {
  switch (result.status) {
    case 'generated':
      return `生成しました（${result.bytes}バイト）`;
    case 'skipped-cached':
      return 'キャッシュのためスキップしました（元データに変更なし）';
    case 'failed':
      return `生成に失敗しました（${result.detail}）。ページはogp-default.pngにフォールバックします`;
  }
}

async function main() {
  const t0 = performance.now();

  await mkdir(OUTPUT_DIR, { recursive: true });

  let cache: Record<string, string> = {};
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
    } catch {
      console.warn('[generate-ogp-images] ogp-image-cache.json の解析に失敗しました。キャッシュ無しで続行します。');
      cache = {};
    }
  }

  const items = [...(await collectSpots()), ...(await collectNews()), ...(await collectColumns()), ...collectGuides()];
  console.log(`[generate-ogp-images] 対象: 店舗/コラム/ニュース 計${items.length}件`);

  const results: ItemResult[] = [];
  const newCache: Record<string, string> = {};

  for (const item of items) {
    const key = cacheKey(item);
    const hash = computeHash(item);
    const outPath = path.join(OUTPUT_DIR, `${key}.png`);

    if (cache[key] === hash && existsSync(outPath)) {
      newCache[key] = hash;
      results.push({ key, status: 'skipped-cached' });
      continue;
    }

    try {
      const png = await renderOgpImage({ type: item.type, title: item.title, label: item.label });
      await writeFile(outPath, png);
      newCache[key] = hash;
      results.push({ key, status: 'generated', bytes: png.length });
    } catch (err) {
      // 生成失敗時は（ハッシュ変更前の）古い画像を残さない。タイトルと
      // 画像が食い違ったまま公開されるより、ページ側がogp-default.pngへ
      // フォールバックする方が安全なため。
      if (existsSync(outPath)) {
        await rm(outPath).catch(() => {});
      }
      results.push({ key, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // 記事削除などで対象から外れたキーの画像・キャッシュエントリを掃除する。
  const currentKeys = new Set(items.map(cacheKey));
  let removed = 0;
  for (const oldKey of Object.keys(cache)) {
    if (currentKeys.has(oldKey)) continue;
    const stalePath = path.join(OUTPUT_DIR, `${oldKey}.png`);
    if (existsSync(stalePath)) {
      await rm(stalePath).catch(() => {});
      removed += 1;
    }
  }

  await writeFile(CACHE_PATH, `${JSON.stringify(newCache, null, 2)}\n`, 'utf-8');

  const generated = results.filter((r) => r.status === 'generated');
  const skipped = results.filter((r) => r.status === 'skipped-cached');
  const failed = results.filter((r) => r.status === 'failed');
  const elapsedMs = performance.now() - t0;
  const totalBytes = generated.reduce((sum, r) => sum + (r.bytes ?? 0), 0);

  console.log('\n============================================================');
  console.log(
    ` 完了: 対象${items.length}件中、生成${generated.length}件・キャッシュ利用${skipped.length}件・失敗${failed.length}件` +
      (removed > 0 ? `（不要になった画像${removed}件を削除）` : '')
  );
  console.log(` 所要時間: ${(elapsedMs / 1000).toFixed(2)}秒 / 新規生成分の合計サイズ: ${(totalBytes / 1024).toFixed(1)}KB`);
  for (const result of results) {
    console.log(`  - ${result.key}: ${summaryLine(result)}`);
  }
  console.log('============================================================');

  if (failed.length > 0) {
    for (const result of failed) {
      console.warn(`[generate-ogp-images] ${result.key} の生成に失敗しました: ${result.detail}`);
    }
  }

  await appendStepSummary(
    [
      '## 🖼️ 本寺小路ガイド OGP画像生成',
      '',
      `対象${items.length}件中、生成${generated.length}件・キャッシュ利用${skipped.length}件・失敗${failed.length}件`,
      `所要時間: ${(elapsedMs / 1000).toFixed(2)}秒`,
      '',
      ...results.map((r) => `- ${r.key}: ${summaryLine(r)}`),
    ].join('\n')
  );
}

main().catch((err) => {
  // このスクリプトは npm run build の prebuild フックとして動く。個別記事
  // 単位の失敗は既にループ内でcatchしてogp-default.pngへのフォールバックに
  // 倒しているため、ここに来るのはmkdir/cache読み書き等の想定外の
  // スクリプト自体の異常のみ。OGP画像は「無くてもogp-default.pngで動作は
  // 破綻しない」機能なので、exit code 1でastro build自体を止めてしまう
  // （＝サイト全体のデプロイが止まる）よりは、目立つ形でエラーを出力した
  // 上でビルドは続行させる方が安全と判断した。
  console.error(
    '[generate-ogp-images] 予期しないエラーが発生しました（ビルド自体は続行します。全ページがogp-default.pngにフォールバックします）:',
    err instanceof Error ? err.message : err
  );
});
