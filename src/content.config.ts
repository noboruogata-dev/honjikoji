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
    description: z.string(),
    pubDate: z.coerce.date(),
  }),
});

export const collections = { spots };
