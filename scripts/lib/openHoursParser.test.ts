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

  it('営業帯ごとの曜日限定（"火・水・金・土曜"のようにまとめて曜が1つ）を反映する（回帰テスト: 以前はregularHoliday由来の曜日集合が全営業帯に一律適用されていた）', () => {
    const result = parseOpenHoursToHours('18:00〜02:00（昼営業 火・水・金・土曜 12:00〜14:30）', '日曜日');
    expect(result.hours).toEqual([
      { days: [1, 2, 3, 4, 5, 6], open: '18:00', close: '26:00' },
      { days: [2, 3, 5, 6], open: '12:00', close: '14:30' },
    ]);
  });

  it('各曜日ごとに「曜」が付く表記（月曜・水曜・金曜）にも対応する', () => {
    const result = parseOpenHoursToHours('月曜・水曜・金曜11:00〜14:00、18:00〜23:00', '日曜日');
    expect(result.hours).toEqual([
      { days: [1, 3, 5], open: '11:00', close: '14:00' },
      { days: [1, 2, 3, 4, 5, 6], open: '18:00', close: '23:00' },
    ]);
  });

  it('曜日限定が最初の営業帯だけに付いていても、後続の営業帯はデフォルト曜日集合にフォールバックする', () => {
    const result = parseOpenHoursToHours('火・水・金・土曜のみ12:00〜14:30、18:00〜02:00は毎日営業', '日曜日');
    expect(result.hours).toEqual([
      { days: [2, 3, 5, 6], open: '12:00', close: '14:30' },
      { days: [1, 2, 3, 4, 5, 6], open: '18:00', close: '26:00' },
    ]);
  });

  it('営業帯固有の曜日指定がregularHolidayの休業曜日と矛盾する場合はundefinedを返す', () => {
    const result = parseOpenHoursToHours('18:00〜02:00（昼営業 月曜 12:00〜14:30）', '月曜日');
    expect(result.hours).toBeUndefined();
    expect(result.reason).toContain('矛盾');
  });

  it('曜日＋「は」の置き換え表現（例: "日曜は11:30〜15:00"）はundefinedを返す（回帰テスト: 泉食堂 マーポー亭の件。加算パターンとして誤解釈すると、置き換えられるはずの曜日にデフォルトの営業帯が残ったまま専用の営業帯が追加され、実際の営業時間と食い違うhoursが導出されていた）', () => {
    const result = parseOpenHoursToHours('11:30〜14:00、18:00〜22:00（日曜は11:30〜15:00）', '月曜日、火曜日');
    expect(result.hours).toBeUndefined();
    expect(result.reason).toContain('置き換え');
  });

  it('「〜曜日は」（曜日の後に「日」が入る表記）の置き換え表現も検出する', () => {
    const result = parseOpenHoursToHours('18:00〜24:00（土曜日は17:00〜24:00）', '月曜日');
    expect(result.hours).toBeUndefined();
  });
});

describe('isIrregularHoliday', () => {
  it('「不定休」を含む文字列を検出する', () => {
    expect(isIrregularHoliday('不定休')).toBe(true);
    expect(isIrregularHoliday('月曜日')).toBe(false);
  });
});
