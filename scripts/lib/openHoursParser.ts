/**
 * scripts/lib/openHoursParser.ts
 *
 * openHours（営業時間の自由文字列。例: "19:00〜02:00"）と regularHoliday
 * （定休日の自由文字列。例: "日曜日", "不定休", "年中無休（※...）"）から、
 * content.config.ts の構造化された hours（HourRule[]）を決定論的に導出する。
 * LLMは使わない（正規表現ベースの純粋関数）。
 *
 * 安全方針: 少しでも自信が持てないパターンは導出を諦め、hours を undefined
 * のまま返す。誤った営業時間（例: 実際は休みの曜日を「営業中」）を
 * Google検索結果やサイト内のOpenStatus/提灯表示に出すことの方が、
 * hours欠落によるunknown表示より実害が大きいため
 * （src/lib/hours.ts の設計方針、および content.config.ts の
 * isIrregularフラグと同じ考え方）。
 */

export interface ParsedHourRule {
  days: number[];
  open: string;
  close: string;
}

export interface ParseOpenHoursResult {
  hours: ParsedHourRule[] | undefined;
  /** hoursがundefinedのときのみ設定される、導出できなかった理由（WARN表示用）。 */
  reason?: string;
}

const WEEKDAY_TO_NUMBER: Record<string, number> = {
  日: 0,
  月: 1,
  火: 2,
  水: 3,
  木: 4,
  金: 5,
  土: 6,
};

/** "H:MM" / "HH:MM" を分単位の整数に変換する。不正な値は null。 */
function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 分単位の値を "H:MM" 表記に戻す（24を超える値もそのまま表記する。content.config.tsのhours仕様）。 */
function formatMinutes(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/**
 * regularHoliday に「不定休」という語が含まれるかを判定する。
 * content.config.ts の isIrregular フラグの導出元。generate-spot.ts が
 * このフラグをfrontmatterに書き込むかどうかの判定にも使う。
 */
export function isIrregularHoliday(regularHoliday: string): boolean {
  return regularHoliday.includes('不定休');
}

/**
 * regularHoliday から、休業する曜日の集合を判定する。
 * - "不定休" を含む → null（曜日を特定できない。呼び出し側で導出自体を諦める）
 * - "年中無休" を含む → 空集合（休業日なし）
 * - "第3日曜" 等の月内順序指定・"隔週" を含む → null（週次パターンで表現できない）
 * - それ以外 → 「日/月/火/水/木/金/土」+「曜」の正規表現で抽出。1つも
 *   見つからなければ null
 */
function extractClosedDays(regularHoliday: string): Set<number> | null {
  if (isIrregularHoliday(regularHoliday)) return null;
  if (regularHoliday.includes('年中無休')) return new Set();

  const hasOrdinalOrBiweekly = /第[1-5一二三四五]|隔週/.test(regularHoliday);
  if (hasOrdinalOrBiweekly) return null;

  const matches = [...regularHoliday.matchAll(/([日月火水木金土])曜/g)];
  if (matches.length === 0) return null;

  return new Set(matches.map((m) => WEEKDAY_TO_NUMBER[m[1]]));
}

/**
 * openHours から開店・閉店時刻を抽出する。区切り文字は実データ上
 * 「〜」（U+301C）と「～」（U+FF5E）の両方が混在して使われているため、
 * 主要なダッシュ/波ダッシュ類をまとめて許容する。末尾の「（L.O. 22:30）」
 * 等の注記は非アンカーマッチのため自然に無視される。
 */
function extractOpenClose(openHours: string): { openMinutes: number; closeMinutes: number } | null {
  const match = /(\d{1,2}:\d{2})\s*[〜～\-~−]\s*(\d{1,2}:\d{2})/.exec(openHours);
  if (!match) return null;

  const openMinutes = toMinutes(match[1]);
  const closeRaw = toMinutes(match[2]);
  if (openMinutes === null || closeRaw === null) return null;

  // 閉店が開店以下（=日をまたぐ）なら+24時間して経過時刻表記にする
  // （content.config.tsのhours仕様。例: 19:00〜02:00 → open:19:00, close:26:00）。
  const closeMinutes = closeRaw <= openMinutes ? closeRaw + 24 * 60 : closeRaw;
  return { openMinutes, closeMinutes };
}

export function parseOpenHoursToHours(openHours: string, regularHoliday: string): ParseOpenHoursResult {
  const closedDays = extractClosedDays(regularHoliday);
  if (closedDays === null) {
    return {
      hours: undefined,
      reason: `regularHoliday "${regularHoliday}" から休業曜日を特定できませんでした（不定休・第N曜日・隔週など）`,
    };
  }

  const times = extractOpenClose(openHours);
  if (times === null) {
    return {
      hours: undefined,
      reason: `openHours "${openHours}" から営業時間を特定できませんでした`,
    };
  }

  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => !closedDays.has(d));
  if (days.length === 0) {
    return {
      hours: undefined,
      reason: `regularHoliday "${regularHoliday}" の解釈上、全曜日が休業になり矛盾しています`,
    };
  }

  return {
    hours: [
      {
        days,
        open: formatMinutes(times.openMinutes),
        close: formatMinutes(times.closeMinutes),
      },
    ],
  };
}
