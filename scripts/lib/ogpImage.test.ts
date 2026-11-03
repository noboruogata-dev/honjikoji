import { describe, expect, it } from 'vitest';
import { checkGlyphCoverage, fitFeedTitle } from './ogpImage';

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

describe('fitFeedTitle', () => {
  // 実際に公開したタイトルで、以前の文字数基準の改行が不自然だったもの。
  it.each([
    ['毎月第1金曜はホンジの日！11/6に飲み歩き「連れられホンジ」開催', ['毎月第1金曜はホンジの日！', '11/6に飲み歩き', '「連れられホンジ」開催']],
    ['一ノ木戸商店街で「ちいさな芸術祭」初開催！11月1日から', ['一ノ木戸商店街で', '「ちいさな芸術祭」初開催！', '11月1日から']],
    ['GALLERY yuで猫作品展「にゃんこジャック」が10月16日より開催', ['GALLERY yuで猫作品展', '「にゃんこジャック」が', '10月16日より開催']],
    ['三条別院で9月10日に「第2回パレスチナ学習会」開催、平和を考える', ['三条別院で9月10日に', '「第2回パレスチナ学習会」', '開催、平和を考える']],
    ['三条市中央公民館で10月16日に無料の「まちなかフリーカラオケ」開催', ['三条市中央公民館で', '10月16日に無料の', '「まちなかフリーカラオケ」開催']],
    ['「Bar Keywest」の紹介記事を公開しました', ['「Bar Keywest」の', '紹介記事を公開しました']],
  ])('文節の切れ目で改行する: %s', (title, expected) => {
    expect(fitFeedTitle(title).lines).toEqual(expected);
  });

  it('短い店名は1行・最大サイズにする', () => {
    expect(fitFeedTitle('大黒亭 本店')).toEqual({ fontSize: 100, lines: ['大黒亭 本店'] });
  });

  it('英単語の途中では改行しない', () => {
    for (const line of fitFeedTitle('Osteria Kissui tei').lines) {
      expect(line).not.toMatch(/^[a-z]/);
    }
    expect(fitFeedTitle('Beerhouse3').lines).toEqual(['Beerhouse3']);
  });

  it('行頭に閉じ括弧・句読点を置かず、行末に開き括弧を置かない', () => {
    const { lines } = fitFeedTitle('日本酒のラベルの見方とは？特定名称酒のルールと選び方の基本');
    for (const line of lines) {
      expect(line).not.toMatch(/^[、。！？」』）]/);
      expect(line).not.toMatch(/[「『（]$/);
    }
  });

  it('最小サイズ・3行に収まらない長さは末尾を省略して収める', () => {
    const result = fitFeedTitle('あ'.repeat(80));
    expect(result.fontSize).toBe(44);
    expect(result.lines.length).toBeLessThanOrEqual(3);
    expect(result.lines.at(-1)).toMatch(/…$/);
  });
});
