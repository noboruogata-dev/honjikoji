/**
 * src/lib/liveHoursFormat.ts
 *
 * Google Place Details (New) の weekdayDescriptions（曜日ごとの営業時間
 * 説明7行。例: "月曜日: 11時00分〜14時00分, 17時00分〜20時30分" /
 * "火曜日: 定休日"）を、同じ営業時間の曜日をまとめたコンパクトな表示用
 * データに変換する（src/components/LivePlaceHours.astro が使う）。
 *
 * ここでの変換はページ表示のたびのライブ整形であり、変換結果（曜日
 * ラベル・"H:MM"表記の時刻文字列）をこのリポジトリやビルド成果物に
 * 保存することはない（保存禁止はGoogle Maps Platform利用規約対応。
 * LivePlaceHours.astro冒頭コメント参照）。
 *
 * 安全方針: Places APIのレスポンス形式が変わる、または1行でも想定外の
 * 書式（曜日名の表記ゆれ・「24時間営業」等の特殊表記）だった場合は、
 * 無理に解釈せずparseWeekdayDescriptionsがnullを返す。呼び出し側は
 * その場合、要約を諦めて7行そのままの表示にフォールバックすること
 * （誤った要約よりは、生データのままの方が安全という既存の設計方針
 * を踏襲する）。
 */

// Places APIのweekdayDescriptionsは常に月曜始まり（月→日）の7要素で返る。
// 曜日の並び順（範囲表示"月〜金"の判定・表示に使う）はこの順序を前提にする。
const DAY_SHORT_ORDER = ['月', '火', '水', '木', '金', '土', '日'];

export interface DayHours {
  /** 完全な曜日ラベル（例: "月曜日"）。定休日行の表示に使う。 */
  label: string;
  /** 単漢字の曜日（例: "月"）。営業時間行のグループラベルに使う。 */
  short: string;
  /** DAY_SHORT_ORDER上の位置（0=月〜6=日）。連続曜日の判定に使う。 */
  pos: number;
  /** 定休日ならnull。営業帯ごとの "H:MM〜H:MM" 文字列の配列（複数部制に対応）。 */
  ranges: string[] | null;
}

export interface FormattedHours {
  /** 営業時間の行（1件以上。複数曜日グループがある場合は複数行）。 */
  openLines: string[];
  /** 定休日の行（定休日が無ければundefined）。 */
  closedLine?: string;
}

/**
 * "H時MM分" を "H:MM" に変換する。日をまたぐ場合（閉店時刻 <= 開店時刻）は
 * サイト内の他の営業時間表記と同じ「経過時刻」表記に揃える
 * （例: 20:00〜4:00 → 20:00〜28:00。src/content.config.ts の hours 仕様参照）。
 */
export function formatRange(openH: number, openM: number, closeH: number, closeM: number): string {
  const openMinutes = openH * 60 + openM;
  let closeMinutes = closeH * 60 + closeM;
  if (closeMinutes <= openMinutes) closeMinutes += 24 * 60;
  const openText = `${openH}:${String(openM).padStart(2, '0')}`;
  const closeText = `${Math.floor(closeMinutes / 60)}:${String(closeMinutes % 60).padStart(2, '0')}`;
  return `${openText}〜${closeText}`;
}

/** weekdayDescriptions（7行）を解析する。1行でも想定外の書式ならnullを返す。 */
export function parseWeekdayDescriptions(lines: string[]): DayHours[] | null {
  if (lines.length !== 7) return null;

  const result: DayHours[] = [];
  for (const line of lines) {
    const lineMatch = /^(.+?)[:：]\s*(.+)$/.exec(line.trim());
    if (!lineMatch) return null;
    const label = lineMatch[1].trim();
    const shortChar = label.charAt(0);
    const pos = DAY_SHORT_ORDER.indexOf(shortChar);
    if (pos === -1) return null;

    const rest = lineMatch[2].trim();
    if (rest === '定休日') {
      result.push({ label, short: shortChar, pos, ranges: null });
      continue;
    }

    const ranges: string[] = [];
    for (const part of rest.split(/[,、]\s*/)) {
      const rangeMatch = /^(\d{1,2})時(\d{1,2})分\s*[〜～\-~]\s*(\d{1,2})時(\d{1,2})分$/.exec(part.trim());
      if (!rangeMatch) return null;
      ranges.push(
        formatRange(Number(rangeMatch[1]), Number(rangeMatch[2]), Number(rangeMatch[3]), Number(rangeMatch[4]))
      );
    }
    if (ranges.length === 0) return null;
    result.push({ label, short: shortChar, pos, ranges });
  }
  return result;
}

/**
 * 3日以上が暦順で連続していれば "月〜金" のような範囲表記、そうでなければ
 * "月・水" のような列挙表記にする。daysは呼び出し側でpos昇順にソート済みのこと。
 */
function formatDayList(days: DayHours[], useLabel: boolean): string {
  const isContiguous = days.length >= 3 && days.every((d, i) => i === 0 || d.pos === days[i - 1].pos + 1);
  const text = (d: DayHours) => (useLabel ? d.label : d.short);
  if (isContiguous) return `${text(days[0])}〜${text(days[days.length - 1])}`;
  return days.map(text).join('・');
}

/**
 * 解析済みの7日分から、表示用の営業時間・定休日の行を組み立てる。
 * 営業日全体が単一の営業帯なら、曜日ラベルを付けずシンプルに1行で示す
 * （全曜日共通なら曜日ラベルは冗長なため）。曜日によって営業帯が異なる
 * 場合のみ、営業帯ごとに曜日グループを付けた行に分ける。
 */
export function formatHours(days: DayHours[]): FormattedHours {
  const closedDays = days.filter((d) => d.ranges === null);
  const openDays = days.filter((d): d is DayHours & { ranges: string[] } => d.ranges !== null);

  // 営業日を「同じ営業帯（曜日をまたいでも可）」ごとにグループ化する。
  const groups = new Map<string, DayHours[]>();
  for (const day of openDays) {
    const signature = day.ranges.join('|');
    const group = groups.get(signature);
    if (group) group.push(day);
    else groups.set(signature, [day]);
  }

  const openLines: string[] = [];
  if (groups.size <= 1) {
    const [only] = groups.values();
    if (only) openLines.push(only[0].ranges!.join('、'));
  } else {
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.pos - b.pos);
      openLines.push(`${formatDayList(sorted, false)} ${sorted[0].ranges!.join('、')}`);
    }
  }

  const closedLine = closedDays.length > 0 ? formatDayList(closedDays, true) : undefined;
  return { openLines, closedLine };
}
