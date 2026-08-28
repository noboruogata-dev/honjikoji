/**
 * src/lib/structuredData.ts
 *
 * JSON-LD（schema.org構造化データ）の組み立てに使う、決定論的な変換ヘルパー。
 * ここにあるのは「既存データを正しい形式に変換するだけ」の純粋関数のみで、
 * 新しい事実を推測・創作するものは置かない（誤った構造化データは検索結果に
 * 誤情報を出すため）。
 */

import type { HourRule } from './hours';

// ============================================================
// 住所
// ============================================================

export interface SchemaPostalAddress {
  '@type': 'PostalAddress';
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  addressCountry: string;
}

/**
 * content.config.ts の address（自由文字列、例:
 * "新潟県三条市本町2-5-1 角吾ビル 2F"）から PostalAddress を組み立てる。
 * addressLocality/addressRegion/addressCountry はサイトの対象エリアそのもの
 * （新潟県三条市）を表す固定値であり、店舗ごとの推測ではない。streetAddress は
 * 既存の address 文字列をそのまま使い、分割・書き換えは行わない
 * （"新潟県三条市"が重複して入るが、誤りではないため許容する）。
 */
export function buildSpotAddress(address: string): SchemaPostalAddress {
  return {
    '@type': 'PostalAddress',
    streetAddress: address,
    addressLocality: '三条市',
    addressRegion: '新潟県',
    addressCountry: 'JP',
  };
}

// ============================================================
// Googleマップ
// ============================================================

/**
 * mapQuery（例: "Bar Keywest 三条市"）からGoogleマップの検索URLを組み立てる。
 * src/components/MapEmbed.astro の externalUrl と同じ組み立て方（APIキー不要の
 * 検索リンク方式）。
 */
export function buildGoogleMapsUrl(mapQuery: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`;
}

// ============================================================
// 不定休の判定（openingHoursSpecificationを出すべきでない店の判定）
// ============================================================

/**
 * regularHoliday（表示用の自由文字列）に「不定休」という語が含まれるかを判定する。
 *
 * content.config.ts の hours は「その曜日に共通する1つの営業区間」という
 * 前提のフィールドだが、不定休の店では実際に何曜日が休みか特定できないため、
 * 便宜上「毎日その時間帯で営業している」という形でhoursに登録されていることが
 * ある（例: Bar Keywest）。この状態のままopeningHoursSpecificationを出力すると、
 * Googleの検索結果に「本来休んでいる日でも営業中」という誤情報が表示されうる。
 * サイト内表示（OpenStatus等）より外部への影響が大きいため、不定休と判断できる
 * 店では構造化データのopeningHoursSpecification自体を省略する
 * （呼び出し側でこの関数の結果を見て、buildOpeningHoursSpecificationの呼び出し
 * 自体をスキップすること）。
 */
export function hasIrregularHoliday(regularHoliday: string): boolean {
  return regularHoliday.includes('不定休');
}

// ============================================================
// 営業時間（hours → openingHoursSpecification）
// ============================================================

export interface SchemaOpeningHoursSpecification {
  '@type': 'OpeningHoursSpecification';
  dayOfWeek: string[];
  opens: string;
  closes: string;
}

const SCHEMA_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** "H:MM" / "HH:MM"（24を超える値も可）を分単位の整数に変換する。不正な値は null。 */
function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 分単位の値をGoogle/schema.orgが要求する当日0:00〜23:59の "HH:MM"（2桁ゼロ埋め）
 * にラップして変換する。24を超える値（例: 26:00 = 1560分）は翌日の時刻として
 * ラップする（1560 % 1440 = 120分 = "02:00"）。
 *
 * これは content.config.ts の hours が採用する「24を超えてよい経過時刻表記」とは
 * 逆方向の変換であることに注意。schema.orgの仕様上、日をまたぐ営業は
 * 24時間超表記ではなく、opens/closesを当日内の時刻にラップしたうえで
 * 「closes < opens なら翌日まで営業」と解釈させるのが正しい表現方法
 * （Google公式のLocalBusiness構造化データガイドで確認済み。例:
 * 土曜18:00開店・日曜3:00閉店 → dayOfWeek:"Saturday", opens:"18:00",
 * closes:"03:00"）。
 */
function formatSchemaTime(totalMinutes: number): string {
  const MINUTES_PER_DAY = 24 * 60;
  const wrapped = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function dayNumberToSchemaName(day: number): string | null {
  return SCHEMA_DAY_NAMES[day] ?? null;
}

/**
 * content.config.ts の hours（HourRule[]、任意）から openingHoursSpecification
 * の配列を組み立てる。hours が無い・空・全ruleが不正な場合は undefined を返す
 * （呼び出し側はこれを見て openingHoursSpecification フィールド自体を省略する）。
 *
 * 不定休の店（hasIrregularHoliday）を除外する判断は、この関数の責務ではなく
 * 呼び出し側で行う（hours自体は「不定休かどうか」を知らないデータのため）。
 */
export function buildOpeningHoursSpecification(
  hours: HourRule[] | undefined
): SchemaOpeningHoursSpecification[] | undefined {
  if (!hours || hours.length === 0) return undefined;

  const specs: SchemaOpeningHoursSpecification[] = [];
  for (const rule of hours) {
    const openMinutes = parseTimeToMinutes(rule.open);
    const closeMinutes = parseTimeToMinutes(rule.close);
    if (openMinutes === null || closeMinutes === null) continue;
    if (closeMinutes <= openMinutes) continue; // 経過時刻表記である以上、close > open が必須

    const dayOfWeek = rule.days
      .map(dayNumberToSchemaName)
      .filter((name): name is string => name !== null);
    if (dayOfWeek.length === 0) continue;

    specs.push({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek,
      opens: formatSchemaTime(openMinutes),
      closes: formatSchemaTime(closeMinutes),
    });
  }

  return specs.length > 0 ? specs : undefined;
}
