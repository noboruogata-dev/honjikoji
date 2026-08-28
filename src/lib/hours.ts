/**
 * src/lib/hours.ts
 *
 * 店舗の構造化営業時間（content.config.ts の `hours`）から、
 * 「今この瞬間」の営業状況を判定する。
 *
 * 設計方針:
 * - 判定は常に Asia/Tokyo のローカル時刻で行う（閲覧者のブラウザのタイムゾーンに
 *   依存させない）。
 * - 日をまたぐ営業（例: 19:00開店・翌2:00閉店）を正しく扱う。データ上は
 *   close を 24 を超える値（26:00 等）で表現し、判定時に「昨日の営業が今日へ
 *   持ち越されている」ケースを明示的にチェックする。
 * - 少しでも判定に自信が持てない場合（データ欠損・不正・曜日情報の取得失敗）は
 *   'open' / 'closing-soon' ではなく 'unknown' に倒す。誤って「営業中」と
 *   表示することが最も避けたい失敗のため。
 */

export type OpenState = 'open' | 'closing-soon' | 'closed' | 'unknown';

export interface HourRule {
  /** 0=日曜, 1=月曜, ... 6=土曜。この区間の「営業開始日」を表す。 */
  days: number[];
  /** 営業開始時刻（"H:MM" または "HH:MM"）。 */
  open: string;
  /**
   * 営業終了時刻。当日0:00からの経過時刻として24を超える値を許容する
   * （例: 翌2:00閉店 = "26:00"）。
   */
  close: string;
}

export interface OpenStatusResult {
  state: OpenState;
  label: string;
  /** 次に状態が変わる時刻（"H:MM"表記、closeと同じ「24を超えてよい」表記）。 */
  nextChange?: string;
}

const TIME_ZONE = 'Asia/Tokyo';
const CLOSING_SOON_THRESHOLD_MINUTES = 60;
const UNKNOWN_LABEL = '営業時間は店舗にご確認ください';

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function unknown(): OpenStatusResult {
  return { state: 'unknown', label: UNKNOWN_LABEL };
}

/** "H:MM" / "HH:MM" 形式（24を超える値も可）を分単位の整数に変換する。不正な値は null。 */
function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 分単位の値を "H:MM" 表記に戻す（24を超える値もそのまま表記する）。 */
function formatMinutes(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

/** 現在時刻をAsia/Tokyoのローカル「曜日・当日の分」に変換する。取得できなければ null。 */
function getTokyoNow(now: Date): { weekday: number; minutesOfDay: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return null;
  }

  const weekdayName = parts.find((p) => p.type === 'weekday')?.value;
  const hourStr = parts.find((p) => p.type === 'hour')?.value;
  const minuteStr = parts.find((p) => p.type === 'minute')?.value;
  if (!weekdayName || !hourStr || !minuteStr) return null;

  const weekday = WEEKDAY_INDEX[weekdayName];
  if (weekday === undefined) return null;

  // 一部の実装は hour12:false でも真夜中を "24" として返すため 0 に正規化する。
  let hour = Number(hourStr);
  if (hour === 24) hour = 0;
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return { weekday, minutesOfDay: hour * 60 + minute };
}

interface ValidRule {
  days: number[];
  openMinutes: number;
  closeMinutes: number; // 24hを超えてよい
}

/** ruleを検証し、判定に使える形へ変換する。壊れているruleは除外する。 */
function toValidRules(hours: HourRule[]): ValidRule[] {
  const result: ValidRule[] = [];
  for (const rule of hours) {
    const openMinutes = parseTimeToMinutes(rule.open);
    const closeMinutes = parseTimeToMinutes(rule.close);
    if (openMinutes === null || closeMinutes === null) continue;
    if (closeMinutes <= openMinutes) continue; // 経過時刻表記である以上、close > open が必須
    const days = rule.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length === 0) continue;
    result.push({ days, openMinutes, closeMinutes });
  }
  return result;
}

export function getOpenStatus(
  hours: HourRule[] | undefined,
  now: Date = new Date()
): OpenStatusResult {
  if (!hours || hours.length === 0) return unknown();

  const validRules = toValidRules(hours);
  if (validRules.length === 0) return unknown();

  const tokyoNow = getTokyoNow(now);
  if (!tokyoNow) return unknown();

  const { weekday: todayWeekday, minutesOfDay: todayMinutes } = tokyoNow;
  const yesterdayWeekday = (todayWeekday + 6) % 7;

  // 1) 今日開始のruleで、現在が営業区間内か
  for (const rule of validRules) {
    if (!rule.days.includes(todayWeekday)) continue;
    if (todayMinutes >= rule.openMinutes && todayMinutes < rule.closeMinutes) {
      const remaining = rule.closeMinutes - todayMinutes;
      return buildOpenResult(remaining, rule.closeMinutes);
    }
  }

  // 2) 昨日開始・日またぎで今日に持ち越されているruleか
  for (const rule of validRules) {
    if (!rule.days.includes(yesterdayWeekday)) continue;
    if (rule.closeMinutes <= 24 * 60) continue; // 日をまたがないruleは対象外
    const spillEnd = rule.closeMinutes - 24 * 60;
    if (todayMinutes < spillEnd) {
      const remaining = spillEnd - todayMinutes;
      return buildOpenResult(remaining, spillEnd);
    }
  }

  // 3) 営業中ではない。今日これから開店するruleがあれば案内する。
  const upcomingToday = validRules
    .filter((rule) => rule.days.includes(todayWeekday) && todayMinutes < rule.openMinutes)
    .sort((a, b) => a.openMinutes - b.openMinutes)[0];
  if (upcomingToday) {
    return {
      state: 'closed',
      label: '営業時間外',
      nextChange: formatMinutes(upcomingToday.openMinutes),
    };
  }

  // 今日に対応するruleが（開始としても持ち越しとしても）一切無ければ定休日。
  const hasAnyRuleForToday =
    validRules.some((rule) => rule.days.includes(todayWeekday)) ||
    validRules.some((rule) => rule.days.includes(yesterdayWeekday) && rule.closeMinutes > 24 * 60);
  if (!hasAnyRuleForToday) {
    return { state: 'closed', label: '本日は定休日です' };
  }

  return { state: 'closed', label: '営業時間外' };
}

function buildOpenResult(remainingMinutes: number, closeAtMinutes: number): OpenStatusResult {
  const nextChange = formatMinutes(closeAtMinutes);
  if (remainingMinutes <= CLOSING_SOON_THRESHOLD_MINUTES) {
    return { state: 'closing-soon', label: 'まもなく閉店', nextChange };
  }
  return { state: 'open', label: '営業中', nextChange };
}

/**
 * 表示用に組み立て済みのラベル文字列（例: "営業中（02:00）"）に、
 * 不定休の店（spot.data.isIrregular）であれば末尾へ「（不定休）」を
 * 付け加える。OpenStatus.astro（バッジ表示）と src/pages/map/index.astro
 * （路地マップのツールチップ・aria-label）の両方から呼ぶ共通ロジック。
 *
 * open/closing-soon のときだけ付け加える: closedは休みであること自体は
 * 確定しているため但し書き不要、unknownは営業状況自体が判定不能なため
 * 「不定休」を強調する意味が薄いため。
 */
export function withIrregularNotice(label: string, state: OpenState, isIrregular: boolean | undefined): string {
  if (!isIrregular) return label;
  if (state !== 'open' && state !== 'closing-soon') return label;
  return `${label}（不定休）`;
}
