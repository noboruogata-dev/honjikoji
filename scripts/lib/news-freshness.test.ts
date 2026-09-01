import { describe, expect, it } from 'vitest';
import {
  formatJapaneseYearMonth,
  FRESHNESS_LIMIT_MONTHS,
  isTodayOrFuture,
  isValidIsoDate,
  isWithinFreshnessLimit,
  todayInTokyo,
} from './news-freshness';

const NOW = new Date('2026-08-30T00:00:00Z');

describe('isValidIsoDate', () => {
  it('YYYY-MM-DD形式を受け入れる', () => {
    expect(isValidIsoDate('2026-08-30')).toBe(true);
  });

  it('年が無い表記・相対表現由来の不正な値を拒否する', () => {
    expect(isValidIsoDate('7月23日')).toBe(false);
    expect(isValidIsoDate('今週末')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('2026-13-99')).toBe(false); // 形式は一致するが実在しない日付
  });
});

describe('isWithinFreshnessLimit', () => {
  it(`${FRESHNESS_LIMIT_MONTHS}ヶ月以内の過去の出来事は許容する`, () => {
    expect(isWithinFreshnessLimit('2026-06-30', NOW)).toBe(true); // 2ヶ月前
  });

  it(`${FRESHNESS_LIMIT_MONTHS}ヶ月より前の出来事は拒否する（2年前のイベント事故の再現）`, () => {
    expect(isWithinFreshnessLimit('2024-07-23', NOW)).toBe(false);
  });

  it('開催予定（未来）の日付は常に許容する', () => {
    expect(isWithinFreshnessLimit('2027-01-01', NOW)).toBe(true);
  });

  it('境界値: ちょうど鮮度上限の日付は許容する', () => {
    const limit = new Date(NOW);
    limit.setMonth(limit.getMonth() - FRESHNESS_LIMIT_MONTHS);
    const limitIso = limit.toISOString().slice(0, 10);
    expect(isWithinFreshnessLimit(limitIso, NOW)).toBe(true);
  });

  it('不正な形式の値はfalse（安全側）', () => {
    expect(isWithinFreshnessLimit('7月23日', NOW)).toBe(false);
  });
});

describe('todayInTokyo', () => {
  it('UTCの日付が変わる直前でも、日本時間の日付を返す（JST 8:59 = UTC前日23:59）', () => {
    // UTC 2026-08-29T23:59:00Z = JST 2026-08-30T08:59:00+09:00
    expect(todayInTokyo(new Date('2026-08-29T23:59:00Z'))).toBe('2026-08-30');
  });

  it('UTCと日本時間が同じ日付になる時間帯はそのまま', () => {
    // UTC 2026-08-30T10:00:00Z = JST 2026-08-30T19:00:00+09:00
    expect(todayInTokyo(new Date('2026-08-30T10:00:00Z'))).toBe('2026-08-30');
  });
});

describe('isTodayOrFuture', () => {
  const TODAY = '2026-09-02';

  it('今日の日付は許容する（本日開催のイベント）', () => {
    expect(isTodayOrFuture(TODAY, TODAY)).toBe(true);
  });

  it('未来の日付は許容する', () => {
    expect(isTodayOrFuture('2026-09-10', TODAY)).toBe(true);
  });

  it('過去の日付は拒否する（既に終わったイベントの再現: 三条夏まつり事故）', () => {
    expect(isTodayOrFuture('2026-08-01', TODAY)).toBe(false);
  });

  it('不正な形式の値はfalse（安全側）', () => {
    expect(isTodayOrFuture('7月23日', TODAY)).toBe(false);
  });
});

describe('formatJapaneseYearMonth', () => {
  it('YYYY-MM-DDを「YYYY年M月」に変換する', () => {
    expect(formatJapaneseYearMonth('2024-07-23')).toBe('2024年7月');
    expect(formatJapaneseYearMonth('2026-01-05')).toBe('2026年1月');
  });
});
