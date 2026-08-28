import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  buildColumnImageAlt,
  buildColumnImagePrompt,
  chooseColumnMotif,
  inspectAlpha,
  hasRenderedTransparencyGrid,
  needsBackgroundRemoval,
  removeConnectedBackground,
  removeRenderedTransparencyGrid,
  type ColumnImageInput,
} from './column-images';

const input: ColumnImageInput = {
  slug: 'kanzake',
  title: '燗酒の温度を楽しむ',
  summary: '温度によって変化する日本酒の味わいを紹介します。',
  category: 'お酒の豆知識',
  kind: 'standard',
};

describe('column image brief', () => {
  it('記事内容から決定論的にモチーフを選ぶ', () => {
    expect(chooseColumnMotif(input)).toContain('湯気');
    expect(buildColumnImageAlt(input)).toContain('燗酒の温度を楽しむ');
  });

  it('画風ロックと文字禁止をプロンプトへ含める', () => {
    const prompt = buildColumnImagePrompt(input);
    expect(prompt).toContain('transparent background');
    expect(prompt).toContain('no text');
    expect(prompt).toContain('#f2b544');
    expect(prompt).toContain('recognizable real person');
  });
});

describe('column image alpha QA', () => {
  it('透明率3〜5%の画像も背景除去へ送る', () => {
    expect(needsBackgroundRemoval(0.038)).toBe(true);
    expect(needsBackgroundRemoval(0.05)).toBe(false);
  });

  it('透明ピクセル率を計測する', async () => {
    const rgba = Buffer.from([
      255, 0, 0, 0,
      255, 0, 0, 255,
      255, 0, 0, 0,
      255, 0, 0, 255,
    ]);
    const png = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    const stats = await inspectAlpha(png);
    expect(stats.hasAlpha).toBe(true);
    expect(stats.transparentRatio).toBe(0.5);
  });

  it('外周につながる単色背景だけを透明化する', async () => {
    const source = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#f2ece3' },
    })
      .composite([
        {
          input: Buffer.from('<svg width="4" height="4"><rect width="4" height="4" fill="#c8412f"/></svg>'),
          left: 3,
          top: 3,
        },
      ])
      .png()
      .toBuffer();
    const cleaned = await removeConnectedBackground(source);
    const stats = await inspectAlpha(cleaned);
    const center = await sharp(cleaned).extract({ left: 4, top: 4, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
    expect(stats.transparentRatio).toBeGreaterThan(0.7);
    expect(center[3]).toBe(255);
  });

  it('画素として描かれた透過チェッカー模様を拒否する', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const value = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0 ? 245 : 160;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 255;
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    expect(await hasRenderedTransparencyGrid(png)).toBe(true);
  });

  it('通常の透過イラストをチェッカーと誤判定しない', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="40" height="40"><circle cx="20" cy="20" r="18" fill="#f2b544"/></svg>'), left: 30, top: 30 }])
      .png()
      .toBuffer();
    expect(await hasRenderedTransparencyGrid(png)).toBe(false);
  });

  it('半透明の無彩色チェッカーを検出して除去する', async () => {
    const width = 20;
    const height = 20;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 230 : 180;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
        pixels[offset + 3] = 160;
      }
    }
    // 中央の不透明な朱色の絵柄は残す。
    const center = (10 * width + 10) * 4;
    pixels.set([200, 65, 47, 255], center);
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    expect(await hasRenderedTransparencyGrid(png)).toBe(true);

    const cleaned = await removeRenderedTransparencyGrid(png);
    const raw = await sharp(cleaned).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
    expect(raw[center + 3]).toBe(255);
    expect(await hasRenderedTransparencyGrid(cleaned)).toBe(false);
  });
});
