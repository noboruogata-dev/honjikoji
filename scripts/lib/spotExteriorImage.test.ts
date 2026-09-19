import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildSpotExteriorImage, dechecker, MAX_EXTERIOR_IMAGE_BYTES, SPOT_EXTERIOR_MAX_DIMENSION } from './spotExteriorImage';

/** 市松模様(彩度ほぼ0)＋線(彩度が高い着色)の最小サンプル画像を作る。 */
async function makeCheckeredFixture(): Promise<Buffer> {
  const size = 40;
  // 左半分: 市松模様相当の無彩色グレー2色。右半分: 彩度の高い線色（生成り寄りのクリーム色）。
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${size / 2}" height="${size}" fill="rgb(193,193,193)" />
    <rect x="${size / 2}" y="0" width="${size / 2}" height="${size}" fill="rgb(230,210,180)" />
  </svg>`;
  return sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).png().toBuffer();
}

describe('dechecker', () => {
  it('無彩色（市松模様相当）の領域を透過にする', async () => {
    const fixture = await makeCheckeredFixture();
    const out = await dechecker(fixture);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    // 左半分（無彩色）の中央付近のピクセルはアルファ0のはず。
    const grayPixelIndex = (10 * width + 5) * channels;
    expect(data[grayPixelIndex + 3]).toBe(0);
  });

  it('彩度の高い領域（線画の色）は不透明のまま保つ', async () => {
    const fixture = await makeCheckeredFixture();
    const out = await dechecker(fixture);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    // 右半分（彩度が高いクリーム色）の中央付近のピクセルはアルファ255のはず。
    const colorPixelIndex = (10 * width + 30) * channels;
    expect(data[colorPixelIndex + 3]).toBe(255);
  });

  it('出力の色そのものは変えない（アルファだけを付与する）', async () => {
    const fixture = await makeCheckeredFixture();
    const out = await dechecker(fixture);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    const colorPixelIndex = (10 * width + 30) * channels;
    expect([data[colorPixelIndex], data[colorPixelIndex + 1], data[colorPixelIndex + 2]]).toEqual([230, 210, 180]);
  });
});

describe('buildSpotExteriorImage', () => {
  it('アルファチャンネルが無い画像はdecheckerを通してから処理する（市松模様が透過になる）', async () => {
    const fixture = await makeCheckeredFixture();
    const meta = await sharp(fixture).metadata();
    expect(meta.hasAlpha).toBe(false);

    const out = await buildSpotExteriorImage(fixture);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.hasAlpha).toBe(true);

    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    const grayPixelIndex = (10 * width + 5) * channels;
    expect(data[grayPixelIndex + 3]).toBe(0);
  });

  it('既にアルファチャンネルを持つ画像はdecheckerをスキップし、透明部分をそのまま保つ', async () => {
    const size = 40;
    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${size / 2}" height="${size}" fill="rgb(120,120,120)" fill-opacity="1" />
    </svg>`;
    // 右半分は透明のまま（矩形を描かない）。左半分は無彩色だが不透明＝decheckerが動けば
    // 誤って透過してしまう色を意図的に選んでいる。
    const fixture = await sharp(Buffer.from(svg)).png().toBuffer();
    const meta = await sharp(fixture).metadata();
    expect(meta.hasAlpha).toBe(true);

    const out = await buildSpotExteriorImage(fixture);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = info;
    // 左半分（無彩色だが元々不透明）: decheckerがスキップされていれば不透明のまま。
    const leftIndex = (10 * width + 5) * channels;
    expect(data[leftIndex + 3]).toBe(255);
  });

  it('長辺をSPOT_EXTERIOR_MAX_DIMENSION以下にリサイズする', async () => {
    const large = await sharp({
      create: { width: 1254, height: 1254, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await buildSpotExteriorImage(large);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBeLessThanOrEqual(SPOT_EXTERIOR_MAX_DIMENSION);
    expect(outMeta.height).toBeLessThanOrEqual(SPOT_EXTERIOR_MAX_DIMENSION);
  });

  it('小さい画像は拡大しない', async () => {
    const small = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await buildSpotExteriorImage(small);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBe(100);
    expect(outMeta.height).toBe(100);
  });
});

describe('MAX_EXTERIOR_IMAGE_BYTES', () => {
  it('200KBに設定されている', () => {
    expect(MAX_EXTERIOR_IMAGE_BYTES).toBe(200 * 1024);
  });
});
