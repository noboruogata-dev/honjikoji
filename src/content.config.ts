import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const spots = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/spots' }),
  schema: z.object({
    title: z.string(),
    genre: z.string(),
    address: z.string(),
    // Google マップの検索クエリ（"店名 三条市" 形式）。
    mapQuery: z.string(),
    budget: z.string(),
    openHours: z.string(),
    regularHoliday: z.string(),
    vibes: z.array(z.string()),
    // 開店・リニューアルオープンから概ね1年以内の新店舗フラグ。
    isNew: z.boolean().default(false),
    description: z.string(),
    pubDate: z.coerce.date(),
  }),
});

const news = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/news' }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    category: z.enum(['NEW SPOT', 'EVENT', 'NOTICE']),
    summary: z.string(),
    // 関連する店舗記事（src/content/spots/[slug].md）へのリンク用。
    relatedSpotSlug: z.string().optional(),
  }),
});

export const collections = { spots, news };
