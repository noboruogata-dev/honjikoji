import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GoogleGenAI } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMotifIdeationPrompt,
  chooseCompositionPattern,
  COMPOSITION_PATTERNS,
  hashString,
  loadExistingColumnImageSubjects,
  proposeColumnMotif,
} from './column-art-direction';
import { buildColumnImageAlt, buildColumnImagePrompt, buildColumnMidImageAlt, buildColumnMidImagePrompt, findMidImageInsertion, type ColumnImageInput } from './column-images';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const input: ColumnImageInput = {
  slug: 'sanjo-ramen',
  title: '三条カレーラーメンと夜の締め',
  summary: '本寺小路の夜を締めくくる一杯の物語。',
  category: '店と人',
  kind: 'fiction',
};

function fakeAi(text: string | Error): GoogleGenAI {
  return {
    models: {
      generateContent: vi.fn(async () => {
        if (text instanceof Error) throw text;
        return { text };
      }),
    },
  } as unknown as GoogleGenAI;
}

describe('構図パターン', () => {
  it('同じseedなら必ず同じパターン（決定論的）', () => {
    expect(chooseCompositionPattern('abc').key).toBe(chooseCompositionPattern('abc').key);
    expect(hashString('abc')).toBe(hashString('abc'));
  });

  it('avoidKeysに含まれるパターンは選ばない', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const first = chooseCompositionPattern(seed);
      expect(chooseCompositionPattern(`${seed}:mid`, [first.key]).key).not.toBe(first.key);
    }
  });

  it('いろいろなseedで複数の構図に散らばる（1パターンに偏らない）', () => {
    const keys = new Set(Array.from({ length: 40 }, (_, i) => chooseCompositionPattern(`column-${i}`).key));
    expect(keys.size).toBeGreaterThanOrEqual(5);
  });

  it('全パターンが、プロンプト用の英語指示とキーを持つ', () => {
    expect(new Set(COMPOSITION_PATTERNS.map((p) => p.key)).size).toBe(COMPOSITION_PATTERNS.length);
    for (const pattern of COMPOSITION_PATTERNS) expect(pattern.instruction.length).toBeGreaterThan(20);
  });
});

describe('プロンプトへの反映', () => {
  it('モチーフと構図を指定すると、プロンプトにそのまま入り、画風ロックも残る', () => {
    const composition = COMPOSITION_PATTERNS.find((p) => p.key === 'glow-silhouette')!;
    const prompt = buildColumnImagePrompt(input, { motif: { prompt: 'a steaming bowl of curry ramen', alt: '湯気の立つカレーラーメンの丼' }, composition });
    expect(prompt).toContain('Subject: a steaming bowl of curry ramen');
    expect(prompt).toContain(composition.instruction);
    expect(prompt).toContain('#14110f');
    expect(prompt).toContain('no text');
    // 以前の「中央に1つ・広い余白」固定は、構図パターン側に移した。
    expect(prompt).not.toContain('exactly one central subject');
  });

  it('altは、指定したモチーフの日本語表現を使う', () => {
    expect(buildColumnImageAlt(input, { prompt: 'x', alt: '湯気の立つカレーラーメンの丼' })).toBe(
      '三条カレーラーメンと夜の締めを象徴する湯気の立つカレーラーメンの丼の和モダンな挿絵'
    );
  });

  it('2枚目は、既定では1枚目と別の構図になる', () => {
    const body = ['## A', 'あ'.repeat(300), '## B', 'い'.repeat(300), '## C', 'う'.repeat(300)].join('\n\n');
    const insertion = findMidImageInsertion(body)!;
    const first = chooseCompositionPattern(input.slug);
    const midPrompt = buildColumnMidImagePrompt(input, insertion);
    expect(midPrompt).not.toContain(first.instruction);
    expect(buildColumnMidImageAlt(input, insertion, { prompt: 'x', alt: '路地の行灯' })).toContain('路地の行灯');
  });
});

describe('proposeColumnMotif', () => {
  const params = {
    context: input.title,
    composition: COMPOSITION_PATTERNS[0],
    existingSubjects: ['既存の挿絵A'],
    fallback: { prompt: 'fallback motif', alt: '既定のモチーフ' },
  };

  it('Geminiが返したモチーフを使う', async () => {
    const motif = await proposeColumnMotif(
      fakeAi(JSON.stringify({ motifEn: 'a bowl of curry ramen with rising steam', motifJa: '湯気の立つカレーラーメンの丼' })),
      params
    );
    expect(motif).toEqual({ prompt: 'a bowl of curry ramen with rising steam', alt: '湯気の立つカレーラーメンの丼' });
  });

  it('APIエラー・不正なJSON・スキーマ違反ではフォールバックを返す（例外にしない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await proposeColumnMotif(fakeAi(new Error('boom')), params)).toBe(params.fallback);
    expect(await proposeColumnMotif(fakeAi('not json'), params)).toBe(params.fallback);
    expect(await proposeColumnMotif(fakeAi(JSON.stringify({ motifEn: 'x', motifJa: '' })), params)).toBe(params.fallback);
    warn.mockRestore();
    error.mockRestore();
  });

  it('発想プロンプトに、構図・既存の挿絵・汎用モチーフを避ける指示を含める', () => {
    const prompt = buildMotifIdeationPrompt(params);
    expect(prompt).toContain(params.composition.instruction);
    expect(prompt).toContain('- 既存の挿絵A');
    expect(prompt).toContain('汎用的な被写体');
  });
});

describe('loadExistingColumnImageSubjects', () => {
  it('既存コラムのeyecatch/illustrationのaltを集める', async () => {
    const subjects = await loadExistingColumnImageSubjects(PROJECT_ROOT);
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('存在しないディレクトリでは空配列', async () => {
    expect(await loadExistingColumnImageSubjects('/nonexistent-dir-for-test')).toEqual([]);
  });
});
