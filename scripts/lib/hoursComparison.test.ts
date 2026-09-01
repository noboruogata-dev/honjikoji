import { describe, expect, it } from 'vitest';
import { compareHoursWithGoogle } from './hoursComparison';
import type { GoogleOpeningPeriod } from './googlePlaces';
import type { ParsedHourRule } from './openHoursParser';

describe('compareHoursWithGoogle', () => {
  it('完全に一致する場合はhasMismatch: falseを返す', () => {
    const ours: ParsedHourRule[] = [{ days: [1, 2, 3, 4, 5, 6], open: '17:30', close: '21:00' }];
    const google: GoogleOpeningPeriod[] = [1, 2, 3, 4, 5, 6].map((day) => ({
      open: { day, hour: 17, minute: 30 },
      close: { day, hour: 21, minute: 0 },
    }));
    const result = compareHoursWithGoogle(ours, google);
    expect(result.hasMismatch).toBe(false);
    expect(result.maxDiffMinutes).toBe(0);
    expect(result.mismatchedDays).toEqual([]);
  });

  it('日をまたぐ営業時間も正しく比較できる（実際に検出したbar-keywestのケース）', () => {
    const ours: ParsedHourRule[] = [{ days: [0, 1, 2, 3, 4, 5, 6], open: '19:00', close: '25:30' }];
    const google: GoogleOpeningPeriod[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
      open: { day, hour: 19, minute: 0 },
      close: { day: (day + 1) % 7, hour: 1, minute: 30 },
    }));
    const result = compareHoursWithGoogle(ours, google);
    expect(result.hasMismatch).toBe(false);
  });

  it('30分の閾値超えの差分を検出する（実際に検出したmotsuyaki-takahashiのケース）', () => {
    const ours: ParsedHourRule[] = [{ days: [1, 2, 3, 4, 5, 6], open: '17:00', close: '21:30' }];
    const google: GoogleOpeningPeriod[] = [1, 2, 3, 4, 5, 6].map((day) => ({
      open: { day, hour: 17, minute: 30 },
      close: { day, hour: 21, minute: 0 },
    }));
    const result = compareHoursWithGoogle(ours, google);
    expect(result.hasMismatch).toBe(true);
    expect(result.maxDiffMinutes).toBe(30);
    expect(result.mismatchedDays).toEqual(['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']);
  });

  it('閾値未満の差分は無視する', () => {
    const ours: ParsedHourRule[] = [{ days: [1], open: '17:30', close: '21:00' }];
    const google: GoogleOpeningPeriod[] = [{ open: { day: 1, hour: 17, minute: 35 }, close: { day: 1, hour: 21, minute: 0 } }];
    const result = compareHoursWithGoogle(ours, google, 15);
    expect(result.hasMismatch).toBe(false);
    expect(result.maxDiffMinutes).toBe(5);
  });

  it('片方だけ休業（営業/休業自体の食い違い）を構造的な乖離として検出する', () => {
    const ours: ParsedHourRule[] = [{ days: [0, 1, 2, 3, 4, 5, 6], open: '11:30', close: '14:00' }];
    const google: GoogleOpeningPeriod[] = [0, 1, 2, 3, 5, 6].map((day) => ({
      open: { day, hour: 17, minute: 30 },
      close: { day, hour: 22, minute: 0 },
    }));
    const result = compareHoursWithGoogle(ours, google);
    expect(result.hasMismatch).toBe(true);
    // 木曜日はours側に営業帯があるがgoogle側に無い→構造的な食い違い
    expect(result.mismatchedDays).toContain('木曜日');
  });

  it('昼夜2部制で両方一致する場合はhasMismatch: falseを返す', () => {
    const ours: ParsedHourRule[] = [
      { days: [0, 1, 2, 3, 5, 6], open: '11:30', close: '14:00' },
      { days: [0, 1, 2, 3, 5, 6], open: '17:30', close: '22:00' },
    ];
    const google: GoogleOpeningPeriod[] = [0, 1, 2, 3, 5, 6].flatMap((day) => [
      { open: { day, hour: 11, minute: 30 }, close: { day, hour: 14, minute: 0 } },
      { open: { day, hour: 17, minute: 30 }, close: { day, hour: 22, minute: 0 } },
    ]);
    const result = compareHoursWithGoogle(ours, google);
    expect(result.hasMismatch).toBe(false);
  });

  it('返り値に曜日名以外のGoogle側の実際の時刻文字列を一切含めない', () => {
    const ours: ParsedHourRule[] = [{ days: [1], open: '17:00', close: '21:30' }];
    const google: GoogleOpeningPeriod[] = [{ open: { day: 1, hour: 17, minute: 30 }, close: { day: 1, hour: 21, minute: 0 } }];
    const result = compareHoursWithGoogle(ours, google);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/17:30|21:00/);
  });
});
