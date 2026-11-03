import { describe, expect, it } from 'vitest';
import {
  containsTerm,
  expectedCtr,
  missingTermsInBody,
  formatReport,
  missingTerms,
  parseArticlePath,
  selectCandidates,
  type ArticleInfo,
  type PageQueryRow,
  type PageRow,
} from './seoCandidates';

const articles: ArticleInfo[] = [
  { collection: 'spots', slug: 'bar-keywest', title: 'BAR KEYWEST', description: '本寺小路のカクテルバー' },
  { collection: 'columns', slug: 'sake-kanzake-temperature-names', title: '燗酒の温度の呼び名', description: '日本酒の燗の温度帯を解説' },
];

const page = (path: string) => `https://honjikoji.jp${path}`;

describe('parseArticlePath', () => {
  it('記事URLからコレクションとslugを取り出す', () => {
    expect(parseArticlePath(page('/spots/bar-keywest/'))).toEqual({ collection: 'spots', slug: 'bar-keywest' });
    expect(parseArticlePath(page('/columns/abc'))).toEqual({ collection: 'columns', slug: 'abc' });
  });

  it('一覧ページやトップは記事扱いしない', () => {
    expect(parseArticlePath(page('/'))).toBeNull();
    expect(parseArticlePath(page('/spots/'))).toBeNull();
    expect(parseArticlePath(page('/guides/solo/'))).toBeNull();
    expect(parseArticlePath('not a url')).toBeNull();
  });
});

describe('expectedCtr', () => {
  it('順位が下がるほど目安CTRも下がり、圏外は下限値になる', () => {
    expect(expectedCtr(1)).toBeGreaterThan(expectedCtr(5));
    expect(expectedCtr(30)).toBe(0.01);
  });
});

describe('missingTerms', () => {
  it('タイトル・説明文に無い語だけを返す（全角半角・大文字小文字は区別しない）', () => {
    expect(missingTerms('ｋｅｙｗｅｓｔ 三条 駐車場', articles[0])).toEqual(['三条', '駐車場']);
    expect(missingTerms('本寺小路 ハイボール', articles[0])).toEqual(['ハイボール']);
    expect(missingTerms('カクテルバー', articles[0])).toEqual([]);
  });
});

describe('containsTerm', () => {
  it('語順違い・空白なしの店名は含まれているとみなす', () => {
    expect(containsTerm('酒采とお食事 どっぽ', 'どっぽ酒采とお食事')).toBe(true);
  });
  it('表記ゆれは含まれていないとみなす', () => {
    expect(containsTerm('そば処 今泉', 'そば処いま泉')).toBe(false);
    expect(containsTerm('Bar Keywest', 'キーウエスト')).toBe(false);
  });
});

describe('missingTermsInBody', () => {
  it('本文にある語は記事に無い扱いにしない', () => {
    const article = { ...articles[0], body: '看板メニューはモヒート' };
    expect(missingTerms('keywest メニュー', article)).toEqual(['メニュー']);
    expect(missingTermsInBody('keywest メニュー', article)).toEqual([]);
  });
});

describe('selectCandidates', () => {
  const pageRows: PageRow[] = [
    // 4位で表示多いのにCTR 1% → lowCtr
    { page: page('/spots/bar-keywest/'), clicks: 2, impressions: 200, ctr: 0.01, position: 4 },
    // 12位 → striking
    { page: page('/columns/sake-kanzake-temperature-names/'), clicks: 1, impressions: 80, ctr: 0.0125, position: 12 },
    // 記事以外
    { page: page('/'), clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
  ];
  const pageQueryRows: PageQueryRow[] = [
    { page: page('/spots/bar-keywest/'), query: 'keywest 駐車場', clicks: 0, impressions: 30, ctr: 0, position: 5 },
    { page: page('/spots/bar-keywest/'), query: 'カクテルバー', clicks: 1, impressions: 40, ctr: 0.025, position: 4 },
    { page: page('/columns/sake-kanzake-temperature-names/'), query: '三条 日本酒 飲み比べ', clicks: 0, impressions: 25, ctr: 0, position: 35 },
  ];

  const result = selectCandidates(pageRows, pageQueryRows, articles);

  it('合計と記事/非記事ページ数を集計する', () => {
    expect(result.totals).toEqual({ clicks: 13, impressions: 380, articlePages: 2, otherPages: 1 });
  });

  it('CTRが順位相応を大きく下回る記事をlowCtrに入れる', () => {
    expect(result.lowCtr.map((p) => p.article.slug)).toEqual(['bar-keywest']);
  });

  it('8〜20位の記事をstrikingに入れる', () => {
    expect(result.striking.map((p) => p.article.slug)).toEqual(['sake-kanzake-temperature-names']);
  });

  it('タイトル・説明文に無い語を含むクエリだけをuncoveredに入れる', () => {
    const keywest = result.uncovered.find((u) => u.article.slug === 'bar-keywest');
    expect(keywest?.queries.map((q) => q.query)).toEqual(['keywest 駐車場']);
    expect(keywest?.queries[0].missing).toEqual(['駐車場']);
  });

  it('サイト全体で20位より下のクエリをgapsに入れる', () => {
    expect(result.gaps.map((g) => g.query)).toEqual(['三条 日本酒 飲み比べ']);
  });

  it('レポートに各セクションが出力される', () => {
    const report = formatReport(result, { startDate: '2026-10-01', endDate: '2026-10-28' });
    expect(report).toContain('SEOレポート（2026-10-01 〜 2026-10-28）');
    expect(report).toContain('BAR KEYWEST（spots/bar-keywest）');
    expect(report).toContain('記事に無い: 駐車場');
    expect(report).toContain('「三条 日本酒 飲み比べ」');
  });
});
