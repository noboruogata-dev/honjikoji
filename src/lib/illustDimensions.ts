// Illust.astro が width/height を明示出力するための、リサイズ後イラスト素材の
// 実測アスペクト比テーブル。srcを追加/変更した場合はここも更新する。
export const ILLUST_DIMENSIONS: Record<string, { w: number; h: number }> = {
  '/images/icons/icon-mike.png': { w: 96, h: 113 },
  '/images/icons/icon-oden.png': { w: 96, h: 96 },
  '/images/icons/icon-ramen.png': { w: 96, h: 96 },
  '/images/icons/icon-shaker.png': { w: 96, h: 96 },
  '/images/icons/icon-tokkuri.png': { w: 96, h: 96 },
  '/images/icons/icon-yakiami.png': { w: 96, h: 96 },

  '/images/rules/rule-chochin.png': { w: 480, h: 240 },
  '/images/rules/rule-noren.png': { w: 480, h: 240 },
  '/images/rules/rule-ochoko.png': { w: 480, h: 240 },

  '/images/timeline/era-edo.png': { w: 200, h: 200 },
  '/images/timeline/era-heisei.png': { w: 200, h: 200 },
  '/images/timeline/era-meiji-taisho.png': { w: 200, h: 200 },
  '/images/timeline/era-reiwa.png': { w: 200, h: 200 },
  '/images/timeline/era-showa.png': { w: 200, h: 200 },

  '/images/states/404.png': { w: 500, h: 375 },
  '/images/states/empty.png': { w: 500, h: 375 },
};
