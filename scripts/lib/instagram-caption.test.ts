import { describe, expect, it } from 'vitest';
import { buildHashtags, formatCaptionLineBreaks, sanitizeHashtagWord, splitIntoSentences } from './instagram-caption';

describe('sanitizeHashtagWord', () => {
  it('#や空白を除去する', () => {
    expect(sanitizeHashtagWord('#焼肉')).toBe('焼肉');
    expect(sanitizeHashtagWord(' 焼き鳥 ')).toBe('焼き鳥');
  });

  it('12文字を超える場合は切り詰める', () => {
    const long = 'あ'.repeat(20);
    expect(sanitizeHashtagWord(long)).toBe('あ'.repeat(12));
  });

  it('除去後に空ならnullを返す', () => {
    expect(sanitizeHashtagWord('   ')).toBeNull();
    expect(sanitizeHashtagWord('#')).toBeNull();
  });
});

describe('buildHashtags', () => {
  it('固定4個+記事内容に応じた1個で最大5個になる', () => {
    const hashtags = buildHashtags('割烹');
    expect(hashtags).toEqual(['#本寺小路', '#三条市', '#新潟グルメ', '#燕三条', '#割烹']);
  });

  it('サニタイズ後に空になる単語なら固定4個のみを返す', () => {
    const hashtags = buildHashtags('   ');
    expect(hashtags).toEqual(['#本寺小路', '#三条市', '#新潟グルメ', '#燕三条']);
  });
});

describe('splitIntoSentences', () => {
  it('。！？の直後で区切る', () => {
    expect(splitIntoSentences('今夜も静かです。灯りが揺れています！本当ですか？')).toEqual([
      '今夜も静かです。',
      '灯りが揺れています！',
      '本当ですか？',
    ]);
  });

  it('末尾に句読点が無い文もそのまま1文として拾う', () => {
    expect(splitIntoSentences('句点の無い文')).toEqual(['句点の無い文']);
  });
});

describe('formatCaptionLineBreaks', () => {
  it('文の途中では改行しない（1文がLINE_WIDTH_TARGETを超えてもその文単体の行になる）', () => {
    const longSentence = 'あ'.repeat(40) + '。';
    const result = formatCaptionLineBreaks(longSentence);
    expect(result).toBe(longSentence);
  });

  it('複数の短い文は目安の字数を超えたところで改行する', () => {
    const result = formatCaptionLineBreaks('短い文です。もう一文です。三つ目の文です。');
    // 目安28字を超えたら次の文から改行するため、1行に収まる範囲まで詰める。
    expect(result.split('\n').every((line) => line.length > 0)).toBe(true);
    expect(result).not.toContain('\n\n');
    expect(result.replace(/\n/g, '')).toBe('短い文です。もう一文です。三つ目の文です。');
  });

  it('空行区切りの段落構造はそのまま保つ', () => {
    const result = formatCaptionLineBreaks('一段落目の文です。\n\n二段落目の文です。');
    const paragraphs = result.split('\n\n');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toContain('一段落目');
    expect(paragraphs[1]).toContain('二段落目');
  });

  it('段落内の既存の改行はいったん潰され、文単位で組み直される', () => {
    const result = formatCaptionLineBreaks('一文目です。\n二文目です。');
    expect(result).not.toContain('\n\n');
    expect(result.replace(/\n/g, '')).toBe('一文目です。二文目です。');
  });
});
