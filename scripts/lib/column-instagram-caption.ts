/**
 * scripts/lib/column-instagram-caption.ts
 *
 * コラム記事のInstagram投稿キャプション用の元データを、frontmatterから
 * 機械的に組み立てる。ここで作るのは「タイトル・導入文・URL」という
 * 素材だけで、実際のキャプション文言（改行の入れ方・ハッシュタグ・
 * CTA等の文面）や投稿処理（Graph API呼び出し等）は将来の自動投稿の
 * 実装側に委ねる（このファイルはLLMも使わない）。
 */

// astro.config.mjs の `site` と同じ値。サイトのドメインを変更する場合は
// 両方直すこと。
const SITE_URL = 'https://honjikoji.jp';

export interface ColumnInstagramCaptionInput {
  slug: string;
  title: string;
  summary: string;
}

export interface ColumnInstagramCaptionData {
  title: string;
  summary: string;
  url: string;
}

/** コラム記事のInstagram投稿キャプション用データ（タイトル・導入文・URL）を組み立てる。 */
export function buildColumnInstagramCaption(input: ColumnInstagramCaptionInput): ColumnInstagramCaptionData {
  return {
    title: input.title,
    summary: input.summary,
    url: `${SITE_URL}/columns/${input.slug}/`,
  };
}
