/**
 * scripts/lib/sourceVerification.ts
 *
 * Agent 5（出典照合）の非LLM部分: プロンプト構築・スキーマ・ブロッキング判定。
 * LLM呼び出し自体（scripts/generate-spot.ts の runSourceVerificationAgent）と
 * 分離することで、閾値判定ロジックをGemini APIを呼ばずに単体テストできる
 * ようにする（scripts/lib/hoursComparison.ts と同じ考え方）。
 *
 * 背景: Wine Bar MARGAUXの記事で、Google Search Groundingの引用が0件の
 * まま「毎週金曜日にジャズの生演奏イベントが開催されている」という
 * 裏付けのない記述が公開された（2026年9月）。この件は既にGrounding引用0件を
 * ブロッキングする対策（groundingSourceCount === 0 のチェック）で対応
 * 済みだが、それとは独立に「LLMに『この記述は正しいか』と真偽判定させても
 * 機能しない（もっともらしい記述ほど『正しい』と答えてしまう）」という
 * 課題がある。そこでAgent 5は真偽そのものを判定せず、「Agent 2が書いた
 * 記述が、Agent 1の調査データのどこかに対応しているか」という、より機械的で
 * 検証可能な問いにすり替えて判定する。
 */

import { z } from 'zod';

/** Agent 5（LLM）が返す、本文中の断定的記述1件分の判定。 */
export const sourceVerificationClaimSchema = z.object({
  statement: z.string(),
  hasSource: z.boolean(),
  /** hasSource: true の場合のみ、根拠となった調査データの項目名（例: "facts", "openHours"）。 */
  sourceField: z.string().optional(),
});
export type SourceVerificationClaim = z.infer<typeof sourceVerificationClaimSchema>;

export const sourceVerificationResponseSchema = z.object({
  claims: z.array(sourceVerificationClaimSchema),
});
export type SourceVerificationResponse = z.infer<typeof sourceVerificationResponseSchema>;

/**
 * ブロッキング閾値。後から調整できるよう定数として切り出す
 * （ユーザーとの合意事項。運用実績を見て変更する想定）。
 */
export const UNSOURCED_CLAIMS_MIN_COUNT = 3;
export const UNSOURCED_CLAIMS_MAX_RATIO = 0.3;

export interface SourceVerificationEvaluation {
  totalClaims: number;
  unsourcedStatements: string[];
  unsourcedCount: number;
  /** totalClaimsが0の場合は0（0/0を避けるため）。 */
  unsourcedRatio: number;
  shouldBlock: boolean;
}

/**
 * Agent 5が抽出・判定した記述一覧から、ブロッキング要否を決定論的に判定する。
 * 出典なし（hasSource: false）の件数が UNSOURCED_CLAIMS_MIN_COUNT 件以上、
 * または全断定表現に占める割合が UNSOURCED_CLAIMS_MAX_RATIO 以上ならブロック。
 *
 * 断定表現が1件も抽出されなかった場合（totalClaims === 0）はブロックしない
 * （判定材料が無い＝Agent5が本文から断定表現を見つけられなかったケースで、
 * 誤ってブロックするより既存の他の安全策に委ねる方が安全という判断）。
 */
export function evaluateSourceVerificationClaims(claims: SourceVerificationClaim[]): SourceVerificationEvaluation {
  const totalClaims = claims.length;
  const unsourced = claims.filter((claim) => !claim.hasSource);
  const unsourcedCount = unsourced.length;
  const unsourcedRatio = totalClaims > 0 ? unsourcedCount / totalClaims : 0;
  const shouldBlock =
    totalClaims > 0 && (unsourcedCount >= UNSOURCED_CLAIMS_MIN_COUNT || unsourcedRatio >= UNSOURCED_CLAIMS_MAX_RATIO);

  return {
    totalClaims,
    unsourcedStatements: unsourced.map((claim) => claim.statement),
    unsourcedCount,
    unsourcedRatio,
    shouldBlock,
  };
}

/** buildSourceVerificationPrompt に渡す、Agent1の調査データ側の入力（buildWriterPromptが
 *  Agent2に渡すのと同じ項目に限定する。Agent2が実際に見た情報と同じものを基準にすることで、
 *  「Agent2が知り得なかった情報を勝手に補っていないか」を公平に判定できる）。 */
export interface SourceVerificationResearchInput {
  title: string;
  genre: string;
  address: string;
  openHours: string;
  regularHoliday: string;
  budget: string;
  vibes: string[];
  isNew: boolean;
  facts: string;
}

