// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://honjikoji.jp',

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [
    sitemap({
      // /columns/ は現在予告のみで実コンテンツが無いため、404ページとあわせて
      // サイトマップから除外する。
      filter: (page) => !page.includes('/columns/') && !page.includes('/404'),
    }),
  ],
});