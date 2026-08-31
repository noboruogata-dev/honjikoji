import { describe, expect, it } from 'vitest';
import { buildColumnInstagramCaption } from './column-instagram-caption';

describe('buildColumnInstagramCaption', () => {
  it('title・summaryをそのまま渡し、slugからURLを機械的に組み立てる', () => {
    const data = buildColumnInstagramCaption({
      slug: 'sake-kanzake-temperature-names',
      title: '燗酒の温度帯と名前とは？知っておきたい日本酒の楽しみ方',
      summary: '日本酒は5℃程度の冷酒から55℃以上まで温度によって味わいが変化します。',
    });
    expect(data.title).toBe('燗酒の温度帯と名前とは？知っておきたい日本酒の楽しみ方');
    expect(data.summary).toBe('日本酒は5℃程度の冷酒から55℃以上まで温度によって味わいが変化します。');
    expect(data.url).toBe('https://honjikoji.jp/columns/sake-kanzake-temperature-names/');
  });
});
