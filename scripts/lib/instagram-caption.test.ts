import { describe, expect, it } from 'vitest';
import { buildHashtags, sanitizeHashtagWord } from './instagram-caption';

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
