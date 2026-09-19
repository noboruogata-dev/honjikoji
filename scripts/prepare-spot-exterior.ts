/**
 * scripts/prepare-spot-exterior.ts
 *
 * design-assets/spots/<slug>.png（design-assets/は.gitignore対象。手元に
 * 置いた元イラストはリポジトリにはコミットしない）を最適化し、
 * public/images/spots/<slug>.png として書き出す（こちらはコミット対象。
 * 詳細ページはsrc/lib/spotExterior.tsがこのファイルの実在を見て表示可否を
 * 決める）。処理の実体はscripts/lib/spotExteriorImage.ts参照。
 *
 * 使い方:
 *   npm run spots:exterior                    # design-assets/spots/ 配下を全件処理
 *   npm run spots:exterior -- taisyu-yakiniku-sankiraku  # 1件だけ処理
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSpotExteriorImage, MAX_EXTERIOR_IMAGE_BYTES } from './lib/spotExteriorImage.js';

const SOURCE_DIR = path.resolve('design-assets/spots');
const OUTPUT_DIR = path.resolve('public/images/spots');

async function processOne(slug: string): Promise<void> {
  const sourcePath = path.join(SOURCE_DIR, `${slug}.png`);
  const source = await readFile(sourcePath);
  const output = await buildSpotExteriorImage(source);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${slug}.png`);
  await writeFile(outPath, output);
  const kb = (output.length / 1024).toFixed(1);
  console.log(`[spot-exterior] ${slug}: ${kb}KB -> ${path.relative(process.cwd(), outPath)}`);
  if (output.length > MAX_EXTERIOR_IMAGE_BYTES) {
    console.warn(`[spot-exterior] 警告: ${slug} が目標の200KBを超えています（${kb}KB）。`);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg) {
    await processOne(arg);
    return;
  }
  let files: string[];
  try {
    files = await readdir(SOURCE_DIR);
  } catch {
    console.log(`[spot-exterior] ${path.relative(process.cwd(), SOURCE_DIR)} が見つかりません。処理対象なし。`);
    return;
  }
  const slugs = files.filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
  if (slugs.length === 0) {
    console.log('[spot-exterior] design-assets/spots/ にPNGがありません。処理対象なし。');
    return;
  }
  for (const slug of slugs) {
    await processOne(slug);
  }
}

main().catch((error) => {
  console.error('[spot-exterior] 失敗:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
