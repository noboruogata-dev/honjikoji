import { describe, expect, it } from 'vitest';
import { isRecentlyPublished } from './spotFreshness';

describe('isRecentlyPublished', () => {
  it('pubDateが今日ならtrue', () => {
    const now = new Date('2026-09-15');
    expect(isRecentlyPublished(now, now)).toBe(true);
  });

  it('pubDateから30日以内ならtrue', () => {
    expect(isRecentlyPublished(new Date('2026-08-20'), new Date('2026-09-15'))).toBe(true);
  });

  it('pubDateから30日を超えていればfalse（回帰テスト: Wine Bar MARGAUXが開店1年半後もNEW扱いのままだった件。isNewではなく掲載日基準に変更）', () => {
    expect(isRecentlyPublished(new Date('2026-01-01'), new Date('2026-09-15'))).toBe(false);
  });

  it('境界値: ちょうど30日ならまだtrue', () => {
    expect(isRecentlyPublished(new Date('2026-08-16'), new Date('2026-09-15'))).toBe(true);
  });

  it('老舗の紹介記事でも掲載日が直近ならtrue（回帰テスト: 1987年創業のSato\'s BarはisNew:falseだが、公開日が今日ならNEW表示すべき）', () => {
    const pubDate = new Date('2026-09-15');
    const now = new Date('2026-09-15');
    expect(isRecentlyPublished(pubDate, now)).toBe(true);
  });
});
