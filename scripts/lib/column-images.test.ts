import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_COLOR_TOLERANCE,
  backgroundColorDistance,
  buildColumnImageAlt,
  buildColumnImagePrompt,
  buildColumnMidImageAlt,
  buildColumnMidImagePrompt,
  chooseColumnMotif,
  chooseMidImageMotif,
  createFeedImage,
  findMidImageInsertion,
  insertMidImageMarkdown,
  MAX_PUBLIC_IMAGE_BYTES,
  MIN_BODY_CHARS_FOR_MID_IMAGE,
  sourceFileExtension,
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
    expect(prompt).toContain('#14110f');
    expect(prompt).toContain('flat background');
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
    expect(prompt).toContain('#14110f');
    expect(prompt).toContain('#f2b544');
  });
});

describe('createFeedImage（Instagram投稿用フィード画像）', () => {
  it('1080x1350（4:5）・不透明（背景を敷いた合成物）・200KB以下のwebpを作る', async () => {
    const source = await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="90" fill="#f2b544"/></svg>'), left: 150, top: 150 }])
      .png()
      .toBuffer();
    const feed = await createFeedImage(source, 'お酒の豆知識');
    const meta = await sharp(feed).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(meta.hasAlpha).toBe(false); // 背景が敷かれた不透明な合成物であること（透過のまま投稿すると潰れるため）。
    expect(feed.length).toBeLessThanOrEqual(MAX_PUBLIC_IMAGE_BYTES);
  });

  it('カテゴリ名・サイト名ラベル分の余白を除いても、被写体の周囲に十分な余白が残る（左右）', async () => {
    // 500x500の円を被写体として、フィード画像の左端付近が背景色
    // （被写体で埋まっていない）であることを確認する。
    const source = await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="500" height="500"><circle cx="250" cy="250" r="240" fill="#f2b544"/></svg>') }])
      .png()
      .toBuffer();
    const feed = await createFeedImage(source, 'お酒の豆知識');
    const { data, info } = await sharp(feed).raw().toBuffer({ resolveWithObject: true });
    const y = Math.floor(info.height / 2);
    const leftEdgeOffset = (y * info.width + 5) * 3;
    // 被写体の明るい色(#f2b544系)ではなく、背景の暗色(#14110f系)に近いはず。
    expect(data[leftEdgeOffset]).toBeLessThan(60);
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

describe('backgroundColorDistance（背景色QA）', () => {
  it('四隅が指示通りTARGET_BACKGROUND_RGB(#14110f)なら距離0に近い', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#14110f' } })
      .composite([{ input: Buffer.from('<svg width="40" height="40"><circle cx="20" cy="20" r="18" fill="#f2b544"/></svg>'), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const distance = await backgroundColorDistance(png);
    expect(distance).toBeLessThan(BACKGROUND_COLOR_TOLERANCE);
  });

  it('四隅が指示された背景色から大きく外れていれば距離が閾値を超える', async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#f2ece3' } }).png().toBuffer();
    const distance = await backgroundColorDistance(png);
    expect(distance).toBeGreaterThan(BACKGROUND_COLOR_TOLERANCE);
  });

  it('1箇所でも外れていれば検出する（4隅の最大値を返す）', async () => {
    const width = 100;
    const height = 100;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      pixels[i * 3] = 0x14;
      pixels[i * 3 + 1] = 0x11;
      pixels[i * 3 + 2] = 0x0f;
    }
    // 右下角だけ大きく外れた色にする。
    const bottomRight = (height * width - 1) * 3;
    pixels.set([0xf2, 0xec, 0xe3], bottomRight);
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const distance = await backgroundColorDistance(png);
    expect(distance).toBeGreaterThan(BACKGROUND_COLOR_TOLERANCE);
  });
});

describe('sourceFileExtension', () => {
  it('JPEGバッファならjpegを返す', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#14110f' } }).jpeg().toBuffer();
    expect(await sourceFileExtension(jpeg)).toBe('jpeg');
  });

  it('PNGバッファならpngを返す', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#14110f' } }).png().toBuffer();
    expect(await sourceFileExtension(png)).toBe('png');
  });
});
