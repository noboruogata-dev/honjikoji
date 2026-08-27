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
    // 予算帯フィルタ用の数値上限（任意）。表示用の budget 文字列とは独立して並走させる。
    budgetMax: z.number().int().positive().optional(),
    openHours: z.string(),
    regularHoliday: z.string(),
    vibes: z.array(z.string()),
    // 開店・リニューアルオープンから概ね1年以内の新店舗フラグ。
    isNew: z.boolean().default(false),
    // 機械可読な営業時間（任意）。openHours/regularHoliday（表示用の自由文字列）とは
    // 独立して並走させる。1要素が「daysに含まれる曜日すべてに共通する1つの営業区間」。
    // close は「その曜日の0:00からの経過時刻」として24を超える値を許容する
    // （例: 19:00開店・翌2:00閉店 → open: "19:00", close: "26:00"）。
    // 日またぎ・定休日の判定ロジックは src/lib/hours.ts の getOpenStatus を参照。
    hours: z
      .array(
        z.object({
          days: z.array(z.number().int().min(0).max(6)), // 0=日曜, 1=月曜, ... 6=土曜
          open: z.string().regex(/^\d{1,2}:\d{2}$/),
          close: z.string().regex(/^\d{1,2}:\d{2}$/),
        })
      )
      .optional(),
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
