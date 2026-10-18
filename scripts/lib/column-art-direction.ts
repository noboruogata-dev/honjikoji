/**
 * scripts/lib/column-art-direction.ts
 *
 * コラム挿絵の「何を・どう描くか」の多様化を担う。
 *
 * 以前は、モチーフをカテゴリごとの固定キーワード表（徳利と猪口など4種が
 * ほぼ既定値）から選び、構図も「中央に被写体1つ＋広い余白」で固定していた
 * ため、どの記事も似たイラストになっていた。ここでは次の2点で変化をつける。
 *
 * 1. 構図パターン（COMPOSITION_PATTERNS）: 記事のslugから決定論的に選ぶ。
 *    1枚目と2枚目は必ず別のパターンにする。
 * 2. モチーフの発想（proposeColumnMotif）: Geminiの文章生成に、その記事
 *    固有の具体的なモチーフを考えさせる。既存コラムの挿絵と被らないよう、
 *    既存のalt（挿絵の説明）を渡す。失敗時は従来のキーワード表に戻す。
 *
 * 配色・線画のタッチ・背景色（サイト全体の統一感）は column-images.ts の
 * 画風ロックのまま変えない。ここで変えるのは被写体と構図だけ。
 */

import { Type, type GoogleGenAI } from '@google/genai';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { callPlainJsonAgent, parseJsonOrThrow } from './gemini-agents.js';

export interface CompositionPattern {
  key: string;
  /** ログ・デバッグ用の日本語名。 */
  label: string;
  /** 画像生成プロンプトへそのまま入れる英語の指示。 */
  instruction: string;
}

// どのパターンも、キャンバスの四隅と縁の余白は背景色のままにする
// （column-images.ts の背景色QAが四隅の色を検査するため。画風ロック側で
// 別途指示するが、構図の指示が余白を食い潰さないよう各文面でも意識する）。
export const COMPOSITION_PATTERNS: readonly CompositionPattern[] = [
  {
    key: 'still-life',
    label: '静物',
    instruction: 'one compact still-life group of the subject, placed near the center with generous empty space around it',
  },
  {
    key: 'alley-scene',
    label: '路地の情景',
    instruction:
      'a small slice of a narrow night alley as the scene, with noren curtains, lattice doors, hanging lanterns and stone paving; the subject sits inside this scene and the surroundings help tell the story; no people; draw it as a free-standing vignette whose outer edge fades into the solid background on every side, never as a full-bleed picture',
  },
  {
    key: 'hands-closeup',
    label: '手元のアップ',
    instruction:
      'a tight, cinematic close-up of hands (no faces, nobody identifiable) handling or presenting the subject; the crop is intimate but the drawing stays well inside the canvas edges',
  },
  {
    key: 'flat-lay',
    label: '真上からの配置',
    instruction:
      'a top-down flat-lay seen from directly above: the subject and two or three related small items arranged on a wooden tray or counter edge with deliberate spacing',
  },
  {
    key: 'contrast-pair',
    label: '対比する2つ',
    instruction:
      'two contrasting objects side by side that express a contrast found in the article (old and new, hot and cold, craft and everyday), drawn at equal weight',
  },
  {
    key: 'glow-silhouette',
    label: '灯りを背にしたシルエット',
    instruction:
      'the subject as a bold dark-ink silhouette in front of one large warm lantern-amber circle, like a paper lantern or a moon; the circle is the only large shape',
  },
  {
    key: 'diagonal-flow',
    label: '斜めに流れる構図',
    instruction:
      'an asymmetric composition: the subject sits in the lower left, and one flowing element (a curl of steam, a river line, a rope, a ribbon of noren cloth) sweeps diagonally across the canvas toward the upper right',
  },
  {
    key: 'triptych',
    label: '3つ並べ',
    instruction:
      'three small related objects in a horizontal row, like items hung from a rope or lined up on a shelf, each a different shape and fully visible, evenly spaced, drawn at the same scale',
  },
];

