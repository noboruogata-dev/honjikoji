/**
 * src/lib/shinise.ts
 *
 * 「老舗」バッジ: 店舗frontmatterの establishedYear（開業年。西暦）から、
 * 開業からの経過年数が50年以上かどうかを判定する。
 *
 * establishedYearは、Agent1（scripts/generate-spot.ts）がGoogle Search
 * Groundingで確度高く開業年を確認できた場合のみ設定する任意フィールド
 * （不明なら省略。isNew/socialLinks等、他の任意フィールドと同じ「自信が
 * 持てないなら創作せず省略する」方針）。既存店舗の多くは現時点で
 * establishedYearが未設定のため、バックフィルするまでバッジは出ない。
 */

const SHINISE_MIN_YEARS = 50;

/** establishedYearが無ければfalse。あれば、今年との差がSHINISE_MIN_YEARS以上かで判定する。 */
export function isShinise(establishedYear: number | undefined, now: Date = new Date()): boolean {
  if (establishedYear === undefined) return false;
  return now.getFullYear() - establishedYear >= SHINISE_MIN_YEARS;
}
