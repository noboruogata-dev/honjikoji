/**
 * scripts/lib/news-freshness.ts
 *
 * ニュース記事として扱う出来事の「鮮度」判定。2年前のイベントを最新の
 * お知らせとして公開してしまった事故（本文自体は正確でも、一覧の最上部に
 * 出ることで「最近の出来事」と誤解される）を受けて、
 * scripts/generate-news.ts のAgent3（QA）向けに切り出した。
 * generate-news.ts は末尾でmain()を自動実行するモジュールのため、
 * テストから安全にimportできるよう、ここに置いている。
 */

/** ニュースとして扱う出来事の鮮度上限（ヶ月）。 */
export const FRESHNESS_LIMIT_MONTHS = 3;

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** eventDateがYYYY-MM-DD形式として妥当かどうか。 */
export function isValidIsoDate(eventDateIso: string): boolean {
  return ISO_DATE_PATTERN.test(eventDateIso) && !Number.isNaN(new Date(`${eventDateIso}T00:00:00Z`).getTime());
}

/** eventDateが鮮度上限内（開催予定を含む未来の日付は常に許容）かどうか。
 *  呼び出し側でisValidIsoDate済みの値を渡すこと（不正な値はfalseを返す）。 */
export function isWithinFreshnessLimit(eventDateIso: string, now: Date = new Date()): boolean {
  if (!isValidIsoDate(eventDateIso)) return false;
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - FRESHNESS_LIMIT_MONTHS);
  return new Date(`${eventDateIso}T00:00:00Z`).getTime() >= limit.getTime();
}

/**
 * 日本時間（Asia/Tokyo）での「今日」をYYYY-MM-DD形式で返す。
 * GitHub ActionsのランナーはUTCで動くため、`new Date().toISOString()`を
 * そのまま使うと日本時間の日付とズレる（特にJST 0:00〜9:00の間はUTC側が
 * 前日になる）。scripts/generate-column.tsのtodayInTokyo()と同じ実装。
 */
export function todayInTokyo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * eventDateが「今日（日本時間）以降」かどうか。単純な出来事（祭り・
 * イベント等、その日を過ぎたら終わるもの）が既に終わっているかどうかの
 * 判定に使う（3ヶ月以内かどうかを見るisWithinFreshnessLimitとは別軸）。
 * 呼び出し側でisValidIsoDate済みの値を渡すこと（不正な値はfalseを返す）。
 */
export function isTodayOrFuture(eventDateIso: string, todayIso: string = todayInTokyo()): boolean {
  if (!isValidIsoDate(eventDateIso)) return false;
  return eventDateIso >= todayIso;
}

/** "2024-07-23" -> "2024年7月"（Job Summary用の日本語表記）。 */
export function formatJapaneseYearMonth(eventDateIso: string): string {
  const [year, month] = eventDateIso.split('-');
  return `${year}年${Number(month)}月`;
}
