import { describe, expect, it } from 'vitest';
import { getOpenStatus, type HourRule } from './hours';

/**
 * Asia/Tokyo のローカル日時 (y, m, d, h, min) を表す Date を作る。
 * JST = UTC+9（夏時間なし）なので、UTC側の時を9時間分ずらして構築する。
 * Date.UTC は繰り上がり/繰り下がりを自動正規化するので、h に負値や24以上を
 * 渡しても日付側で吸収される。
 */
function jst(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h - 9, min));
}

// 2026-08-27(木) 2026-08-28(金) 2026-08-29(土) 2026-08-30(日) 2026-08-31(月)
// を基準日として使う（0=日,1=月,...4=木,5=金,6=土）。

describe('getOpenStatus: hours未指定・不正データ', () => {
  it('hoursがundefinedならunknown', () => {
    const result = getOpenStatus(undefined, jst(2026, 8, 27, 20, 0));
    expect(result.state).toBe('unknown');
    expect(result.label).toBe('営業時間は店舗にご確認ください');
  });

  it('hoursが空配列でもunknown', () => {
    const result = getOpenStatus([], jst(2026, 8, 27, 20, 0));
    expect(result.state).toBe('unknown');
    expect(result.label).toBe('営業時間は店舗にご確認ください');
  });

  it('close <= open の壊れたruleしか無ければunknown', () => {
    const hours: HourRule[] = [{ days: [4], open: '19:00', close: '18:00' }];
    const result = getOpenStatus(hours, jst(2026, 8, 27, 20, 0));
    expect(result.state).toBe('unknown');
  });
});

describe('getOpenStatus: 日をまたぐ営業（最重要のエッジケース）', () => {
  // 木曜 19:00開店 → 翌2:00閉店（"26:00"表記）
  const hours: HourRule[] = [{ days: [4], open: '19:00', close: '26:00' }];

  it('前日から続く営業中: 金曜0:30は木曜の営業が持ち越されてopen', () => {
    // spillEnd=2:00(120分)、現在30分なので残り90分＝closing-soonの閾値(60分)より外側。
    const result = getOpenStatus(hours, jst(2026, 8, 28, 0, 30));
    expect(result.state).toBe('open');
    expect(result.nextChange).toBe('2:00');
  });

  it('持ち越し営業でも閉店60分前ならclosing-soon: 金曜1:05', () => {
    // 閉店(spillEnd)は2:00=120分。1:05=65分。残り55分。
    const result = getOpenStatus(hours, jst(2026, 8, 28, 1, 5));
    expect(result.state).toBe('closing-soon');
  });

  it('金曜2:00ちょうど（持ち越し分の閉店時刻）はclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 28, 2, 0));
    expect(result.state).toBe('closed');
  });

  it('木曜20:00（当日の営業開始後・日付が変わる前）はopen', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 20, 0));
    expect(result.state).toBe('open');
  });

  it('木曜18:00（開店前）はclosed、次の開店時刻を案内', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 18, 0));
    expect(result.state).toBe('closed');
    expect(result.nextChange).toBe('19:00');
  });

  it('金曜（木曜の翌日）12:00は木曜分の持ち越しも当日分も無くclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 28, 12, 0));
    expect(result.state).toBe('closed');
  });
});

describe('getOpenStatus: 定休日', () => {
  // 月曜(1)だけ定休日。それ以外は 18:00〜24:00。
  const hours: HourRule[] = [{ days: [0, 2, 3, 4, 5, 6], open: '18:00', close: '24:00' }];

  it('定休日の昼はclosed、ラベルは「本日は定休日です」', () => {
    // 2026-08-31 は月曜
    const result = getOpenStatus(hours, jst(2026, 8, 31, 12, 0));
    expect(result.state).toBe('closed');
    expect(result.label).toBe('本日は定休日です');
  });

  it('定休日の夜（本来の営業時間帯と同じ時刻）でもclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 31, 20, 0));
    expect(result.state).toBe('closed');
    expect(result.label).toBe('本日は定休日です');
  });

  it('定休日の翌日未明は前日(日曜)の持ち越しが無いのでclosed扱い', () => {
    // 日曜の営業(close=24:00)は日をまたがないため、月曜0:00は持ち越し無し。
    const result = getOpenStatus(hours, jst(2026, 8, 31, 0, 0));
    expect(result.state).toBe('closed');
  });

  it('営業日（火曜）は通常通りopen', () => {
    // 2026-09-01 は火曜
    const result = getOpenStatus(hours, jst(2026, 9, 1, 20, 0));
    expect(result.state).toBe('open');
  });
});

describe('getOpenStatus: 境界時刻ちょうど', () => {
  // 木曜のみ 18:00〜24:00（日をまたがない）。
  const hours: HourRule[] = [{ days: [4], open: '18:00', close: '24:00' }];

  it('close 1分前(23:59)はclosing-soon（残り1分は60分以内）', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 23, 59));
    expect(result.state).toBe('closing-soon');
  });

  it('close ちょうど(24:00 = 翌0:00)はclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 28, 0, 0));
    expect(result.state).toBe('closed');
  });

  it('closing-soon境界: 閉店60分前(23:00)ちょうどはclosing-soon', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 23, 0));
    expect(result.state).toBe('closing-soon');
  });

  it('closing-soon境界: 閉店61分前(22:59)はまだopen', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 22, 59));
    expect(result.state).toBe('open');
  });

  it('open ちょうど(18:00)はopen', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 18, 0));
    expect(result.state).toBe('open');
  });

  it('open 1分前(17:59)はclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 27, 17, 59));
    expect(result.state).toBe('closed');
  });
});

describe('getOpenStatus: 曜日ごとに異なる営業時間', () => {
  const hours: HourRule[] = [
    { days: [1, 2, 3, 4, 5], open: '18:00', close: '24:00' }, // 平日
    { days: [6], open: '17:00', close: '23:00' }, // 土曜のみ短縮営業
  ];

  it('土曜18:30は土曜ルールで営業中', () => {
    // 2026-08-29 は土曜
    const result = getOpenStatus(hours, jst(2026, 8, 29, 18, 30));
    expect(result.state).toBe('open');
  });

  it('土曜23:00（土曜ルールの閉店時刻）はclosed', () => {
    const result = getOpenStatus(hours, jst(2026, 8, 29, 23, 0));
    expect(result.state).toBe('closed');
  });

  it('日曜はどちらのruleにも該当せず定休日扱い', () => {
    // 2026-08-30 は日曜
    const result = getOpenStatus(hours, jst(2026, 8, 30, 20, 0));
    expect(result.state).toBe('closed');
    expect(result.label).toBe('本日は定休日です');
  });
});
