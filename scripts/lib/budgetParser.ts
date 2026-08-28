/**
 * scripts/lib/budgetParser.ts
 *
 * budget（予算目安の自由文字列。例: "￥3,000〜￥5,000"）から、
 * content.config.ts の budgetMin/budgetMax（数値・任意）を決定論的に
 * 抽出する。LLMは使わない（正規表現ベースの純粋関数）。
 *
 * 「￥」に続く数値をすべて拾い、最初の値を下限（budgetMin）、
 * 2番目の値を上限（budgetMax）とする。1つしか見つからない場合は
 * 単一価格とみなし、min/max双方に同じ値を設定する（範囲ではなく
 * 目安の一点だけが書かれているケースを、より情報量のある結果に
 * するため）。1つも見つからなければ両方ともundefined。
 */

export interface ParsedBudgetRange {
  min: number | undefined;
  max: number | undefined;
}

export function parseBudgetRange(budget: string): ParsedBudgetRange {
  const matches = [...budget.matchAll(/[￥¥]\s*([\d,]+)/g)];
  const values = matches
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((v) => Number.isFinite(v) && v > 0);

  if (values.length === 0) return { min: undefined, max: undefined };
  if (values.length === 1) return { min: values[0], max: values[0] };
  return { min: values[0], max: values[1] };
}
