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

/**
 * "H:MM" / "HH:MM" を分単位の整数に変換する。不正な値は null。
 * scripts/lib/hoursComparison.ts でも再利用するためexportする。
 */
export function toMinutes(value: string): number | null {
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

interface OpenCloseRange {
  openMinutes: number;
  closeMinutes: number;
  /**
   * この営業帯の直前のテキストに曜日限定の記載があれば、その曜日集合
   * （例: [2, 3, 5, 6]＝火・水・金・土）。無ければundefined＝呼び出し側で
   * regularHoliday由来のデフォルト曜日集合を使う。
   */
  days?: number[];
}

/**
 * 「火・水・金・土曜」（曜は末尾にまとめて1つだけ）と「月曜・水曜・金曜」
 * （各曜日ごとに曜が付く）の両方の表記にマッチする。
 */
const WEEKDAY_GROUP_RE = /(?:[日月火水木金土][・、,]?)+曜/g;

/**
 * ある営業帯の直前のテキスト（segment）から、その営業帯だけに適用される
 * 曜日限定を抽出する。見つからなければnull（呼び出し側でデフォルトの曜日
 * 集合を使う）。1つのsegmentに複数マッチしても（「月曜・水曜・金曜」は
 * WEEKDAY_GROUP_REの仕様上3回に分かれてマッチする）、すべての曜日の
 * 和集合を返す。
 */
function extractWeekdaysFromSegment(segment: string): number[] | null {
  const matches = [...segment.matchAll(WEEKDAY_GROUP_RE)];
  if (matches.length === 0) return null;

  const days = new Set<number>();
  for (const match of matches) {
    for (const ch of match[0]) {
      const day = WEEKDAY_TO_NUMBER[ch];
      if (day !== undefined) days.add(day);
    }
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

/**
 * openHours から開店・閉店時刻の組を「すべて」抽出する。「11:30〜14:00、
 * 17:30〜22:00」のように昼の部・夜の部が併記される営業時間は実データ上
 * 珍しくないため、最初の1組だけ拾って残りを無視すると、実際には営業して
 * いる時間帯（多くの場合は夜の部）が丸ごとhoursから欠落し、OpenStatus等が
 * 「営業時間外」と誤表示する（かつてこのバグで実際に発生した）。
 *
 * 区切り文字は実データ上「〜」（U+301C）と「～」（U+FF5E）の両方が混在して
 * 使われているため、主要なダッシュ/波ダッシュ類をまとめて許容する。末尾の
 * 「（L.O. 22:30）」等の注記は非アンカーマッチのため自然に無視される。
 *
 * 各組の直前のテキストに曜日限定の記載（例: "昼営業 火・水・金・土曜
 * 12:00〜14:30"）があれば、その営業帯専用の曜日集合として一緒に返す
 * （呼び出し側 parseOpenHoursToHours が、無ければregularHoliday由来の
 * デフォルト曜日集合にフォールバックする）。これが無い旧実装では、営業帯
 * ごとに異なる曜日限定（例: 夜は毎日・昼は一部曜日のみ）が失われ、実際には
 * 休みの曜日を「営業中」と誤表示することがあった。
 *
 * いずれかの組の時刻表記が不正な場合はnull（安全方針: 一部だけ解釈して
 * 残りを無視するくらいなら導出自体を諦める。extractClosedDaysと同じ考え方）。
 */
function extractOpenCloseRanges(openHours: string): OpenCloseRange[] | null {
  const matches = [...openHours.matchAll(/(\d{1,2}:\d{2})\s*[〜～\-~−]\s*(\d{1,2}:\d{2})/g)];
  if (matches.length === 0) return null;

  const ranges: OpenCloseRange[] = [];
  let previousEnd = 0;
  for (const match of matches) {
    const openMinutes = toMinutes(match[1]);
    const closeRaw = toMinutes(match[2]);
    if (openMinutes === null || closeRaw === null) return null;

    // 閉店が開店以下（=日をまたぐ）なら+24時間して経過時刻表記にする
    // （content.config.tsのhours仕様。例: 19:00〜02:00 → open:19:00, close:26:00）。
    const closeMinutes = closeRaw <= openMinutes ? closeRaw + 24 * 60 : closeRaw;

    const matchStart = match.index ?? previousEnd;
    const segment = openHours.slice(previousEnd, matchStart);
    const days = extractWeekdaysFromSegment(segment) ?? undefined;

    ranges.push({ openMinutes, closeMinutes, days });
    previousEnd = matchStart + match[0].length;
  }
  return ranges;
}

export function parseOpenHoursToHours(openHours: string, regularHoliday: string): ParseOpenHoursResult {
  const closedDays = extractClosedDays(regularHoliday);
  if (closedDays === null) {
    return {
      hours: undefined,
      reason: `regularHoliday "${regularHoliday}" から休業曜日を特定できませんでした（不定休・第N曜日・隔週など）`,
    };
  }

  const ranges = extractOpenCloseRanges(openHours);
  if (ranges === null) {
    return {
      hours: undefined,
      reason: `openHours "${openHours}" から営業時間を特定できませんでした`,
    };
  }

  const defaultDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !closedDays.has(d));
  if (defaultDays.length === 0) {
    return {
      hours: undefined,
      reason: `regularHoliday "${regularHoliday}" の解釈上、全曜日が休業になり矛盾しています`,
    };
  }

  // 昼の部・夜の部のように複数の営業帯がある場合、営業帯ごとの直前テキストに
  // 曜日限定の記載（例: "昼営業 火・水・金・土曜"）があればそれを使い、
  // 無ければregularHoliday由来のデフォルト曜日集合にフォールバックする
  // （extractOpenCloseRangesのコメント参照）。
  //
  // 営業帯固有の曜日指定がregularHoliday上の休業曜日と矛盾する場合（例:
  // 定休日のはずの曜日にその営業帯があると書かれている）は、どちらが正しいか
  // openHours/regularHolidayの自由文からは判別できずデータの整合性を信頼
  // できないため、他の安全方針と同じく導出自体を諦める。
  const hours: ParsedHourRule[] = [];
  for (const range of ranges) {
    if (range.days) {
      const conflicting = range.days.filter((d) => closedDays.has(d));
      if (conflicting.length > 0) {
        return {
          hours: undefined,
          reason: `openHours "${openHours}" の曜日指定がregularHoliday "${regularHoliday}" の休業曜日と矛盾しています`,
        };
      }
    }
    hours.push({
      days: range.days ?? defaultDays,
      open: formatMinutes(range.openMinutes),
      close: formatMinutes(range.closeMinutes),
    });
  }

  return { hours };
}
