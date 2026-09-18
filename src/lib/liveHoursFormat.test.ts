import { describe, expect, it } from 'vitest';
import { formatHours, formatRange, parseWeekdayDescriptions } from './liveHoursFormat';

describe('formatRange', () => {
  it('通常の時間帯はそのまま "H:MM〜H:MM" にする', () => {
    expect(formatRange(11, 0, 14, 0)).toBe('11:00〜14:00');
  });

  it('日をまたぐ場合（閉店時刻<=開店時刻）は経過時刻表記にする', () => {
    expect(formatRange(20, 0, 4, 0)).toBe('20:00〜28:00');
  });
});

describe('parseWeekdayDescriptions', () => {
  it('7行以外はnullを返す', () => {
    expect(parseWeekdayDescriptions(['月曜日: 定休日'])).toBeNull();
  });

  it('想定外の書式（曜日名が読み取れない等）が1行でもあればnullを返す（フォールバック用）', () => {
    const lines = [
      '月曜日: 11時00分〜14時00分',
      '火曜日: 定休日',
      '水曜日: 定休日',
      '木曜日: 定休日',
      '金曜日: 定休日',
      '土曜日: 定休日',
      '不明な曜日: 24 時間営業', // 想定外の書式
    ];
    expect(parseWeekdayDescriptions(lines)).toBeNull();
  });

  it('実際のPlaces APIレスポンス（そば処 今泉）を解析できる', () => {
    const lines = [
      '月曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '火曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '水曜日: 定休日',
      '木曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '金曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '土曜日: 11時00分〜20時30分',
      '日曜日: 11時00分〜20時00分',
    ];
    const parsed = parseWeekdayDescriptions(lines);
    expect(parsed).not.toBeNull();
    expect(parsed?.[2]).toEqual({ label: '水曜日', short: '水', pos: 2, ranges: null });
    expect(parsed?.[0]).toEqual({
      label: '月曜日',
      short: '月',
      pos: 0,
      ranges: ['11:00〜14:00', '17:00〜20:30'],
    });
  });
});

describe('formatHours', () => {
  it('全曜日が同じ営業帯なら曜日ラベル無しの1行にする（回帰テスト: Anthem）', () => {
    const lines = Array.from({ length: 7 }, (_, i) => {
      const days = ['月', '火', '水', '木', '金', '土', '日'];
      return `${days[i]}曜日: 20時00分〜4時00分`;
    });
    const parsed = parseWeekdayDescriptions(lines)!;
    const result = formatHours(parsed);
    expect(result.openLines).toEqual(['20:00〜28:00']);
    expect(result.closedLine).toBeUndefined();
  });

  it('休業日が1つあり、残り全日が同じ営業帯なら曜日ラベル無しの1行＋定休日行（回帰テスト: 大黒亭 本店）', () => {
    const lines = [
      '月曜日: 11時00分〜13時30分, 17時00分〜19時30分',
      '火曜日: 定休日',
      '水曜日: 11時00分〜13時30分, 17時00分〜19時30分',
      '木曜日: 11時00分〜13時30分, 17時00分〜19時30分',
      '金曜日: 11時00分〜13時30分, 17時00分〜19時30分',
      '土曜日: 11時00分〜13時30分, 17時00分〜19時30分',
      '日曜日: 11時00分〜13時30分, 17時00分〜19時30分',
    ];
    const parsed = parseWeekdayDescriptions(lines)!;
    const result = formatHours(parsed);
    expect(result.openLines).toEqual(['11:00〜13:30、17:00〜19:30']);
    expect(result.closedLine).toBe('火曜日');
  });

  it('曜日によって営業帯が異なる場合は曜日グループごとに行を分ける（回帰テスト: そば処 今泉）', () => {
    const lines = [
      '月曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '火曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '水曜日: 定休日',
      '木曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '金曜日: 11時00分〜14時00分, 17時00分〜20時30分',
      '土曜日: 11時00分〜20時30分',
      '日曜日: 11時00分〜20時00分',
    ];
    const parsed = parseWeekdayDescriptions(lines)!;
    const result = formatHours(parsed);
    expect(result.openLines).toEqual(['月・火・木・金 11:00〜14:00、17:00〜20:30', '土 11:00〜20:30', '日 11:00〜20:00']);
    expect(result.closedLine).toBe('水曜日');
  });

  it('3日以上の連続した曜日は範囲表記にする（例: 月〜金 / 土・日）', () => {
    const lines = [
      '月曜日: 11時00分〜20時00分',
      '火曜日: 11時00分〜20時00分',
      '水曜日: 11時00分〜20時00分',
      '木曜日: 11時00分〜20時00分',
      '金曜日: 11時00分〜20時00分',
      '土曜日: 11時00分〜22時00分',
      '日曜日: 11時00分〜22時00分',
    ];
    const parsed = parseWeekdayDescriptions(lines)!;
    const result = formatHours(parsed);
    expect(result.openLines).toEqual(['月〜金 11:00〜20:00', '土・日 11:00〜22:00']);
  });

  it('3日以上連続した定休日は範囲表記にする', () => {
    const lines = [
      '月曜日: 定休日',
      '火曜日: 定休日',
      '水曜日: 定休日',
      '木曜日: 11時00分〜20時00分',
      '金曜日: 11時00分〜20時00分',
      '土曜日: 11時00分〜20時00分',
      '日曜日: 11時00分〜20時00分',
    ];
    const parsed = parseWeekdayDescriptions(lines)!;
    const result = formatHours(parsed);
    expect(result.closedLine).toBe('月曜日〜水曜日');
  });

  it('休業日が無ければclosedLineはundefined', () => {
    const lines = Array.from({ length: 7 }, (_, i) => {
      const days = ['月', '火', '水', '木', '金', '土', '日'];
      return `${days[i]}曜日: 9時00分〜18時00分`;
    });
    const parsed = parseWeekdayDescriptions(lines)!;
    expect(formatHours(parsed).closedLine).toBeUndefined();
  });
});
