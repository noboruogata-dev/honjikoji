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
    // 予算帯フィルタ用の数値下限（任意）。表示用の budget 文字列とは独立して
    // 並走させる。spots/index.astroの予算フィルタは「〜¥3,000」のような
    // 上限ラベルでも budgetMin（下限）で判定する（例: budget "¥3,000〜¥4,000"
    // の店は「〜¥3,000」を選んだ利用者にとって候補になり得るため）。
    budgetMin: z.number().int().positive().optional(),
    // 予算帯の数値上限（任意）。現在フィルタでは使っていないが、将来使う
    // 可能性があるため削除せず残す。表示用の budget 文字列とは独立して並走させる。
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
    // 不定休の店で、hoursに便宜上「毎日営業」等として登録している場合に true。
    // 構造化データ（openingHoursSpecification）の出力可否や、OpenStatusの
    // 表示文言（「営業中（不定休）」）の判定に使う。hours/budgetMaxと同じく
    // 完全な任意フィールド（省略時はfalse相当、falseは書き込まない）。
    // 「isIrregular: true かつ hours あり」は本来矛盾しうる組み合わせだが、
    // bar-keywest.md だけは意図的な例外として両方を持つ
    // （実際の休業曜日は特定できないが、既知の営業時間帯を毎日分として
    // 登録し、サイト内表示では営業中カウントに含めつつ「不定休」の
    // 但し書きを添える、という運用上の判断。詳細はbar-keywest.md自身の
    // コメントを参照）。
    isIrregular: z.boolean().optional(),
    // 店舗紹介動画（任意）。1店舗に複数（旧店舗/新店舗など）が紐づきうるため配列。
    youtubeVideos: z
      .array(
        z.object({
          id: z.string().regex(/^[A-Za-z0-9_-]{11}$/), // YouTube動画ID
          label: z.string().optional(), // 「旧店舗」「新店舗」等の補足
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

const columns = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/columns' }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    category: z.enum(['お酒の豆知識', '街の歴史', '店と人', '夜の作法']),
    summary: z.string(),
    // standard=一般コラム / history=歴史検証 / interview=取材 / fiction=創作。
    kind: z.enum(['standard', 'history', 'interview', 'fiction']),
    // 通常生成は下書き。定期自動公開では決定論的QA通過後にfalseで保存する。
    draft: z.boolean().default(true),
    sources: z
      .array(
        z.object({
          title: z.string(),
          url: z.string().url(),
          type: z.enum(['official', 'primary', 'secondary', 'provided']),
        })
      )
      .optional(),
    disclaimer: z.string().optional(),
    illustration: z
      .object({
        src: z.string(),
        alt: z.string(),
      })
      .optional(),
    eyecatch: z
      .object({
        src: z.string(),
        alt: z.string(),
      })
      .optional(),
    // qa-passed=決定論的画像QA通過 / reviewed=人による目視確認済み。
    imageStatus: z.enum(['draft', 'qa-passed', 'reviewed']).optional(),
  }),
});

export const collections = { spots, news, columns };
