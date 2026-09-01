import { describe, expect, it } from 'vitest';
import { checkGlyphCoverage, wrapJapaneseTitle } from './ogpImage';

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

describe('wrapJapaneseTitle', () => {
  it('実際に報告された長いタイトルを、「？」の直後で自然に2行へ折り返す', () => {
    const lines = wrapJapaneseTitle('日本酒のラベルの見方とは？特定名称酒のルールと選び方の基本', 17);
    expect(lines).toEqual(['日本酒のラベルの見方とは？', '特定名称酒のルールと選び方の基本']);
  });

  it('maxCharsPerLineに収まる短いタイトルは1行のまま', () => {
    expect(wrapJapaneseTitle('天婦羅割烹 みや嶋', 9)).toEqual(['天婦羅割烹 みや嶋']);
  });

  it('句読点が無い場合は文字数で機械的に折り返す', () => {
    const lines = wrapJapaneseTitle('あいうえおかきくけこ', 5);
    expect(lines).toEqual(['あいうえお', 'かきくけこ']);
  });

  it('行頭に句読点・閉じ括弧が来ないようにする（禁則処理）', () => {
    // 素朴に5文字で切ると6文字目の「、」が次行の先頭に来てしまうため、
    // 「、」を前の行に含めて回避する。
    const lines = wrapJapaneseTitle('あいうえお、かきくけ', 5);
    for (const line of lines) {
      expect(line.startsWith('、')).toBe(false);
    }
    expect(lines[0]).toBe('あいうえお、');
  });

  it('助詞（と・の・で・を）の直後で終わる行はできるだけ避ける', () => {
    // 句読点が無く、maxCharsPerLine位置がちょうど助詞の直後になるケース。
    const lines = wrapJapaneseTitle('あいうえとかきくけこ', 5);
    expect(lines[0].endsWith('と')).toBe(false);
  });
});
