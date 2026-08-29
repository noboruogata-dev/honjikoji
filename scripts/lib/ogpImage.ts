/**
 * scripts/lib/ogpImage.ts
 *
 * 店舗・コラム・ニュース記事ごとのOGP画像（1200×630px PNG）を、satori
 * （JSXライクなツリー→SVG）+ sharp（SVG→PNGラスタライズ）で決定論的に
 * 生成する。LLMは使わない。
 *
 * 生成方式の選定について: satori+sharpのペアはVercelのog-image生成が
 * 広めた定番のsatori+resvg-jsの組み合わせと違い、resvg-jsを新規追加せず
 * 既存のsharpだけで完結できることを実測で確認している（satoriはテキストを
 * <path>としてSVGに埋め込むため、ラスタライズ側はフォントを一切知らなくて
 * よく、librsvgベースのsharpでも問題なく描画できる）。
 */

import satori from 'satori';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(__dirname, '../assets/fonts');
const RULES_DIR = path.resolve(__dirname, '../../public/images/rules');

const WIDTH = 1200;
const HEIGHT = 630;

export type OgpContentType = 'spot' | 'news' | 'column' | 'guide';

export interface OgpImageInput {
  /** レイアウトの微調整に使う程度で、現状は全タイプほぼ共通デザイン。 */
  type: OgpContentType;
  title: string;
  /** タイトル直下に出す小さいラベル（例: "居酒屋 ／ 本寺小路" "お知らせ" "街の歴史"）。 */
  label: string;
}

// フォント・装飾画像は1プロセス内で使い回す（複数枚生成する際に毎回
// ディスクから読み直さない）。
let fontCache: { mincho: Buffer; gothic: Buffer } | undefined;
let lanternDataUriCache: string | undefined;

async function loadFonts() {
  if (!fontCache) {
    const [mincho, gothic] = await Promise.all([
      readFile(path.join(FONTS_DIR, 'ShipporiMincho-Bold-subset.ttf')),
      readFile(path.join(FONTS_DIR, 'NotoSansJP-Regular-subset.ttf')),
    ]);
    fontCache = { mincho, gothic };
  }
  return fontCache;
}

async function loadLanternDataUri(): Promise<string> {
  if (!lanternDataUriCache) {
    const png = await readFile(path.join(RULES_DIR, 'rule-chochin.png'));
    lanternDataUriCache = `data:image/png;base64,${png.toString('base64')}`;
  }
  return lanternDataUriCache;
}

/**
 * タイトルの文字数に応じてフォントサイズを段階的に下げ、それでも収まらない
 * ほど長い場合は末尾を省略記号「…」で切り詰める。satoriにはブラウザの
 * text-overflow相当の「はみ出したら自動縮小」機能が無いため、文字数ベースの
 * ヒューリスティックで対応する（satoriベースのOGP画像生成で一般的に使われる
 * 手法）。サロゲートペア文字（絵文字等）を考慮し配列展開で文字数を数える。
 */
function fitTitle(title: string): { fontSize: number; text: string } {
  const chars = [...title];
  const len = chars.length;

  if (len <= 12) return { fontSize: 64, text: title };
  if (len <= 20) return { fontSize: 52, text: title };
  if (len <= 32) return { fontSize: 42, text: title };

  const TRUNCATE_AT = 40;
  const truncated = chars.length > TRUNCATE_AT ? `${chars.slice(0, TRUNCATE_AT).join('')}…` : title;
  return { fontSize: 36, text: truncated };
}

async function buildTree(input: OgpImageInput) {
  const { mincho, gothic } = await loadFonts();
  const lanternDataUri = await loadLanternDataUri();
  const { fontSize, text } = fitTitle(input.title);

  const tree = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        padding: '0 96px',
        backgroundColor: '#14110f',
        backgroundImage:
          'linear-gradient(135deg, #14110f 0%, #1c1611 55%, #2e1f14 100%),' +
          'radial-gradient(ellipse 70% 60% at 12% 0%, rgba(242,181,68,0.16), rgba(242,181,68,0) 60%),' +
          'radial-gradient(ellipse 55% 55% at 100% 10%, rgba(226,71,47,0.14), rgba(226,71,47,0) 60%)',
        color: '#f2e9d8',
        fontFamily: 'Noto Sans JP',
        overflow: 'hidden',
      },
      children: [
        // 装飾: 提灯イラスト（右上、控えめな不透明度）。全コンテンツ種別で
        // 共通にすることで「本寺小路ガイドの記事」だと一目で分かる
        // ブランド上の一貫性を優先した。
        {
          type: 'img',
          props: {
            src: lanternDataUri,
            width: 128,
            height: 128,
            style: { position: 'absolute', top: '48px', right: '64px', opacity: 0.85 },
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontFamily: 'Shippori Mincho',
              fontSize,
              fontWeight: 700,
              lineHeight: 1.4,
              textAlign: 'center',
              letterSpacing: '0.02em',
            },
            children: text,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: 28,
              marginTop: '28px',
              color: '#e8c468',
              letterSpacing: '0.05em',
            },
            children: input.label,
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              position: 'absolute',
              bottom: '44px',
              fontSize: 20,
              letterSpacing: '0.15em',
              color: 'rgba(242,233,216,0.55)',
            },
            children: '本寺小路ガイド',
          },
        },
      ],
    },
  };

  return { tree, mincho, gothic };
}

/**
 * OGP画像（1200×630 PNG）を生成する。フォントに無い文字が含まれる場合や
 * その他のレンダリング失敗時は例外を投げる（呼び出し側でcatchし、
 * ogp-default.pngへのフォールバックとして扱うこと。誤って崩れた画像を
 * 出すよりは、汎用のデフォルト画像の方が安全という方針）。
 */
export async function renderOgpImage(input: OgpImageInput): Promise<Buffer> {
  const { tree, mincho, gothic } = await buildTree(input);

  const svg = await satori(tree, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: 'Shippori Mincho', data: mincho, weight: 700, style: 'normal' },
      { name: 'Noto Sans JP', data: gothic, weight: 400, style: 'normal' },
    ],
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}