/**
 * Agent 5向けのプロンプトを組み立てる。
 *
 * 重要な設計方針（ユーザーとの合意事項）:
 * - Agent 5に検索させない（toolsを渡さない。呼び出し側は callPlainJsonAgent を使うこと）。
 * - 「正しいか」ではなく「調査データに対応する記載があるか」だけを判定させる。
 *   もっともらしさや一般常識での判断を明示的に禁止する
 *   （「バーならジャズがあってもおかしくない」のような推測は、まさに今回の
 *   ハルシネーションを見逃した失敗パターンそのものであるため）。
 * - 抽出対象（何を「断定的記述」とみなすか）は「外部の情報源で真偽を検証
 *   できるか」を基準にする（ユーザーとの合意事項）。実データで検証した
 *   ところ、この基準を明記する前は「サクッとした食感」「香ばしい香りが
 *   漂う」のような味・香り・音の感覚描写までLLMが断定的記述として拾って
 *   しまい、正常な記事（例: 天婦羅割烹みや嶋）が誤ってブロックされる
 *   事例があった。感覚描写・情景の比喩・主観的な評価は検証不可能なので
 *   除外し、数量・価格・日付、定期的な催し・サービスの有無、受賞歴・
 *   掲載歴・沿革のように検証可能な具体的事実は必ず対象に残す。
 */
export function buildSourceVerificationPrompt(research: SourceVerificationResearchInput, body: string): string {
  return `あなたは、紹介記事の「出典照合」だけを行う検証エージェントです。
Google検索や外部知識は一切使わず、以下に提示する「調査データ」と「記事本文」の
2つだけを情報源として、本文中の断定的な記述それぞれが調査データのどこかに
対応しているかを機械的に判定してください。

重要な制約（必ず守ること）:
- あなたの知識や常識、一般的にありそうかどうかで判断しないでください。
  「バーならジャズの生演奏があってもおかしくない」のような推測は禁止です。
- 検索は一切行わず、以下に提示されたテキストの中だけで対応関係を判定してください。
- 判定基準は「調査データのどこかに、その記述を具体的に裏付ける記載があるか」のみです。
  記載が無ければ、記述がどれほどもっともらしく見えても hasSource: false としてください。
- 調査データに記載がある内容でも、本文の記述がそれより具体的すぎる場合
  （例: 調査データに金額の記載が無いのに、本文には具体的な金額が書かれている）は
  hasSource: false としてください。

--- 調査データ（Agent 1が収集） ---
店名: ${research.title}
ジャンル: ${research.genre}
住所: ${research.address}
営業時間: ${research.openHours}
定休日: ${research.regularHoliday}
予算目安: ${research.budget}
特徴タグ: ${research.vibes.join(', ')}
新店舗か: ${research.isNew ? 'はい（開店・リニューアルから概ね1年以内）' : 'いいえ、または不明'}
事実メモ:
${research.facts}
--- ここまで ---

--- 記事本文（Agent 2が執筆） ---
${body}
--- ここまで ---

作業手順:
1. 記事本文から、事実として断定している記述を抽出してください。
   抽出するかどうかの判定基準は、ただ1つ:
   **「その記述は、外部の情報源（お店の公式情報、来店者のレビュー、
   Googleマップなど）で真偽を検証できるか」**です。検証できるものだけを
   抽出してください。

   抽出する（検証可能＝事実主張）:
   - 具体的な数量・価格・日付
     例:「75ml×3杯」「3月14日開店」「2,000円」「カウンター席が9席」
   - 定期的な催し・サービスの有無
     例:「毎週金曜にジャズ演奏」「予約可能」「個室あり」「昼営業あり」
   - 受賞歴・掲載歴・沿革
     例:「ミシュラン掲載」「創業50年」「2016年開業」「前身の店を継承」

   抽出しない（検証不可能＝書き手の表現）:
   - 味・香り・音・食感・温度などの感覚描写
     例:「サクッとした食感」「香ばしい香りが漂う」「甘みが広がる」
   - 情景・雰囲気の比喩
     例:「昭和の空気を残す」「思わず笑みがこぼれる」
   - 主観的な評価・感想
     例:「長く愛されている」「特別な時間を過ごせる」

   迷ったときは必ず「外部の情報源で真偽を検証できるか」に立ち返って
   判断してください。「サクッとしている」は検証できないので除外、
   「毎週金曜にジャズ演奏」は（実際に金曜に店へ行けば分かるという意味で）
   検証できるので対象、という線引きです。
2. 抽出した記述それぞれについて、「調査データ」のどこかに対応する記載が
   あるかを判定してください。
   - 対応する記載がある場合: hasSource: true とし、sourceField に対応する
     項目名（例: "openHours", "facts", "vibes" など）を書いてください。
   - 対応する記載が無い場合: hasSource: false としてください。

出力は厳密なJSON形式で、claims配列にすべての判定を含めてください。`;
}
