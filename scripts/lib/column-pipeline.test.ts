import { describe, expect, it } from 'vitest';
import {
  columnFrontmatterSchema,
  columnResearchSchema,
  columnWriterSchema,
  resolveProfile,
  validateColumnDraft,
} from './column-pipeline';

describe('column publish schema', () => {
  const base = {
    title: '燗酒の楽しみ方',
    pubDate: '2026-08-30',
    category: 'お酒の豆知識' as const,
    summary: '決定論的QAを通過したコラムです。',
    kind: 'standard' as const,
  };

  it('通常の下書き状態を受け入れる', () => {
    expect(columnFrontmatterSchema.safeParse({ ...base, draft: true, imageStatus: 'draft' }).success).toBe(true);
  });

  it('自動QA通過後の公開状態を受け入れる', () => {
    expect(columnFrontmatterSchema.safeParse({ ...base, draft: false, imageStatus: 'qa-passed' }).success).toBe(true);
  });
});

const verifiedResearch = columnResearchSchema.parse({
  notFound: false,
  topic: '日本酒の温度',
  slug: 'sake-temperature',
  angle: '温度による楽しみ方',
  claims: [
    {
      id: 'claim-1',
      statement: '日本酒は温度帯によって呼び名がある',
      status: 'verified',
      sourceTitle: '公的資料',
      sourceUrl: 'https://example.com/source',
      sourceType: 'official',
    },
  ],
});

const validWriter = columnWriterSchema.parse({
  title: '温度でひらく、日本酒の表情',
  summary: '日本酒の温度による楽しみ方を紹介します。',
  body: '## 温度で変わる楽しみ\n\n日本酒には温度帯による呼び名があります。\n\n今夜の一杯を選ぶ手がかりにしてみましょう。',
  usedClaimIds: ['claim-1'],
  disclaimer: '',
});

describe('resolveProfile', () => {
  it('カテゴリ別のkindを決定する', () => {
    expect(resolveProfile('alcohol').kind).toBe('standard');
    expect(resolveProfile('history').kind).toBe('history');
    expect(resolveProfile('people').kind).toBe('fiction');
    expect(resolveProfile('people', 'interview').kind).toBe('interview');
  });

  it('不正な組み合わせを拒否する', () => {
    expect(() => resolveProfile('history', 'fiction')).toThrow();
    expect(() => resolveProfile('manners', 'interview')).toThrow();
  });
});

describe('validateColumnDraft', () => {
  it('出典付きの一般記事を通す', () => {
    const result = validateColumnDraft(resolveProfile('alcohol'), verifiedResearch, validWriter, false);
    expect(result.errors).toEqual([]);
  });

  it('Researchにない主張IDを拒否する', () => {
    const writer = { ...validWriter, usedClaimIds: ['claim-99'] };
    const result = validateColumnDraft(resolveProfile('alcohol'), verifiedResearch, writer, false);
    expect(result.errors.some((message) => message.includes('存在しない主張ID'))).toBe(true);
  });

  it('未確認の歴史主張を本文利用できない', () => {
    const research = columnResearchSchema.parse({
      ...verifiedResearch,
      claims: [{ id: 'claim-1', statement: '由来の噂', status: 'unverified' }],
    });
    const result = validateColumnDraft(resolveProfile('history'), research, validWriter, false);
    expect(result.errors.some((message) => message.includes('使用できません'))).toBe(true);
  });

  it('画像ファイル直URLを事実の出典として認めない', () => {
    const research = columnResearchSchema.parse({
      ...verifiedResearch,
      claims: [
        {
          id: 'claim-1',
          statement: '古い町並みが存在した',
          status: 'single-source',
          sourceTitle: '古写真',
          sourceUrl: 'https://example.com/photo.jpg',
          sourceType: 'secondary',
        },
      ],
    });
    const result = validateColumnDraft(resolveProfile('history'), research, validWriter, false);
    expect(result.errors.some((message) => message.includes('使用できません'))).toBe(true);
  });

  it('伝承を使う歴史記事には断り書きを要求する', () => {
    const research = columnResearchSchema.parse({
      ...verifiedResearch,
      claims: [
        {
          id: 'claim-1',
          statement: '地域に伝わる話',
          status: 'oral-tradition',
          sourceTitle: '郷土資料',
          sourceUrl: 'https://example.com/history',
          sourceType: 'secondary',
        },
      ],
    });
    const result = validateColumnDraft(resolveProfile('history'), research, validWriter, false);
    expect(result.errors.some((message) => message.includes('伝承・諸説'))).toBe(true);
  });

  it('フィクションに明示を要求する', () => {
    const writer = { ...validWriter, usedClaimIds: [], disclaimer: '', body: '夜の路地を歩く物語です。' };
    const result = validateColumnDraft(resolveProfile('people', 'fiction'), verifiedResearch, writer, false);
    expect(result.errors.some((message) => message.includes('フィクション'))).toBe(true);
  });

  it('実在地域を描くフィクションに背景事実IDを要求する', () => {
    const writer = {
      ...validWriter,
      usedClaimIds: [],
      disclaimer: 'この物語はフィクションです。',
      body: '※この物語はフィクションです。\n\n本寺小路の夜を舞台にした物語です。',
    };
    const result = validateColumnDraft(resolveProfile('people', 'fiction'), verifiedResearch, writer, false);
    expect(result.errors.some((message) => message.includes('背景事実'))).toBe(true);
  });

  it('取材記事に提供資料を要求する', () => {
    const result = validateColumnDraft(resolveProfile('people', 'interview'), verifiedResearch, validWriter, false);
    expect(result.errors.some((message) => message.includes('--source-file'))).toBe(true);
  });
});
