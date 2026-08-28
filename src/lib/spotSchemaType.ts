// ジャンル文字列 → schema.org 構造化データの @type のマップ。
// 対応表に無いジャンルは 'Restaurant'（一般的な飲食店）にフォールバックする。
// お酒中心・軽食主体の業態（BAR・スナック・立ち飲み）は BarOrPub、
// 食事が主体の業態は Restaurant に分類している。
// BarOrPubもRestaurantと同じくFoodEstablishmentのサブタイプなので、
// servesCuisine/priceRange等の共通プロパティはどちらでも使える。
// ジャンル追加時はここに1行足すだけでよい（src/lib/genreIcons.ts と同じ方針）。
export const GENRE_SCHEMA_TYPE: Record<string, string> = {
  BAR: 'BarOrPub',
  スナック: 'BarOrPub',
  立ち飲み: 'BarOrPub',
  居酒屋: 'Restaurant',
  割烹: 'Restaurant',
  焼肉: 'Restaurant',
  焼き鳥: 'Restaurant',
  ラーメン: 'Restaurant',
  おでん: 'Restaurant',
  小料理屋: 'Restaurant',
};

export function getSpotSchemaType(genre: string): string {
  return GENRE_SCHEMA_TYPE[genre] ?? 'Restaurant';
}
