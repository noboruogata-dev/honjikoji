/**
 * scripts/lib/hoursComparison.ts
 *
 * Agent 1由来の hours（openHoursParser.ts が導出した構造化営業時間）と、
 * Google Place Details (New) の regularOpeningHours.periods を比較し、
 * 乖離を検出する。目的は「検証のみ」— Places API由来の値そのものは
 * 一切保存・出力しない（Google Maps Platform利用規約上、opening hoursの
 * 永続保存は許可されていないため）。
 *
 * 出力する情報は「差分の有無」「差分の大きさ（分）」「差分がある曜日名」
 * のみに限定する。これらは私たちが計算した派生情報であり、Googleが
 * 返した実際の時刻文字列そのものではないため、Job Summary等の永続的な
 * 記録に残しても規約上の問題にならない（詳細はscripts/generate-spot.ts
 * の該当コメント、およびユーザーとの合意事項を参照）。
 */

import type { GoogleOpeningPeriod } from './googlePlaces.js';
import type { ParsedHourRule } from './openHoursParser.js';
import { toMinutes } from './openHoursParser.js';

const WEEKDAY_LABELS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

interface DayRange {
  openMinutes: number;
  closeMinutes: number;
}

export interface HoursComparisonResult {
  hasMismatch: boolean;
  /** 検出した差分のうち最大のもの（分）。構造的な食い違い（営業/休業の有無自体が違う）を含む場合はNumber.POSITIVE_INFINITYではなく便宜上1440を上限とする。 */
  maxDiffMinutes: number;
  /** 差分を検出した曜日名（"火曜日"等）。Googleの実際の時刻は含まない。 */
  mismatchedDays: string[];
}

/** ParsedHourRule[]（Agent1由来）を、曜日ごとの営業帯リストに展開する。 */
function expandOursToDayMap(hours: ParsedHourRule[]): Map<number, DayRange[]> {
  const map = new Map<number, DayRange[]>();
  for (const rule of hours) {
    const openMinutes = toMinutes(rule.open);
    const closeMinutes = toMinutes(rule.close);
    if (openMinutes === null || closeMinutes === null) continue;
    for (const day of rule.days) {
      const list = map.get(day) ?? [];
      list.push({ openMinutes, closeMinutes });
      map.set(day, list);
    }
  }
  return map;
}

/**
 * GoogleOpeningPeriod[] を、曜日（open.day基準）ごとの営業帯リストに展開する。
 * closeがopenの翌日以降にまたがる場合は、ours側と同じ「経過時刻（24を超えて
 * よい）」表記に揃える（例: 月曜19:00開店・火曜1:30閉店 → openMinutes=19:00分,
 * closeMinutes=25:30分相当）。
 */
function expandGoogleToDayMap(periods: GoogleOpeningPeriod[]): Map<number, DayRange[]> {
  const map = new Map<number, DayRange[]>();
  for (const period of periods) {
    const day = period.open.day;
    const openMinutes = period.open.hour * 60 + period.open.minute;
    const dayDiff = (period.close.day - period.open.day + 7) % 7;
    const closeMinutes = dayDiff * 24 * 60 + period.close.hour * 60 + period.close.minute;
    const list = map.get(day) ?? [];
    list.push({ openMinutes, closeMinutes });
    map.set(day, list);
  }
  return map;
}

/**
 * 同じ曜日の営業帯リスト同士を比較する。営業帯の「数」自体が食い違う場合
 * （片方だけ休業、片方だけ2部制、等）は構造的な食い違いとしてnullを返す。
 * 数が一致する場合は開店時刻順に並べてペアごとの差分（分）の最大値を返す。
 */
function diffDayRanges(a: DayRange[], b: DayRange[]): number | null {
  if (a.length !== b.length) return null;
  if (a.length === 0) return 0;

  const sortedA = [...a].sort((x, y) => x.openMinutes - y.openMinutes);
  const sortedB = [...b].sort((x, y) => x.openMinutes - y.openMinutes);

  let max = 0;
  for (let i = 0; i < sortedA.length; i += 1) {
    const openDiff = Math.abs(sortedA[i].openMinutes - sortedB[i].openMinutes);
    const closeDiff = Math.abs(sortedA[i].closeMinutes - sortedB[i].closeMinutes);
    max = Math.max(max, openDiff, closeDiff);
  }
  return max;
}

const STRUCTURAL_MISMATCH_MINUTES = 24 * 60;

/**
 * Agent1由来のhoursとGoogleのregularOpeningHours.periodsを比較する。
 * @param thresholdMinutes この分数以上の差分がある曜日を「乖離あり」として報告する（既定15分）。
 */
export function compareHoursWithGoogle(
  ours: ParsedHourRule[],
  googlePeriods: GoogleOpeningPeriod[],
  thresholdMinutes = 15
): HoursComparisonResult {
  const oursMap = expandOursToDayMap(ours);
  const googleMap = expandGoogleToDayMap(googlePeriods);

  let maxDiffMinutes = 0;
  const mismatchedDays: string[] = [];

  for (let day = 0; day < 7; day += 1) {
    const diff = diffDayRanges(oursMap.get(day) ?? [], googleMap.get(day) ?? []);

    if (diff === null) {
      mismatchedDays.push(WEEKDAY_LABELS[day]);
      maxDiffMinutes = Math.max(maxDiffMinutes, STRUCTURAL_MISMATCH_MINUTES);
      continue;
    }
    if (diff >= thresholdMinutes) {
      mismatchedDays.push(WEEKDAY_LABELS[day]);
    }
    maxDiffMinutes = Math.max(maxDiffMinutes, diff);
  }

  return {
    hasMismatch: mismatchedDays.length > 0,
    maxDiffMinutes,
    mismatchedDays,
  };
}
