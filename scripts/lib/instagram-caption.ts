/**
 * scripts/lib/instagram-caption.ts
 *
 * Agent: Instagram Caption — 記事のtitle/summary/bodyだけを事実源として、
 * Instagram投稿用のキャプション文面をLLM（Gemini、Grounding無し）で
 * 書き下ろす。既存のAgent2(Writer)と同じ「渡した材料以外は創作しない」
 * 方針。
 *
 * ハッシュタグはLLMに5個フルで作らせない。固定4個はコードで確定し、
 * LLMには記事内容に応じた残り1個の単語だけを生成させる（表記ゆれ・
 * 欠落・改変のリスクを避けるため）。
 *
 * 150〜250字という字数制約はLLMに正確に守らせるのが難しいため、
 * 大きく外れた場合のみ1回だけ補正指示を添えて再試行し、それでも外れて
 * いれば字数はそのまま採用してlengthNoteに注記する（生成失敗にはしない）。
 *
 * 例外は一切投げない。失敗時は null を返し、呼び出し元は「素材なし」として
 * 記事の公開自体は継続する。
 */

import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';
import { callPlainJsonAgent, parseJsonOrThrow } from './gemini-agents.js';

export type InstagramContentType = 'spot' | 'news' | 'column';

export interface InstagramCaptionInput {
  type: InstagramContentType;
  title: string;
  /** 記事の要約（description/summary）。事実の材料。 */
  summary: string;
  /** 記事本文（Markdown）。事実の材料。冒頭の書き出しのネタに使う。 */
  body: string;
}

export interface InstagramCaptionResult {
  /** ハッシュタグ・CTAを含む、LLMが書いたキャプション本文（末尾に導線の一文を含む）。 */
  caption: string;
  /** 固定4個+記事内容に応じた1個、最大5個。 */
  hashtags: string[];
  /** caption + 空行 + hashtags。そのままSlackへ貼り付けられる完成形。 */
  fullText: string;
  /** 字数が150〜250字の目安から外れている場合のみ設定する注記。 */
  lengthNote?: string;
}

const FIXED_HASHTAGS = ['#本寺小路', '#三条市', '#新潟グルメ', '#燕三条'];
const TARGET_MIN = 150;
const TARGET_MAX = 250;
// この範囲を外れたときだけ1回再試行する（目安からの軽い逸脱では再試行しない。
// APIコールを倍にする価値があるほど壊れている場合だけ）。
const RETRY_MIN = 80;
const RETRY_MAX = 320;

const CONTENT_TYPE_LABEL: Record<InstagramContentType, string> = {
  spot: '店舗紹介記事',
  news: 'お知らせ記事',
  column: 'コラム記事',
};

const captionSchema = z.object({
  caption: z.string().min(1),
  hashtagWord: z.string().min(1),
});

const captionResponseSchema = {
  type: Type.OBJECT,
  properties: {
    caption: {
      type: Type.STRING,
      description: 'Instagram投稿用のキャプション本文（ハッシュタグは含めない）',
    },
    hashtagWord: {
      type: Type.STRING,
      description: '記事内容に最もふさわしいハッシュタグ候補を1つ、#を付けずに単語または短いフレーズで',
    },
  },
  required: ['caption', 'hashtagWord'],
};

function buildPrompt(input: InstagramCaptionInput, correctiveNote?: string): string {
  const typeLabel = CONTENT_TYPE_LABEL[input.type];
  return `あなたは「本寺小路ガイド」のInstagram運用担当です。以下は${typeLabel}の内容です。
この内容だけを事実源として、Instagram投稿用のキャプション文面を書いてください。
書かれていない情報を創作・推測で補わないでください。

--- 記事内容 ---
タイトル: ${input.title}
要約: ${input.summary}
本文:
${input.body}
--- ここまで ---

執筆ルール:
- caption全体で150〜250字程度（本文相当。ハッシュタグ・URLは別途こちらで付与するため書かないこと）
- 冒頭の1文が最も重要です。Instagramは3行目以降が「続きを読む」で折りたたまれ隠れるため、
  スクロールする指を止める一文を冒頭に置いてください
- 記事の要約をなぞるのではなく、読みたくなる書き出しにしてください
  （情景描写・問いかけ・意外な事実の提示など）
- 「〜しました」という運営者目線の報告調は避けてください。読み手に語りかける・
  情景を描く文体にしてください
- サイトのトーン（明朝体で組む静かな夜の路地の空気、落ち着いた語り口）に合わせてください
- captionの文末は「プロフィールのリンクから」という一文で、記事へのリンク導線を
  作ってください（URLそのものは書かなくてよい）
- hashtagWord: この記事の内容に最もふさわしいハッシュタグを1つだけ、#を付けずに
  単語または短いフレーズで${correctiveNote ? `\n\n${correctiveNote}` : ''}`;
}

/** #や空白を除去し、長すぎる場合は切り詰める。除去後に空ならnull。テスト用にexportする。 */
export function sanitizeHashtagWord(word: string): string | null {
  const cleaned = word.replace(/[#\s　]/g, '');
  if (!cleaned) return null;
  const chars = [...cleaned];
  return chars.length > 12 ? chars.slice(0, 12).join('') : cleaned;
}

/** テスト用にexportする。 */
export function buildHashtags(rawWord: string): string[] {
  const word = sanitizeHashtagWord(rawWord);
  return word ? [...FIXED_HASHTAGS, `#${word}`] : [...FIXED_HASHTAGS];
}

async function requestCaption(
  ai: GoogleGenAI,
  input: InstagramCaptionInput,
  correctiveNote?: string
): Promise<{ caption: string; hashtagWord: string } | null> {
  const label = '[Agent:InstagramCaption]';
  const raw = await callPlainJsonAgent(ai, {
    label,
    prompt: buildPrompt(input, correctiveNote),
    responseSchema: captionResponseSchema,
  });
  const parsedJson = parseJsonOrThrow(raw, label);
  const result = captionSchema.safeParse(parsedJson);
  if (!result.success) {
    console.error(`${label} レスポンスがスキーマ違反です:`, result.error.issues);
    return null;
  }
  return result.data;
}

export async function runInstagramCaptionAgent(
  ai: GoogleGenAI,
  input: InstagramCaptionInput
): Promise<InstagramCaptionResult | null> {
  const label = '[Agent:InstagramCaption]';
  try {
    const first = await requestCaption(ai, input);
    if (!first) return null;

    let final = first;
    const firstLen = [...first.caption].length;
    if (firstLen < RETRY_MIN || firstLen > RETRY_MAX) {
      console.warn(`${label} 1回目が${firstLen}字と大きく外れたため、1回だけ再試行します。`);
      const retried = await requestCaption(
        ai,
        input,
        `【補正指示】前回の生成は${firstLen}字でした。今度は必ずcaptionを150〜250字程度に収めてください。`
      );
      if (retried) final = retried;
    }

    const finalLen = [...final.caption].length;
    const lengthNote =
      finalLen < TARGET_MIN || finalLen > TARGET_MAX
        ? `字数の目安（150〜250字）から外れています（実際: ${finalLen}字）。投稿前に調整してください。`
        : undefined;

    const hashtags = buildHashtags(final.hashtagWord);
    const caption = final.caption.trim();

    return {
      caption,
      hashtags,
      fullText: `${caption}\n\n${hashtags.join(' ')}`,
      lengthNote,
    };
  } catch (err) {
    console.error(`${label} 生成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
