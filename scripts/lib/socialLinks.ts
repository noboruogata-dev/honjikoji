import { z } from 'zod';

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'x', 'line'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface ResearchedSocialLink {
  platform: SocialPlatform;
  url: string;
  evidenceUrl: string;
}

export interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS URLのみ許可します');

const researchedSocialLinkSchema = z.object({
  platform: z.enum(SOCIAL_PLATFORMS),
  url: httpsUrl,
  evidenceUrl: httpsUrl,
});

const RESERVED_PROFILE_PATHS = new Set([
  'explore',
  'p',
  'reel',
  'reels',
  'stories',
  'search',
  'share',
  'intent',
  'hashtag',
  'i',
  'home',
]);

function isPlatformAccountUrl(platform: SocialPlatform, rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);

  switch (platform) {
    case 'instagram':
      return host === 'instagram.com' && segments.length === 1 && !RESERVED_PROFILE_PATHS.has(segments[0].toLowerCase());
    case 'facebook':
      return (
        host === 'facebook.com' &&
        ((segments.length === 1 && !RESERVED_PROFILE_PATHS.has(segments[0].toLowerCase())) ||
          (segments[0] === 'profile.php' && url.searchParams.has('id')))
      );
    case 'x':
      return (
        (host === 'x.com' || host === 'twitter.com') &&
        segments.length === 1 &&
        !RESERVED_PROFILE_PATHS.has(segments[0].toLowerCase())
      );
    case 'line':
      return host === 'line.me' && /^\/(?:R\/)?ti\/p\//i.test(url.pathname);
  }
}

/**
 * Agent 1の候補から、形式上「SNSのアカウントURL」と確定できるものだけを残す。
 * 公式性そのものはGoogle Search Groundingで収集したevidenceUrlに依存するため、
 * 少しでも曖昧な候補はAgent 1に空配列で返させる。ここでは投稿・検索・共有URLや
 * 非HTTPS URLを決定論的に排除し、重複も除去する。
 */
export function validateResearchedSocialLinks(input: unknown): {
  accepted: SocialLink[];
  rejected: string[];
} {
  if (!Array.isArray(input)) return { accepted: [], rejected: ['socialLinksが配列ではありません'] };

  const accepted: SocialLink[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  input.forEach((candidate, index) => {
    const parsed = researchedSocialLinkSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push(`socialLinks[${index}]: 必須項目またはHTTPS URLが不正です`);
      return;
    }

    const { platform, url } = parsed.data;
    if (!isPlatformAccountUrl(platform, url)) {
      rejected.push(`socialLinks[${index}]: ${platform}のアカウントURLではありません (${url})`);
      return;
    }

    const key = `${platform}:${url.toLowerCase().replace(/\/$/, '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    accepted.push({ platform, url });
  });

  return { accepted, rejected };
}
