// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// scripts/generate-guides-manifest.ts が prebuild フックで書き出す、
// テーマ別まとめページ（/guides/<slug>/）ごとの該当店舗数・noindex判定。
// astro:content はここ（Astroのビルド設定ファイル）からは使えないため、
// 判定ロジック自体はsrc/lib/guides.ts側の1箇所だけに置き、ここではその
// 結果（JSON）を読むだけにする。prebuildの前にbuildが走ることはない
// （npmのpre*フックの仕組み）ため、常に最新の内容を読める。
// 万一ファイルが無い・壊れている場合は「何も除外しない」側に倒す
// （sitemap生成自体を壊さないため）。
function readNoindexGuidePaths() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./guides-manifest.json', import.meta.url), 'utf-8'));
    return Object.entries(manifest)
      .filter(([, value]) => value?.noindex)
      .map(([slug]) => `/guides/${slug}/`);
  } catch {
    return [];
  }
}

const noindexGuidePaths = readNoindexGuidePaths();

// https://astro.build/config
export default defineConfig({
  site: 'https://honjikoji.jp',

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [
    sitemap({
      // /columns/ は現在予告のみで実コンテンツが無いため、404ページとあわせて
      // サイトマップから除外する。/guides/配下は該当店舗数が少ないページ
      // （noindexGuidePaths）だけを除外する。
      filter: (page) =>
        !page.includes('/columns/') && !page.includes('/404') && !noindexGuidePaths.some((path) => page.includes(path)),
    }),
  ],
});
