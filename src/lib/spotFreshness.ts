/**
 * src/lib/spotFreshness.ts
 *
 * 「新着店舗」セクション・詳細ページのNEWバッジは、店舗frontmatterの
 * pubDate（当サイトへの掲載日）が直近かどうかだけで判定する。
 *
 * 以前はAgent1（scripts/generate-spot.ts）が記事生成時点で一度だけ判定する
 * isNewフラグ（「開店・リニューアルオープンから約1年以内」＝お店自体の
 * 新しさ）を使っていたが、これには2つの問題があった:
 *
 * 1. isNewは生成後に一切更新されないため、開店から1年以上経った店でも
 *    永久にNEWバッジが付き続ける（2026年9月、Wine Bar MARGAUXで発生）。
 * 2. 「新着店舗」というセクション名は「サイトに最近追加された店」を
 *    自然に連想させるが、isNewは「お店自体が最近開店したか」を表す別の
 *    概念だった。老舗の紹介記事を今日公開しても（例: 1987年創業の
 *    Sato's Bar）isNewはfalseのままなので、直感と反した表示になっていた。
 *
 * isNew自体（お店の実際の新しさ）は記事本文の書き分けに今も使うため
 * frontmatterから削除しない（scripts/generate-spot.tsのWriterプロンプト
 * 参照）。ここではバッジ・並び順の判定基準を「サイト掲載の新しさ
 * （pubDate）」に一本化する。
 */

const RECENTLY_PUBLISHED_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** pubDateが直近 RECENTLY_PUBLISHED_DAYS 日以内なら、NEWバッジ・新着ソートで優先表示する。 */
export function isRecentlyPublished(pubDate: Date, now: Date = new Date()): boolean {
  const elapsedDays = (now.getTime() - pubDate.getTime()) / MS_PER_DAY;
  return elapsedDays <= RECENTLY_PUBLISHED_DAYS;
}
