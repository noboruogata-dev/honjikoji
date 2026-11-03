import { describe, expect, it } from 'vitest';
import {
  applyMetaEdits,
  buildMenuSection,
  buildPrBody,
  countPrices,
  insertSectionBeforeLastHeading,
  needsMenuResearch,
  pickTargets,
  validateMenuResearch,
  validateMetaProposal,
  type MetaProposal,
  type RewriteTarget,
} from './seoRewrite';
import type { SeoCandidates } from './seoCandidates';
import type { LoadedArticle } from './seoData';

const raw = `---
title: "大衆焼肉 さんきらく"
genre: "焼肉"
# コメントは残す
description: "三条市本寺小路で50年以上愛される大衆焼肉の老舗。"
pubDate: 2026-08-27
---

## 老舗

カルビ（650円）、赤（430円）、白（430円）。

## 締め

また来てください。
`;

const article: LoadedArticle = {
  collection: 'spots',
  slug: 'taisyu-yakiniku-sankiraku',
  title: '大衆焼肉 さんきらく',
  description: '三条市本寺小路で50年以上愛される大衆焼肉の老舗。',
  body: raw.split('---\n')[2],
  filePath: '/tmp/x.md',
  raw,
  frontmatter: { title: '大衆焼肉 さんきらく', address: '新潟県三条市本町1-9-5' },
};

const q = (query: string, impressions: number) => ({
  page: 'https://honjikoji.jp/spots/taisyu-yakiniku-sankiraku/',
  query,
  clicks: 0,
  impressions,
  ctr: 0,
  position: 10,
});

const target: RewriteTarget = {
  article,
  reasons: ['lowCtr'],
  impressions: 176,
  clicks: 1,
  ctr: 0.006,
  position: 9.4,
  queries: [q('大衆焼肉さんきらく メニュー', 46), q('さんきらく 三条', 10)],
  missingTerms: [],
  needsMenu: false,
};

const goodProposal: MetaProposal = {
  seoTitle: '大衆焼肉 さんきらく｜三条市本寺小路の老舗焼肉・メニューと価格',
  description:
    '三条市本寺小路で50年以上続く大衆焼肉の老舗「さんきらく」。看板のカルビは650円、赤・白は430円とお手頃。一人焼肉から宴会まで使える店内の様子とメニューを紹介します。',
  alternateNames: [],
  rationale: 'メニュー検索に合わせて価格を説明文に入れた。',
};

describe('countPrices / needsMenuResearch', () => {
  it('本文中の価格表記を数える', () => {
    expect(countPrices('カルビ（650円）と白（430 円）、セット１，２００円')).toBe(3);
  });

  it('メニュー検索があり、価格が少ない店舗記事だけ調査対象にする', () => {
    expect(needsMenuResearch({ collection: 'spots', body: 'おでんが人気' }, [q('ヨルサクラ メニュー', 15)])).toBe(true);
    expect(needsMenuResearch(article, [q('さんきらく メニュー', 46)])).toBe(false); // 価格3件あり
    expect(needsMenuResearch({ collection: 'spots', body: '' }, [q('ヨルサクラ メニュー', 2)])).toBe(false);
    expect(needsMenuResearch({ collection: 'columns', body: '' }, [q('メニュー', 50)])).toBe(false);
  });
});

describe('pickTargets', () => {
  const candidates: SeoCandidates = {
    totals: { clicks: 0, impressions: 0, articlePages: 1, otherPages: 0 },
    lowCtr: [{ ...q('', 0), impressions: 176, clicks: 1, ctr: 0.006, position: 9.4, article }],
    striking: [{ ...q('', 0), impressions: 176, clicks: 1, ctr: 0.006, position: 9.4, article }],
    uncovered: [
      {
        article,
        page: q('', 0).page,
        queries: [{ ...q('さんきらく メニュー', 17), missing: ['メニュー'], missingInBody: ['メニュー'] }],
      },
    ],
    gaps: [],
    topQueries: { 'spots/taisyu-yakiniku-sankiraku': [q('さんきらく メニュー', 17)] },
  };

  it('同じ記事の理由をまとめ、汎用語は表記ゆれ候補に入れない', () => {
    const targets = pickTargets(candidates, [article], new Set());
    expect(targets).toHaveLength(1);
    expect(targets[0].reasons).toEqual(['lowCtr', 'striking', 'uncovered']);
    expect(targets[0].missingTerms).toEqual([]);
  });

  it('最近リライトした記事は対象外にする', () => {
    expect(pickTargets(candidates, [article], new Set(['spots/taisyu-yakiniku-sankiraku']))).toHaveLength(0);
  });
});

