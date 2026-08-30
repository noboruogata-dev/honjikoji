import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  alphaNoiseRatio,
  ALPHA_NOISE_RATIO_THRESHOLD,
  buildColumnImageAlt,
  buildColumnImagePrompt,
  buildColumnMidImageAlt,
  buildColumnMidImagePrompt,
  chooseColumnMotif,
  chooseMidImageMotif,
  findMidImageInsertion,
  inspectAlpha,
  insertMidImageMarkdown,
  hasRenderedTransparencyGrid,
  MIN_BODY_CHARS_FOR_MID_IMAGE,
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

function section(heading: string, chars: number): string {
  return `## ${heading}\n${'本'.repeat(chars)}`;
}

describe('findMidImageInsertion（2枚目挿絵の挿入位置）', () => {
  it('見出しが1つ以下ならnull（本文が十分長くても）', () => {
    const body = section('見出し1', 700);
    expect([...body].length).toBeGreaterThan(MIN_BODY_CHARS_FOR_MID_IMAGE);
    expect(findMidImageInsertion(body)).toBeNull();
  });

  it('本文がMIN_BODY_CHARS_FOR_MID_IMAGE字未満ならnull（見出しが2つあっても）', () => {
    const body = [section('見出し1', 30), section('見出し2', 30)].join('\n\n');
    expect([...body].length).toBeLessThan(MIN_BODY_CHARS_FOR_MID_IMAGE);
    expect(findMidImageInsertion(body)).toBeNull();
  });

  it('見出しが3つなら2つ目の見出し（＝最後から2番目）の直前に置く', () => {
    const body = [section('はじめに', 250), section('本論', 250), section('おわりに', 250)].join('\n\n');
    const insertion = findMidImageInsertion(body);
    expect(insertion).not.toBeNull();
    expect(body.trim().slice(insertion!.offset)).toMatch(/^## 本論/);
  });

  it('見出しが2つなら1つ目の見出しの直前に置く（最後の見出しの直前にはしない）', () => {
    const body = [section('はじめに', 350), section('おわりに', 350)].join('\n\n');
    const insertion = findMidImageInsertion(body);
    expect(insertion).not.toBeNull();
    expect(body.trim().slice(insertion!.offset)).toMatch(/^## はじめに/);
  });

  it('挿入位置の前後の文脈を返す', () => {
    const body = [section('はじめに', 250), section('本論', 250), section('おわりに', 250)].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    expect(insertion.contextBefore).toContain('はじめに');
    expect(insertion.contextAfter).toContain('本論');
  });
});

describe('insertMidImageMarkdown', () => {
  it('挿入位置の直前に空行区切りで画像行を挿む', () => {
    const body = [section('はじめに', 250), section('本論', 250), section('おわりに', 250)].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    const image = { src: '/images/columns/example-illust.webp', alt: '例の挿絵' };
    const updated = insertMidImageMarkdown(body, insertion, image);
    expect(updated).toContain('![例の挿絵](/images/columns/example-illust.webp)');
    expect(updated.indexOf('![例の挿絵]')).toBeLessThan(updated.indexOf('## 本論'));
    expect(updated.indexOf('## はじめに')).toBeLessThan(updated.indexOf('![例の挿絵]'));
    // 元の段落テキストは失われない。
    expect(updated).toContain(section('はじめに', 250));
    expect(updated).toContain(section('おわりに', 250));
  });
});

describe('buildColumnMidImagePrompt', () => {
  it('前後の文脈と画風ロックをプロンプトへ含める', () => {
    const body = [section('はじめに', 250), section('本論', 250), section('おわりに', 250)].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    const prompt = buildColumnMidImagePrompt(input, insertion);
    expect(prompt).toContain(insertion.contextBefore);
    expect(prompt).toContain(insertion.contextAfter);
    expect(prompt).toContain('transparent background');
    expect(prompt).toContain('#f2b544');
  });
});

describe('2枚目のモチーフ・alt（生成プロンプトの文脈から導出する）', () => {
  it('挿入位置前後の本文にキーワードがあれば、1枚目と同じ精度で具体的なモチーフを選ぶ', () => {
    const body = [
      `## 米と精米歩合\n${'精米歩合の話です。'.repeat(40)}`,
      `## 燗のつけ方\n${'燗酒の温度の話です。'.repeat(40)}`,
      `## まとめ\n${'まとめです。'.repeat(40)}`,
    ].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    // 挿入位置は「燗のつけ方」の直前＝contextAfterに「燗」を含む。
    expect(insertion.contextAfter).toContain('燗');
    expect(chooseMidImageMotif(input, insertion)).toContain('湯気');
    expect(buildColumnMidImageAlt(input, insertion)).toContain('湯気');
  });

  it('キーワードに一致しなければカテゴリ既定のモチーフにフォールバックする', () => {
    const body = [
      `## 器の選び方\n${'今夜の器を選ぶ話です。'.repeat(40)}`,
      `## お店での作法\n${'お店でのマナーの話です。'.repeat(40)}`,
      `## まとめ\n${'まとめです。'.repeat(40)}`,
    ].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    expect(chooseMidImageMotif(input, insertion)).toBe('一組の徳利と猪口');
  });

  it('altに記事タイトルと導いたモチーフの両方を含める（本文中盤で語られる情景、という説明にとどめない）', () => {
    const body = [section('米と精米歩合', 250), section('燗のつけ方', 250), section('まとめ', 250)].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    const alt = buildColumnMidImageAlt(input, insertion);
    expect(alt).toContain(input.title);
    expect(alt).not.toBe(`${input.title}の本文中盤で語られる情景を描いた和モダンな挿絵`);
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

  it('色は均一なままアルファだけがまだら状にノイズ化した背景を検出する（japanese-sake-label-rules-illust.webp事故の再現）', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        // 疑似乱数的に0/255付近を1px単位で往復させる（実物のディザリングを模す）。
        const pseudoRandom = (x * 37 + y * 17) % 5;
        pixels[offset + 3] = pseudoRandom < 2 ? 0 : 250;
      }
    }
    // 中央には正常な不透明の被写体（周辺と同じ白ではなく別色にして、
    // アルファノイズの検出が背景側で成立していることを確認する）。
    for (let y = 40; y < 60; y += 1) {
      for (let x = 40; x < 60; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 242;
        pixels[offset + 1] = 181;
        pixels[offset + 2] = 68;
        pixels[offset + 3] = 255;
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const ratio = await alphaNoiseRatio(png);
    expect(ratio).toBeGreaterThan(ALPHA_NOISE_RATIO_THRESHOLD);
  });

  it('黒に近い/中間の濃さの市松模様も検出する（min>120の下限撤廃の回帰テスト）', async () => {
    // japanese-sake-label-rules記事の事故画像で実測した濃さを再現する
    // （黒白: (20,20,20)/(255,255,255)、中間: (50,50,50)/(105,105,105)）。
    for (const [dark, light] of [
      [20, 255],
      [50, 105],
    ] as const) {
      const width = 100;
      const height = 100;
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const value = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0 ? light : dark;
          pixels[offset] = value;
          pixels[offset + 1] = value;
          pixels[offset + 2] = value;
          pixels[offset + 3] = 255;
        }
      }
      const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
      expect(await hasRenderedTransparencyGrid(png), `dark=${dark},light=${light}`).toBe(true);
    }
  });

  it('墨線＋生成り塗りの通常イラスト（黒を含む）はチェッカーと誤判定しない', async () => {
    // 透過背景の上に、生成り色の塗り＋墨色(#14110f相当)の輪郭線という
    // このサイトの実際の配色に近い図形を1つだけ置く。輪郭線は黒に近いが、
    // 市松模様のように画面の大部分を覆う訳ではない。
    const svg = `
      <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect x="60" y="60" width="80" height="80" rx="10" fill="#d8cbb8" stroke="#14110f" stroke-width="6"/>
      </svg>`;
    const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer();
    expect(await hasRenderedTransparencyGrid(png)).toBe(false);
  });

  it('通常の透過イラスト（滑らかな境界）はノイズと判定しない', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="40" height="40"><circle cx="20" cy="20" r="18" fill="#f2b544"/></svg>'), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const ratio = await alphaNoiseRatio(png);
    expect(ratio).toBeLessThan(ALPHA_NOISE_RATIO_THRESHOLD);
  });
});
