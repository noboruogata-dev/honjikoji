import { describe, expect, it } from 'vitest';
import { validateResearchedSocialLinks } from './socialLinks';

describe('validateResearchedSocialLinks', () => {
  it('公式プロフィール形式とLINE友だち追加URLを採用する', () => {
    const result = validateResearchedSocialLinks([
      {
        platform: 'instagram',
        url: 'https://www.instagram.com/example_store/',
        evidenceUrl: 'https://example.com/',
      },
      {
        platform: 'line',
        url: 'https://line.me/R/ti/p/%40123abc',
        evidenceUrl: 'https://example.com/access',
      },
    ]);

    expect(result.accepted).toEqual([
      { platform: 'instagram', url: 'https://www.instagram.com/example_store/' },
      { platform: 'line', url: 'https://line.me/R/ti/p/%40123abc' },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('投稿URL・検索URL・HTTP URLを採用しない', () => {
    const result = validateResearchedSocialLinks([
      {
        platform: 'instagram',
        url: 'https://www.instagram.com/p/abcdef/',
        evidenceUrl: 'https://example.com/',
      },
      {
        platform: 'x',
        url: 'https://x.com/search?q=store',
        evidenceUrl: 'https://example.com/',
      },
      {
        platform: 'facebook',
        url: 'http://facebook.com/example',
        evidenceUrl: 'https://example.com/',
      },
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });

  it('同一URLを重複追加しない', () => {
    const candidate = {
      platform: 'instagram',
      url: 'https://instagram.com/example/',
      evidenceUrl: 'https://example.com/',
    };
    const result = validateResearchedSocialLinks([candidate, candidate]);
    expect(result.accepted).toHaveLength(1);
  });
});
