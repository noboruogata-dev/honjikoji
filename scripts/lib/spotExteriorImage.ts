/**
 * scripts/lib/spotExteriorImage.ts
 *
 * design-assets/spots/<slug>.png（店舗の外観イラスト。線画スケッチ、灯り
 * だけ黄色。keyvisualと同じ画風）を、詳細ページ掲載用に最適化する。
 * scripts/prepare-spot-exterior.ts から呼ぶ。
 *
 * 想定外だった実際の課題: 第1弾（taisyu-yakiniku-sankiraku.png）は
 * 「透過PNG」として用意されたはずが、実際にはアルファチャンネルを持たず、
 * 透明部分が市松模様（グレーのチェッカーパターン）としてベタ塗りで
 * 焼き込まれていた。これはAI画像生成モデルがネイティブなアルファ
 * チャンネル出力に対応しておらず、透明の指示をしても市松模様や単色で
 * 「描く」だけになる既知の制約（scripts/lib/column-images.ts の
 * LOCKED_ART_DIRECTIONコメント参照）と同種の問題とみられる。
 *
 * column-images.tsの経験（AIが生成する挿絵全般を対象にした汎用の背景
 * 除去は、JPEG圧縮ノイズ等で誤検知が多く破綻した）を踏まえ、ここでは
 * 汎用の背景除去は行わない。代わりに、この用途（線画＋部分着色イラスト、
 * 市松模様は無彩色）に限定した彩度ベースのアルファ復元（dechecker）を
 * 用いる。市松模様の格子はほぼ無彩色（R≈G≈B、彩度ほぼ0）である一方、
 * 線画自体は生成り色・窓の黄色など明確な彩度を持つため、彩度でしきい値を
 * 切るだけで市松模様だけを高精度に透過にできる（アンチエイリアス境界は
 * 彩度が中間値になるため、副産物として自然になだらかなアルファが得られる）。
 * 既にアルファチャンネルを持つ画像（今後、正しく透過PNGとして書き出された
 * 場合）はdecheckerを完全にスキップする。
 */
import sharp from 'sharp';

/** 公開画像の長辺の上限(px)。詳細ページでの表示幅（実測220〜300px）に対し、
 *  高DPI端末でも潰れないよう十分な余裕を持たせた値。 */
export const SPOT_EXTERIOR_MAX_DIMENSION = 800;

/** 公開画像1枚あたりの目標上限（200KB）。scripts/lib/column-images.tsの
 *  MAX_PUBLIC_IMAGE_BYTESと同じ値・同じ考え方。 */
export const MAX_EXTERIOR_IMAGE_BYTES = 200 * 1024;

// 市松模様(彩度ほぼ0)と線画・着色部分(実測で彩度0.10前後以上)を分ける
// しきい値。design-assets/spots/taisyu-yakiniku-sankiraku.pngの実測値
// （市松模様: 0.00〜0.03、生成り色の線: 0.10〜0.13、黄色の窓: さらに高い）
// をもとに、間に十分なマージンを取って決めた。
const DECHECKER_SAT_LOW = 0.04;
const DECHECKER_SAT_HIGH = 0.14;

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  const min = Math.min(r, g, b);
  return (max - min) / max;
}

/**
 * アルファチャンネルを持たない画像から、彩度ベースでアルファチャンネルを
 * 復元する（上記コメント参照）。既に持っている画像には使わないこと
 * （無彩色に近い線画・被写体があると誤って透過させてしまうため）。
 */
export async function dechecker(source: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    const r = data[base];
    const g = data[base + 1];
    const b = data[base + 2];
    const sat = saturation(r, g, b);
    let alpha: number;
    if (sat <= DECHECKER_SAT_LOW) alpha = 0;
    else if (sat >= DECHECKER_SAT_HIGH) alpha = 255;
    else alpha = Math.round((255 * (sat - DECHECKER_SAT_LOW)) / (DECHECKER_SAT_HIGH - DECHECKER_SAT_LOW));
    const outBase = i * 4;
    out[outBase] = r;
    out[outBase + 1] = g;
    out[outBase + 2] = b;
    out[outBase + 3] = alpha;
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * design-assets/spots/<slug>.png から公開用の外観イラストを作る。
 * - アルファチャンネルが無ければdechecker()で復元してから処理する
 * - 長辺をSPOT_EXTERIOR_MAX_DIMENSIONに収める（fit: inside、拡大はしない）
 * - 減色パレットPNGで書き出す（WebPの非可逆圧縮は細い線がにじむため
 *   不採用。パレットPNGなら線のエッジを崩さずに200KB以下へ収められる。
 *   実測: taisyu-yakiniku-sankiraku.png 800px幅・64色で約170KB）
 */
export async function buildSpotExteriorImage(source: Buffer): Promise<Buffer> {
  const meta = await sharp(source).metadata();
  const withAlpha = meta.hasAlpha ? source : await dechecker(source);
  return sharp(withAlpha)
    .resize(SPOT_EXTERIOR_MAX_DIMENSION, SPOT_EXTERIOR_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .png({ palette: true, colors: 64, compressionLevel: 9, effort: 10 })
    .toBuffer();
}
