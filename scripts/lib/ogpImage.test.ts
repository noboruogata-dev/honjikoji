import { describe, expect, it } from 'vitest';
import { checkGlyphCoverage, fitFeedTitle, wrapJapaneseTitle } from './ogpImage';

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

  it('英数字の単語はmaxCharsPerLineをまたいでも途中で改行しない（実際に報告された不具合）', () => {
    // 「Beerhouse3」(10文字)をmaxCharsPerLine=9で機械的に切ると
    // 「Beerhouse」「3」に分かれてしまっていた。
    const lines = wrapJapaneseTitle('Beerhouse3', 9);
    expect(lines).toEqual(['Beerhouse3']);
  });

  it('閉じ括弧の直後が助詞の場合、助詞ごと前の行に含める（回帰テスト: 「三条の「ハコニワ」で…」で2行目が「で」から始まっていた不具合）', () => {
    const lines = wrapJapaneseTitle('三条の「ハコニワ」で移住者向け交流イベントが10月18日開催！', 21);
    expect(lines).toEqual(['三条の「ハコニワ」で', '移住者向け交流イベントが10月18日開催！']);
  });

  it('助詞を含めると上限を超える場合は諦めて閉じ括弧の直後で改行する', () => {
    // 「三条の「ハコニワ」で」は10文字。maxCharsPerLine=9では収まらないため、
    // 助詞を巻き込まず、従来通り閉じ括弧の直後で改行する。
    const lines = wrapJapaneseTitle('三条の「ハコニワ」で移住者向け交流イベントが10月18日開催！', 9);
    expect(lines[0]).toBe('三条の「ハコニワ」');
  });

  it('英単語＋日本語が混在する場合も、英単語の途中では改行しない', () => {
    // 単語「BAR」(3文字) + 「え」「び」(各1文字) = 5 <= 5 でちょうど1行目に収まり、
    // 「す」を足すと5を超えるので2行目へ。
    const lines = wrapJapaneseTitle('BARえびすまち', 5);
    expect(lines[0]).toBe('BARえび');
    expect(lines.join('')).toBe('BARえびすまち');
  });
});

describe('fitFeedTitle', () => {
  it('候補tierのうち、閉じ括弧直後の助詞が行頭に取り残されないtierを優先する（回帰テスト: 「「Bar Keywest」の紹介記事を公開しました」で、wrapJapaneseTitle単体では2行に収まる最初のtierがこの問題を起こしたままだった）', () => {
    const result = fitFeedTitle('「Bar Keywest」の紹介記事を公開しました');
    expect(result.lines).toEqual(['「Bar Keywest」の', '紹介記事を公開しました']);
  });

  it('どのtierでも2行に収まらない場合は例外を投げず結果を返す', () => {
    const result = fitFeedTitle('あ'.repeat(80));
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it('2行に収める唯一の方法が最小フォントの場合、3行でも大きいフォントを優先する（回帰テスト: 「三条の「ハコニワ」で移住者向け交流イベントが10月18日開催！」で、2行に収める唯一の方法（最小フォント）が2行目だけ極端に長く読みにくかった）', () => {
    const result = fitFeedTitle('三条の「ハコニワ」で移住者向け交流イベントが10月18日開催！');
    expect(result.lines).toEqual(['三条の「ハコニワ」で', '移住者向け交流イベントが', '10月18日開催！']);
    expect(result.fontSize).toBe(68);
  });

  it('2行に収める方法が最小フォント以外で見つかる場合は、3行フォールバックを行わない（無関係な既存画像の見た目を変えないための回帰テスト）', () => {
    // 「パレ」「スチナ」と単語の途中で改行される点は理想的ではないが、
    // これは2行目以降が助詞で始まる問題ではなく、かつ最小フォントでもない
    // ため、3行フォールバックの対象外（今回の修正の意図的なスコープ外）。
    const result = fitFeedTitle('三条別院で9月10日に「第2回パレスチナ学習会」開催、平和を考える');
    expect(result.lines.length).toBe(2);
  });

  it('個別タイトルの決め打ち改行（回帰テスト: 「工場の祭典2026」連携企画告知）', () => {
    // 一般ロジックだと3行になり、2行目が長すぎるうえ「連携企画」が
    // 「連携企」「画を開催」と複合語の途中で割れて読みにくかった
    // （2行に収める組み合わせが無く3行フォールバックへ落ちるケース）。
    // wrapJapaneseTitle側の一般ルールでは改善しづらかったため、この
    // タイトルだけ決め打ちの2行に固定してある。他のタイトルの見た目には
    // 影響しない（完全一致した場合のみ分岐する）。
    const title = '「燕三条 工場の祭典2026」に合わせ本町・元町の2施設で連携企画を開催';
    const result = fitFeedTitle(title);
    expect(result.lines).toEqual(['「燕三条 工場の祭典2026」に合わせ', '本町・元町の2施設で連携企画を開催']);
    expect(result.fontSize).toBe(44);
  });
});
