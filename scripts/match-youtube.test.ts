import { describe, expect, it } from 'vitest';
import { isShortDuration, parseIsoDurationSeconds } from './match-youtube';

describe('parseIsoDurationSeconds', () => {
  it('時分秒を秒に変換する', () => {
    expect(parseIsoDurationSeconds('PT54S')).toBe(54);
    expect(parseIsoDurationSeconds('PT1M1S')).toBe(61);
    expect(parseIsoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(parseIsoDurationSeconds('PT8M')).toBe(480);
  });
  it('解析できないもの（ライブ予定のP0D等）は0', () => {
    expect(parseIsoDurationSeconds('P0D')).toBe(0);
    expect(parseIsoDurationSeconds('')).toBe(0);
  });
});

describe('isShortDuration', () => {
  it('180秒以下はショート', () => {
    expect(isShortDuration('PT10S')).toBe(true);
    expect(isShortDuration('PT1M')).toBe(true);
    expect(isShortDuration('PT3M')).toBe(true);
  });
  it('180秒超は通常動画', () => {
    expect(isShortDuration('PT3M1S')).toBe(false);
    expect(isShortDuration('PT12M32S')).toBe(false);
  });
  it('長さ不明・ライブ予定は通常動画扱い（除外しない）', () => {
    expect(isShortDuration(undefined)).toBe(false);
    expect(isShortDuration('P0D')).toBe(false);
  });
});
