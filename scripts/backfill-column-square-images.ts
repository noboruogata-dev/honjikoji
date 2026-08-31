/**
 * scripts/backfill-column-square-images.ts
 *
 * 既存のコラム記事に、Instagram投稿用スクエア画像（1080x1080、
 * public/images/columns/<slug>-square.webp）を後付けする。
 *
 * eyecatchと同じ透過ソース（assets-src/columns/<slug>-source.png）から
 * 切り出すため、新たな画像生成APIコールは発生しない。ただし
 * assets-src/ はGit管理外（.gitignore）で生成直後のジョブでしか
 * 存在しないため、ソースが見つからない記事はスキップする（別の画像を
 * 代用したりはしない）。既存のスクエア画像は上書きしない。
 *
 * 使い方:
 *   npm run backfill:column-square-images -- --backfill
 *   npm run backfill:column-square-images -- --backfill --slug=<slug>
 *   npm run backfill:column-square-images -- --backfill --dry-run
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendStepSummary, readFrontmatter } from './lib/gemini-agents.js';
import { createSquareImage, MAX_PUBLIC_IMAGE_BYTES } from './lib/column-images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COLUMNS_DIR = path.join(PROJECT_ROOT, 'src/content/columns');
const SOURCE_DIR = path.join(PROJECT_ROOT, 'assets-src/columns');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public/images/columns');

type SkipReason = 'draft' | 'no-eyecatch' | 'already-exists' | 'no-source';

interface ItemResult {
  slug: string;
  status: 'generated' | 'skipped' | 'failed';
  reason?: SkipReason;
  detail?: string;
  bytes?: number;
}

function reasonLabel(reason: SkipReason): string {
  switch (reason) {
    case 'draft':
      return '下書きのため対象外';
    case 'no-eyecatch':
      return 'eyecatchが無いため対象外（切り出し元がない）';
    case 'already-exists':
      return '既にスクエア画像があるため上書きしない';
    case 'no-source':
      return `透過ソース（${path.relative(PROJECT_ROOT, SOURCE_DIR)}/<slug>-source.png）が見つからない（生成直後のジョブでしか残らないため）`;
  }
}

async function listSlugs(onlySlug: string | undefined): Promise<string[]> {
  if (onlySlug) return [onlySlug];
  const files = await readdir(COLUMNS_DIR);
  return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--backfill')) {
    console.log('何もしません。実行するには --backfill を指定してください。');
    console.log('  npm run backfill:column-square-images -- --backfill');
    console.log('  npm run backfill:column-square-images -- --backfill --slug=<slug>');
    console.log('  npm run backfill:column-square-images -- --backfill --dry-run');
    return;
  }
  const dryRun = args.includes('--dry-run');
  const onlySlug = args.find((a) => a.startsWith('--slug='))?.slice('--slug='.length);

  await mkdir(PUBLIC_DIR, { recursive: true });

  const slugs = await listSlugs(onlySlug);
  const results: ItemResult[] = [];

  for (const slug of slugs) {
    const fm = await readFrontmatter(COLUMNS_DIR, slug);
    if (!fm) {
      results.push({ slug, status: 'failed', detail: 'frontmatterを読めませんでした' });
      continue;
    }
    if (fm.draft === true) {
      results.push({ slug, status: 'skipped', reason: 'draft' });
      continue;
    }
    const eyecatch = fm.eyecatch as { alt?: unknown } | undefined;
    if (!eyecatch || typeof eyecatch.alt !== 'string') {
      results.push({ slug, status: 'skipped', reason: 'no-eyecatch' });
      continue;
    }

    const squarePath = path.join(PUBLIC_DIR, `${slug}-square.webp`);
    if (existsSync(squarePath)) {
      results.push({ slug, status: 'skipped', reason: 'already-exists' });
      continue;
    }

    const sourcePath = path.join(SOURCE_DIR, `${slug}-source.png`);
    if (!existsSync(sourcePath)) {
      results.push({ slug, status: 'skipped', reason: 'no-source' });
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] ${slug}: 生成予定（ソース: ${path.relative(PROJECT_ROOT, sourcePath)}）`);
      results.push({ slug, status: 'generated', bytes: 0 });
      continue;
    }

    try {
      const source = await readFile(sourcePath);
      const square = await createSquareImage(source);
      await writeFile(squarePath, square);
      results.push({ slug, status: 'generated', bytes: square.length });
      const warn = square.length > MAX_PUBLIC_IMAGE_BYTES ? `（200KB超: ${Math.ceil(square.length / 1024)}KB）` : '';
      console.log(`${slug}: 生成しました（${Math.ceil(square.length / 1024)}KB）${warn}`);
    } catch (error) {
      results.push({ slug, status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const generated = results.filter((r) => r.status === 'generated');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');

  console.log('\n============================================================');
  console.log(
    ` 完了: 対象${results.length}件中、生成${generated.length}件・スキップ${skipped.length}件・失敗${failed.length}件${dryRun ? '（dry-run）' : ''}`
  );
  for (const r of results) {
    if (r.status === 'skipped') console.log(`  - ${r.slug}: スキップ（${reasonLabel(r.reason!)}）`);
    else if (r.status === 'failed') console.log(`  - ${r.slug}: 失敗（${r.detail}）`);
  }
  console.log('============================================================');

  await appendStepSummary(
    [
      '## 🖼️ コラム スクエア画像バックフィル',
      '',
      `対象${results.length}件中、生成${generated.length}件・スキップ${skipped.length}件・失敗${failed.length}件${dryRun ? '（dry-run）' : ''}`,
      '',
      ...results.map((r) =>
        r.status === 'generated'
          ? `- ${r.slug}: 生成${dryRun ? '予定' : `（${Math.ceil((r.bytes ?? 0) / 1024)}KB）`}`
          : r.status === 'skipped'
            ? `- ${r.slug}: スキップ（${reasonLabel(r.reason!)}）`
            : `- ${r.slug}: 失敗（${r.detail}）`
      ),
    ].join('\n')
  );
}

main().catch((error) => {
  console.error('[backfill-column-square-images] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
