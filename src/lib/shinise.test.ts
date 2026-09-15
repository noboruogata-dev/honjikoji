import { describe, expect, it } from 'vitest';
import { isShinise } from './shinise';

describe('isShinise', () => {
  it('establishedYearが未設定ならfalse', () => {
    expect(isShinise(undefined, new Date('2026-09-15'))).toBe(false);
  });

  it('開業から50年以上ならtrue', () => {
    expect(isShinise(1976, new Date('2026-09-15'))).toBe(true);
  });

  it('開業から50年未満ならfalse', () => {
    expect(isShinise(1987, new Date('2026-09-15'))).toBe(false);
  });

  it('境界値: ちょうど50年ならtrue', () => {
    expect(isShinise(1976, new Date('2026-01-01'))).toBe(true);
  });

  it('境界値: 49年ならfalse', () => {
    expect(isShinise(1977, new Date('2026-01-01'))).toBe(false);
  });
});
