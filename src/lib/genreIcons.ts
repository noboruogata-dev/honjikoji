// ジャンル文字列 → アイコンPNG(public/images/icons/)のマップ。
// PNG化されていないジャンル（割烹・小料理・立ち飲み等）はGenreIcon.astro側で
// 既存のLucideアイコンにフォールバックする。ジャンル追加時はここに1行足すだけでよい。
export const GENRE_ICON_MAP: Record<string, string> = {
  居酒屋: '/images/icons/icon-tokkuri.png',
  BAR: '/images/icons/icon-shaker.png',
  焼肉: '/images/icons/icon-yakiami.png',
  ラーメン: '/images/icons/icon-ramen.png',
  スナック: '/images/icons/icon-mike.png',
  おでん: '/images/icons/icon-oden.png',
};
