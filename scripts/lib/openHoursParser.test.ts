import { describe, expect, it } from 'vitest';
import { isIrregularHoliday, parseOpenHoursToHours } from './openHoursParser';

describe('parseOpenHoursToHours', () => {
  it('単一の営業帯を導出する', () => {
    const result = parseOpenHoursToHours('19:00〜02:00', '月曜日');
    expect(result.hours).toEqual([{ days: [0, 2, 3, 4, 5, 6], open: '19:00', close: '26:00' }]);
  });

  it('昼の部・夜の部のように複数の営業帯を両方とも導出する（回帰テスト: 以前は1つ目しか拾えなかった）', () => {
    const result = parseOpenHoursToHours('11:30〜14:00、17:30〜22:00', '木曜日');
    expect(result.hours).toEqual([
      { days: [0, 1, 2, 3, 5, 6], open: '11:30', close: '14:00' },
      { days: [0, 1, 2, 3, 5, 6], open: '17:30', close: '22:00' },
    ]);
  });

  it('3つ以上の営業帯にも対応する', () => {
    const result = parseOpenHoursToHours('11:00〜14:00、17:00〜19:00、20:00〜23:00', '日曜日');
    expect(result.hours).toHaveLength(3);
    expect(result.hours?.map((r) => [r.open, r.close])).toEqual([
      ['11:00', '14:00'],
      ['17:00', '19:00'],
      ['20:00', '23:00'],
    ]);
  });

  it('regularHolidayが不定休ならundefinedを返す', () => {
    const result = parseOpenHoursToHours('19:00〜02:00', '不定休');
    expect(result.hours).toBeUndefined();
    expect(result.reason).toContain('不定休');
  });

  it('openHoursに時刻の組が1つも無ければundefinedを返す', () => {
    const result = parseOpenHoursToHours('応相談', '月曜日');
    expect(result.hours).toBeUndefined();
  });

  it('複数営業帯のうち1つでも時刻が不正ならundefinedを返す（部分適用しない）', () => {
    const result = parseOpenHoursToHours('11:30〜14:00、25:99〜22:00', '木曜日');
    expect(result.hours).toBeUndefined();
  });
});

describe('isIrregularHoliday', () => {
  it('「不定休」を含む文字列を検出する', () => {
    expect(isIrregularHoliday('不定休')).toBe(true);
    expect(isIrregularHoliday('月曜日')).toBe(false);
  });
});
