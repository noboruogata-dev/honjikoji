import { describe, expect, it } from 'vitest';
import {
  evaluateSourceVerificationClaims,
  UNSOURCED_CLAIMS_MAX_RATIO,
  UNSOURCED_CLAIMS_MIN_COUNT,
  type SourceVerificationClaim,
} from './sourceVerification';

function claim(statement: string, hasSource: boolean): SourceVerificationClaim {
  return { statement, hasSource };
}

describe('evaluateSourceVerificationClaims', () => {
  it('出典なしが0件ならブロックしない', () => {
    const result = evaluateSourceVerificationClaims([claim('a', true), claim('b', true), claim('c', true)]);
    expect(result).toEqual({
      totalClaims: 3,
      unsourcedStatements: [],
      unsourcedCount: 0,
      unsourcedRatio: 0,
      shouldBlock: false,
    });
  });

  it('件数・割合のどちらの閾値も下回ればブロックしない', () => {
    // 10件中2件が出典なし（20% < 30%、2件 < 3件）
    const claims = [
      claim('a', false),
      claim('b', false),
      ...Array.from({ length: 8 }, (_, i) => claim(`ok${i}`, true)),
    ];
    const result = evaluateSourceVerificationClaims(claims);
    expect(result.unsourcedCount).toBe(2);
    expect(result.unsourcedRatio).toBeCloseTo(0.2);
    expect(result.shouldBlock).toBe(false);
  });

  it(`出典なしが${UNSOURCED_CLAIMS_MIN_COUNT}件以上ならブロックする（割合が閾値未満でも）`, () => {
    // 20件中3件が出典なし（15% < 30%だが、件数が3件以上）
    const claims = [
      claim('a', false),
      claim('b', false),
      claim('c', false),
      ...Array.from({ length: 17 }, (_, i) => claim(`ok${i}`, true)),
    ];
    const result = evaluateSourceVerificationClaims(claims);
    expect(result.unsourcedCount).toBe(UNSOURCED_CLAIMS_MIN_COUNT);
    expect(result.unsourcedRatio).toBeLessThan(UNSOURCED_CLAIMS_MAX_RATIO);
    expect(result.shouldBlock).toBe(true);
  });

  it(`出典なしの割合が${UNSOURCED_CLAIMS_MAX_RATIO * 100}%以上ならブロックする（件数が閾値未満でも）`, () => {
    // 5件中2件が出典なし（40% >= 30%だが、件数は3件未満）
    const claims = [claim('a', false), claim('b', false), claim('c', true), claim('d', true), claim('e', true)];
    const result = evaluateSourceVerificationClaims(claims);
    expect(result.unsourcedCount).toBe(2);
    expect(result.unsourcedCount).toBeLessThan(UNSOURCED_CLAIMS_MIN_COUNT);
    expect(result.unsourcedRatio).toBeGreaterThanOrEqual(UNSOURCED_CLAIMS_MAX_RATIO);
    expect(result.shouldBlock).toBe(true);
  });

  it('断定表現が1件も抽出されなければブロックしない（判定材料が無いケース）', () => {
    const result = evaluateSourceVerificationClaims([]);
    expect(result).toEqual({
      totalClaims: 0,
      unsourcedStatements: [],
      unsourcedCount: 0,
      unsourcedRatio: 0,
      shouldBlock: false,
    });
  });

  it('出典なしの記述文をunsourcedStatementsにそのまま残す（Job Summaryへの列挙用）', () => {
    const result = evaluateSourceVerificationClaims([
      claim('毎週金曜日にはジャズの生演奏が開催されています。', false),
      claim('営業時間は18:00から深夜02:00までです。', true),
    ]);
    expect(result.unsourcedStatements).toEqual(['毎週金曜日にはジャズの生演奏が開催されています。']);
  });

  it('回帰テスト: Wine Bar MARGAUXの件を模したケース（10件中1件だけ出典なし）はブロックしない', () => {
    // 実際の事案は「引用0件」自体を別の対策（groundingSourceCount）で先に
    // ブロックするようになったが、仮にGrounding自体は通っていて本文の
    // 一部にだけ出典不明の記述が紛れ込んだ場合、閾値未満なら公開は続行される
    // （出典なし一覧はJob Summaryに残るため、後から気づける）。
    const claims = [
      claim('本寺小路・居島に所在しています。', true),
      claim('前身の店の想いを継承しています。', true),
      claim('世代を超えて集える社交場です。', true),
      claim('営業時間は18:00から深夜02:00までです。', true),
      claim('日曜日は定休日です。', true),
      claim('世界各国のワインを飲み比べられます。', true),
      claim('肉料理やパスタが揃っています。', true),
      claim('1軒目としての利用に最適です。', true),
      claim('2次会や締めの一杯にも最適です。', true),
      claim('毎週金曜日にはジャズの生演奏イベントが開催されています。', false),
    ];
    const result = evaluateSourceVerificationClaims(claims);
    expect(result.unsourcedCount).toBe(1);
    expect(result.shouldBlock).toBe(false);
    expect(result.unsourcedStatements).toEqual(['毎週金曜日にはジャズの生演奏イベントが開催されています。']);
  });
});
