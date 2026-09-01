import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveInstagramFeedImage } from './instagramFeedImage';

describe('resolveInstagramFeedImage', () => {
  let projectRoot: string;

  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
  });

  it('type=columnで既存のコラムイラスト画像があれば最優先で使う（文字ベース画像は生成しない）', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'instagram-feed-'));
    const columnsDir = path.join(projectRoot, 'public/images/columns');
    await mkdir(columnsDir, { recursive: true });
    await writeFile(path.join(columnsDir, 'my-column-feed.webp'), Buffer.from('dummy'));

    const result = await resolveInstagramFeedImage({
      type: 'column',
      slug: 'my-column',
      title: 'テストコラム',
      imageLabel: 'お酒の豆知識',
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('column-illustration');
    expect(result.imageUrl).toBe('https://honjikoji.jp/images/columns/my-column-feed.webp');

    // 文字ベース画像側（public/images/instagram/）には何も作られていないこと。
    const instagramDir = path.join(projectRoot, 'public/images/instagram');
    await expect(rm(instagramDir, { recursive: false })).rejects.toThrow();
  });

  it('type=columnでコラムイラスト画像が無ければ文字ベース画像を生成する', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'instagram-feed-'));

    const result = await resolveInstagramFeedImage({
      type: 'column',
      slug: 'no-illustration-column',
      title: 'テストコラム',
      imageLabel: 'お酒の豆知識',
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('generated');
    expect(result.imageUrl).toBe(
      'https://honjikoji.jp/images/instagram/column-no-illustration-column-feed.webp'
    );
  }, 20000);

  it('type=spotは既存があれば再利用し、無ければ生成する', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'instagram-feed-'));
    const instagramDir = path.join(projectRoot, 'public/images/instagram');
    await mkdir(instagramDir, { recursive: true });
    await writeFile(path.join(instagramDir, 'spot-my-spot-feed.webp'), Buffer.from('dummy'));

    const result = await resolveInstagramFeedImage({
      type: 'spot',
      slug: 'my-spot',
      title: 'テスト店舗',
      imageLabel: '本寺小路',
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('existing-generated');
  });
});
