import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const spots = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/spots' }),
  schema: z.object({
    title: z.string(),
    genre: z.string(),
    area: z.string(),
    address: z.string(),
    businessHours: z.string(),
    budget: z.string(),
    features: z.array(z.string()),
    description: z.string(),
    publishedAt: z.coerce.date(),
  }),
});

export const collections = { spots };
