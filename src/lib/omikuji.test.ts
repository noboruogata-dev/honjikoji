import { describe, expect, it } from 'vitest';
import { drawRank, drawText, OMIKUJI_RANKS, OMIKUJI_TEXTS, splitIntoSentences } from './omikuji';

describe('splitIntoSentences', () => {
  it('句点（。）ごとに文を分割し、各文に句点を残す', () => {
    expect(splitIntoSentences('今夜は静かに飲め。灯りは明日も消えない。')).toEqual([
      '今夜は静かに飲め。',
      '灯りは明日も消えない。',
    ]);
  });

  it('句点を含まないテキストは1件だけの配列で返す（回帰テスト: 分割で失われない）', () => {
    expect(splitIntoSentences('灯りが揺れている')).toEqual(['灯りが揺れている']);
  });

  it('末尾の句点で分割して生じる空文字列は含めない', () => {
    const result = splitIntoSentences('一杯だけ飲め。');
    expect(result).toEqual(['一杯だけ飲め。']);
    expect(result).not.toContain('');
  });

  it('3文以上でも正しく分割する', () => {
    expect(splitIntoSentences('一軒目へ行け。二軒目も行け。三軒目はやめておけ。')).toEqual([
      '一軒目へ行け。',
      '二軒目も行け。',
      '三軒目はやめておけ。',
    ]);
  });
});

describe('OMIKUJI_RANKS', () => {
  it('出現率(weight)の合計は100になる（ファイル冒頭のコメントに明記された前提）', () => {
    const total = OMIKUJI_RANKS.reduce((sum, rank) => sum + rank.weight, 0);
    expect(total).toBeCloseTo(100);
  });

  it('すべてのランクにOMIKUJI_TEXTSのエントリが存在し、1件以上ある', () => {
    for (const rank of OMIKUJI_RANKS) {
      expect(OMIKUJI_TEXTS[rank.key]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('OMIKUJI_TEXTS', () => {
  it('すべての文言が句点（。）で終わる（splitIntoSentencesでの表示を前提とするため）', () => {
    for (const texts of Object.values(OMIKUJI_TEXTS)) {
      for (const text of texts) {
        expect(text.endsWith('。')).toBe(true);
      }
    }
  });

  it('同一ランク内に重複した文言が無い', () => {
    for (const [key, texts] of Object.entries(OMIKUJI_TEXTS)) {
      const unique = new Set(texts);
      expect(unique.size, `${key}に重複がある`).toBe(texts.length);
    }
  });
});

describe('drawRank', () => {
  // weight順: manto(3), oochouchin(12), akari(25), tentou(25), koakari(20),
  // hakumei(10), kie(4.5), nushi(0.5)。累積: 3, 15, 40, 65, 85, 95, 99.5, 100。
  it('rand()が返す値に応じて累積分布でランクを選ぶ', () => {
    expect(drawRank(() => 0).key).toBe('manto');
    expect(drawRank(() => 0.02).key).toBe('manto'); // roll=2 < 3
    expect(drawRank(() => 0.03).key).toBe('oochouchin'); // roll=3、3の境界は次のランクに含まれる
    expect(drawRank(() => 0.14).key).toBe('oochouchin'); // roll=14 < 15
    expect(drawRank(() => 0.96).key).toBe('kie'); // roll=96、95〜99.5の範囲
  });

  it('roll=0.999（累積99.5〜100の範囲）ならnushiになる', () => {
    expect(drawRank(() => 0.999).key).toBe('nushi');
  });
});

describe('drawText', () => {
  it('指定したランクキーの文言一覧からrand()に応じて1件選ぶ', () => {
    const texts = OMIKUJI_TEXTS.manto;
    expect(drawText('manto', () => 0)).toBe(texts[0]);
    expect(drawText('manto', () => 0.999)).toBe(texts[texts.length - 1]);
  });

  it('存在しないランクキーには空文字列を返す', () => {
    expect(drawText('not-a-real-rank')).toBe('');
  });
});
