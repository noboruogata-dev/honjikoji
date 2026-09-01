import { describe, expect, it } from 'vitest';
import { checkGlyphCoverage } from './ogpImage';

describe('checkGlyphCoverage', () => {
  it('JIS X 0208範囲の常用漢字外の文字（旧字体・人名用漢字）も検出できる文字として扱う', async () => {
    // 「烹」「嶋」は常用漢字外だが、拡張後のサブセット（JIS X 0208全域）には含まれる。
    const missing = await checkGlyphCoverage({ type: 'spot', title: '天婦羅割烹 みや嶋', label: '割烹 ／ 本寺小路' });
    expect(missing).toEqual([]);
  });

  it('フォントに存在しない文字（絵文字等）を欠字として検出する', async () => {
    const missing = await checkGlyphCoverage({ type: 'spot', title: '居酒屋😀', label: '本寺小路' });
    expect(missing).toContain('😀');
  });

  it('空白は欠字として扱わない', async () => {
    const missing = await checkGlyphCoverage({ type: 'spot', title: '本寺小路 ガイド', label: 'テスト' });
    expect(missing).toEqual([]);
  });
});