/** 文字列から決定論的な非負整数を作る（slugごとに同じ値を返すだけで、暗号用途ではない）。 */
export function hashString(value: string): number {
  let hash = 0;
  for (const ch of value) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

/**
 * slugから構図パターンを決定論的に選ぶ。avoidKeysに含まれるパターンは除く
 * （2枚目で1枚目と同じ構図にしないため）。全て除外された場合は除外しない。
 */
export function chooseCompositionPattern(seed: string, avoidKeys: readonly string[] = []): CompositionPattern {
  const candidates = COMPOSITION_PATTERNS.filter((pattern) => !avoidKeys.includes(pattern.key));
  const pool = candidates.length > 0 ? candidates : COMPOSITION_PATTERNS;
  return pool[hashString(seed) % pool.length];
}

/** 画像生成プロンプトに渡すモチーフ（prompt）と、alt文に入れる日本語表現（alt）。 */
export interface ColumnMotif {
  prompt: string;
  alt: string;
}

const motifResponseSchema = z.object({
  motifEn: z.string().min(3).max(300),
  motifJa: z.string().min(2).max(60),
});

const MOTIF_JSON_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    motifEn: {
      type: Type.STRING,
      description: 'English description of the single concrete subject to draw, one or two sentences, no style words.',
    },
    motifJa: {
      type: Type.STRING,
      description: '画像のaltに使う、被写体を表す日本語の名詞句（例: 湯気の立つカレーラーメンの丼）。「の和モダンな挿絵」などは付けない。',
    },
  },
  required: ['motifEn', 'motifJa'],
};

export function buildMotifIdeationPrompt(params: {
  context: string;
  composition: CompositionPattern;
  existingSubjects: readonly string[];
}): string {
  const existing = params.existingSubjects.length
    ? params.existingSubjects.map((subject) => `- ${subject}`).join('\n')
    : '(none yet)';
  return `あなたは日本の夜の街を紹介するWebメディアのアートディレクターです。次の内容に添える挿絵の「被写体」を1つだけ考えてください。

【挿絵が添えられる内容】
${params.context}

【構図の指定】
${params.composition.label}: ${params.composition.instruction}
この構図に自然に収まる被写体にしてください。

【既に使われている挿絵（これらと被写体・見た目が似るものは避ける）】
${existing}

条件:
- 内容に固有の、具体的で描ける物・場面を選ぶ。徳利と猪口・盃・暖簾・提灯のような、どのお酒の記事にも使える汎用的な被写体は、内容が本当にそれを必要とする場合を除いて選ばない。
- 平面的なインク線画で描ける物にする（写真的な質感、細かな文字、ロゴ、看板の文字に頼らない）。
- 実在の人物・実在の店舗は描かない。人物を出す場合は顔のない手元などに限る。
- motifEnは英語、motifJaは日本語で、同じ被写体を表すこと。`;
}

/**
 * 記事（または本文の挿入位置前後）の内容から、挿絵の被写体をGeminiに考えさせる。
 * 失敗（API・JSON・スキーマ不一致）しても例外にせず、fallbackを返す
 * （画像生成そのものを止めないため）。
 */
export async function proposeColumnMotif(
  ai: GoogleGenAI,
  params: {
    context: string;
    composition: CompositionPattern;
    existingSubjects: readonly string[];
    fallback: ColumnMotif;
  }
): Promise<ColumnMotif> {
  try {
    const raw = await callPlainJsonAgent(ai, {
      label: '[Agent4:Motif]',
      prompt: buildMotifIdeationPrompt(params),
      responseSchema: MOTIF_JSON_SCHEMA,
    });
    const parsed = motifResponseSchema.safeParse(parseJsonOrThrow(raw, '[Agent4:Motif]'));
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' / '));
    }
    console.log(`[Agent4:Motif] モチーフ: ${parsed.data.motifJa}（構図: ${params.composition.label}）`);
    return { prompt: parsed.data.motifEn, alt: parsed.data.motifJa };
  } catch (error) {
    console.warn(
      `[Agent4:Motif] モチーフの発想に失敗したため、固定のモチーフにフォールバックします: ${error instanceof Error ? error.message : error}`
    );
    return params.fallback;
  }
}

/**
 * 既存コラム（src/content/columns）の挿絵のalt（＝何を描いたかの説明）を集める。
 * 新しい挿絵のモチーフを考えさせるとき、これらと被らないよう渡す。
 * excludeSlugには生成中の記事自身を指定する（まだ存在しない想定だが念のため）。
 */
export async function loadExistingColumnImageSubjects(projectRoot: string, excludeSlug?: string): Promise<string[]> {
  const dir = path.join(projectRoot, 'src/content/columns');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }

  const subjects: string[] = [];
  for (const file of files) {
    if (excludeSlug && file === `${excludeSlug}.md`) continue;
    const raw = await readFile(path.join(dir, file), 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    let frontmatter: unknown;
    try {
      frontmatter = parseYaml(match[1]);
    } catch {
      continue;
    }
    if (!frontmatter || typeof frontmatter !== 'object') continue;
    for (const key of ['eyecatch', 'illustration'] as const) {
      const alt = (frontmatter as Record<string, { alt?: unknown } | undefined>)[key]?.alt;
      if (typeof alt === 'string' && alt) subjects.push(alt);
    }
  }
  return [...new Set(subjects)];
}