describe('validateMetaProposal', () => {
  it('条件を満たす提案は通す', () => {
    expect(validateMetaProposal(goodProposal, target)).toEqual([]);
  });

  it('記事に無い数字・店名抜け・長さ超過・検索に無い別表記を弾く', () => {
    const errors = validateMetaProposal(
      {
        seoTitle: '三条の焼肉なら創業70年のこの店で決まり、本寺小路ガイドおすすめ',
        description: '短い',
        alternateNames: ['サンキラク'],
        rationale: '',
      },
      target
    );
    expect(errors.join('\n')).toMatch(/サイト名/);
    expect(errors.join('\n')).toMatch(/descriptionの長さ/);
    expect(errors.join('\n')).toMatch(/店名/);
    expect(errors.join('\n')).toMatch(/記事に無い数字.*70/);
    expect(errors.join('\n')).toMatch(/サンキラク/);
  });
});

describe('applyMetaEdits', () => {
  it('description を置き換え、title の直後に seoTitle を入れる（コメントは残す）', () => {
    const out = applyMetaEdits(raw, { seoTitle: '新タイトル', description: '新しい "説明"' });
    expect(out).toContain('title: "大衆焼肉 さんきらく"\nseoTitle: "新タイトル"\n');
    expect(out).toContain('description: "新しい \\"説明\\""');
    expect(out).toContain('# コメントは残す');
    expect(out).toContain('## 締め');
  });

  it('既存の seoTitle は上書きする', () => {
    const once = applyMetaEdits(raw, { seoTitle: 'A', description: 'B' });
    const twice = applyMetaEdits(once, { seoTitle: 'C', description: 'D' });
    expect(twice.match(/seoTitle/g)).toHaveLength(1);
    expect(twice).toContain('seoTitle: "C"');
  });

  it('複数行の description は安全のため書き換えない', () => {
    expect(() => applyMetaEdits(raw.replace(/description: ".*"/, 'description: >\n  複数行'), { seoTitle: 'A', description: 'B' })).toThrow();
  });
});

describe('メニュー', () => {
  it('引用0件・品目不足・未発見はすべて弾く', () => {
    const errors = validateMenuResearch({ found: false, items: [], sourceUrls: [] }, 0);
    expect(errors).toHaveLength(4);
  });

  it('節を最後の見出しの前に差し込む', () => {
    const section = buildMenuSection(
      { found: true, items: [{ name: 'おでん盛り合わせ', price: '800円' }, { name: '油揚げ', price: '' }], sourceUrls: [] },
      '2026-11-03'
    );
    expect(section).toContain('- おでん盛り合わせ：800円');
    expect(section).toContain('- 油揚げ\n');
    expect(section).toContain('2026年11月時点');
    const body = insertSectionBeforeLastHeading('## A\n\n本文\n\n## 締め\n\n終わり\n', section);
    expect(body.indexOf('メニューと価格の例')).toBeLessThan(body.indexOf('## 締め'));
  });
});

describe('buildPrBody', () => {
  it('前後の差分と要確認項目を含める', () => {
    const body = buildPrBody(
      [
        {
          target,
          meta: { before: { description: article.description }, after: { ...goodProposal, alternateNames: ['サンキラク'] } },
          menuSkipped: ['Google検索の引用が0件でした'],
        },
      ],
      { startDate: '2026-10-04', endDate: '2026-10-31' }
    );
    expect(body).toContain('（未設定・見出し「大衆焼肉 さんきらく」）');
    expect(body).toContain(goodProposal.seoTitle);
    expect(body).toContain('要確認（表記ゆれ）');
    expect(body).toContain('手動で追記してください');
  });
});
