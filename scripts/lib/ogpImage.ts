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
import { loadDefaultJapaneseParser } from 'budoux';
import { create as createFontkitFont, type Font as FontkitFont } from 'fontkit';
import { readFileSync } from 'node:fs';
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

// ============================================================
// グリフ有無の事前検査
//
// フォントに無い文字をsatoriで描画すると、例外にはならず.notdef
// グリフ（tofu box、□）として黙って「成功」してしまう。サブセット
// フォントをJIS X 0208全域まで広げても、それすら無い外字・異体字・
// 絵文字等は存在しうるため、実際に描画する文字列を事前にfontkitで検査し、
// 欠けている文字を検出できるようにする（renderOgpImage/
// renderInstagramFeedImage自体には無害な描画を強制する手段が無いため、
// 呼び出し側がこの関数の結果を見て生成をスキップする、という運用にする。
// scripts/generate-ogp-images.ts・scripts/lib/instagramMaterialAgent.ts
// の呼び出し箇所を参照）。
// ============================================================

let fontkitCache: { mincho: FontkitFont; gothic: FontkitFont } | undefined;

async function loadFontkitFonts() {
  if (!fontkitCache) {
    const { mincho, gothic } = await loadFonts();
    fontkitCache = {
      mincho: createFontkitFont(mincho) as FontkitFont,
      gothic: createFontkitFont(gothic) as FontkitFont,
    };
  }
  return fontkitCache;
}

/** textのうち、fontに存在しないグリフの文字を重複無しで返す（空白類は除外）。 */
function findMissingChars(text: string, font: FontkitFont): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    if (!font.hasGlyphForCodePoint(codePoint)) missing.add(ch);
  }
  return [...missing];
}

/**
 * renderOgpImage/renderInstagramFeedImageが実際に描画する文字列
 * （title→Shippori Mincho、label→Noto Sans JP）について、フォントに
 * 無い文字を検査する。空配列なら全文字が描画できる。例外は投げない。
 */
export async function checkGlyphCoverage(input: OgpImageInput): Promise<string[]> {
  const { mincho, gothic } = await loadFontkitFonts();
  const missing = new Set<string>([...findMissingChars(input.title, mincho), ...findMissingChars(input.label, gothic)]);
  return [...missing];
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

// ============================================================
// Instagram投稿用フィード画像（1080×1350、4:5）
//
// Instagramのフィード表示は4:5が推奨（1:1正方形は上下に余白が入り
// 小さく表示される）ため、この比率で統一する。
//
// 店舗記事・お知らせにはコラムのようなAIイラストが無いため、OGP画像と
// 同じsatori+sharp基盤（フォント・提灯装飾を共有）でタイトル文字を主役に
// した画像を組む。意匠（暗い背景・琥珀色のグロー・明朝体のタイトル・
// 下部のサイト名）は src/lib/column-images.ts の createFeedImage /
// renderFeedSiteLabel と揃えている（あちらはAIイラストの切り出し、
// こちらはタイトル文字が主役という違いのみ）。
// ============================================================

const FEED_WIDTH = 1080;
const FEED_HEIGHT = 1350;
// 左右合計144px（片側72px）。fitFeedTitleの各段のmaxCharsPerLineは
// このコンテンツ幅（1080-144=936px、幅は1:1版から変更していない）を
// 前提に決めている。高さだけ1080→1350に伸びたぶんは、タイトル・
// ラベルのブロックをflexGrowで囲んで縦方向に自動で中央寄せすることで
// 吸収する（提灯とサイト名は上下に固定、詳細はbuildFeedTree参照）。
const FEED_HORIZONTAL_PADDING = 72;

// ============================================================
// フィード画像タイトルの改行
//
// 以前は「1行の文字数上限まで詰め、記号・助詞の禁則ルールで調整する」方式
// だったが、文字数基準では意味の切れ目が分からず（「連れら|れホンジ」
// 「無|料」のように語の途中で切れる）、行の長さも揃わなかった。不具合の
// たびにルールを足し、特定タイトル専用の分岐まで生じていたため、次の方式に
// 置き換えた:
// 1. BudouX（Googleの日本語改行位置推定。ローカル・決定論的）で文節の
//    切れ目を求め、そこを改行候補にする。文節内・括弧内でも改行はできるが
//    減点する（収まらない長い語句のための逃げ道）。
// 2. 各行の幅は文字数ではなく、実際のフォント（Shippori Mincho Bold）の
//    字幅で測る（半角英数字は全角の約半分の幅しかない）。
// 3. 候補のフォントサイズ×行数（1〜3行）ごとに、最も減点の少ない分け方を
//    求め、「大きい文字」「行の長さが揃っている」「減点が少ない」の総合点で
//    最良のものを選ぶ。
// ============================================================

const FEED_CONTENT_WIDTH = FEED_WIDTH - FEED_HORIZONTAL_PADDING * 2;
// buildFeedTreeのタイトルのletterSpacing（0.02em）と同じ値。
const FEED_TITLE_LETTER_SPACING_EM = 0.02;
const FEED_TITLE_FONT_SIZES = [100, 88, 76, 68, 60, 54, 48, 44] as const;
const FEED_TITLE_MAX_LINES = 3;
// 3行組みは大きすぎる文字だと画面を埋めて圧迫感が出るため、この大きさ以下に限る。
const FEED_TITLE_MAX_FONT_SIZE_FOR_3_LINES = 68;

// 行頭に置かない文字（閉じ括弧・句読点・長音・小書き仮名）と、行末に置かない文字（開き括弧）。
const FORBIDDEN_LINE_START = /^[、。，．！？!?」』）)】〕・ー〜ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u;
const FORBIDDEN_LINE_END = /[「『（(【〔]$/u;
const OPENING_BRACKET = /[「『（(【〔]/u;
const CLOSING_BRACKET = /[」』）)】〕]/u;

// 改行位置ごとの減点（総合点の単位は「フォントサイズのpx」相当）。
const PENALTY_INSIDE_PHRASE = 30;
// 文節の途中でも、英数字とそれ以外の文字の境目（「フェスティバル|2026」）は自然に切れる。
const PENALTY_SCRIPT_BOUNDARY = 8;
const PENALTY_INSIDE_BRACKETS = 14;
// 文の区切り（！？。、）の直後は最も自然な改行位置なので、減点ではなく加点する。
const BONUS_AFTER_PUNCTUATION = 6;
const PENALTY_THREE_LINES = 4;

let budouxParser: ReturnType<typeof loadDefaultJapaneseParser> | undefined;
let measureFont: FontkitFont | undefined;

function getMeasureFont(): FontkitFont {
  if (!measureFont) {
    measureFont = createFontkitFont(readFileSync(path.join(FONTS_DIR, 'ShipporiMincho-Bold-subset.ttf'))) as FontkitFont;
  }
  return measureFont;
}

/** 1em あたりの幅で、textの表示幅を返す（letterSpacing込み）。 */
function measureEm(text: string): number {
  const font = getMeasureFont();
  const run = font.layout(text);
  return run.advanceWidth / font.unitsPerEm + [...text].length * FEED_TITLE_LETTER_SPACING_EM;
}

interface BreakSlot {
  /** この位置（文字インデックス）の直前で改行してよいか。 */
  allowed: boolean;
  penalty: number;
}

/**
 * タイトルを文字の配列にし、各文字の直前で改行する場合の可否と減点を求める。
 * slots[i] は chars[i] の直前（i=1..n-1）。
 */
function analyzeBreaks(title: string): { chars: string[]; slots: BreakSlot[] } {
  budouxParser ??= loadDefaultJapaneseParser();
  const chars = [...title];
  const phraseStarts = new Set<number>();
  let pos = 0;
  for (const phrase of budouxParser.parse(title)) {
    phraseStarts.add(pos);
    pos += [...phrase].length;
  }
  // 空白の直後も文節の切れ目とみなす（「酒采とお食事 どっぽ」等の店名）。
  chars.forEach((ch, i) => {
    if (/\s/u.test(ch)) phraseStarts.add(i + 1);
  });

  const slots: BreakSlot[] = [];
  let depth = 0;
  for (let i = 0; i < chars.length; i += 1) {
    if (i > 0) {
      const before = chars.slice(0, i).join('');
      const after = chars.slice(i).join('');
      const insideWord = /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(after);
      const allowed =
        !insideWord && !FORBIDDEN_LINE_START.test(after) && !FORBIDDEN_LINE_END.test(before) && !/^\s/u.test(after);
      const scriptBoundary = /[A-Za-z0-9]$/.test(before) !== /^[A-Za-z0-9]/.test(after);
      let penalty = 0;
      if (!phraseStarts.has(i)) penalty += scriptBoundary ? PENALTY_SCRIPT_BOUNDARY : PENALTY_INSIDE_PHRASE;
      if (/[、。！？!?]$/u.test(before)) penalty -= BONUS_AFTER_PUNCTUATION;
      if (depth > 0) penalty += PENALTY_INSIDE_BRACKETS;
      slots[i] = { allowed, penalty };
    }
    if (OPENING_BRACKET.test(chars[i])) depth += 1;
    else if (CLOSING_BRACKET.test(chars[i]) && depth > 0) depth -= 1;
  }
  return { chars, slots };
}

interface FeedTitleLayout {
  fontSize: number;
  lines: string[];
  score: number;
}

/**
 * chars を lineCount 行に分ける全通りのうち、最大幅に収まり減点が最小のものを返す。
 * タイトルは高々数十文字・最大3行なので総当たりで十分速い。
 */
function bestSplit(chars: string[], slots: BreakSlot[], lineCount: number, maxEm: number) {
  const n = chars.length;
  const widthCache = new Map<string, number>();
  const lineWidth = (start: number, end: number): number => {
    const key = `${start}:${end}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = measureEm(chars.slice(start, end).join('').trim());
      widthCache.set(key, w);
    }
    return w;
  };

  let best: { breaks: number[]; widths: number[]; penalty: number; balance: number } | undefined;
  const visit = (start: number, remaining: number, breaks: number[], widths: number[], penalty: number) => {
    if (remaining === 1) {
      const w = lineWidth(start, n);
      if (w > maxEm) return;
      const allWidths = [...widths, w];
      // 平均行長/最長行。最終行だけが短いのは自然なので、最短行ではなく平均で測る。
      const balance = allWidths.reduce((sum, x) => sum + x, 0) / allWidths.length / Math.max(...allWidths);
      if (!best || penalty < best.penalty || (penalty === best.penalty && balance > best.balance)) {
        best = { breaks, widths: allWidths, penalty, balance };
      }
      return;
    }
    for (let end = start + 1; end < n; end += 1) {
      const slot = slots[end];
      if (!slot.allowed) continue;
      const w = lineWidth(start, end);
      if (w > maxEm) break;
      visit(end, remaining - 1, [...breaks, end], [...widths, w], penalty + slot.penalty);
    }
  };
  visit(0, lineCount, [], [], 0);
  if (!best) return undefined;

  const bounds = [0, ...best.breaks, n];
  const lines = bounds.slice(0, -1).map((s, i) => chars.slice(s, bounds[i + 1]).join('').trim());
  return { lines, penalty: best.penalty, balance: best.balance };
}

function layoutFeedTitle(title: string): FeedTitleLayout | undefined {
  const { chars, slots } = analyzeBreaks(title);
  let best: FeedTitleLayout | undefined;
  for (const fontSize of FEED_TITLE_FONT_SIZES) {
    const maxEm = FEED_CONTENT_WIDTH / fontSize;
    for (let lineCount = 1; lineCount <= FEED_TITLE_MAX_LINES; lineCount += 1) {
      if (lineCount === 3 && fontSize > FEED_TITLE_MAX_FONT_SIZE_FOR_3_LINES) continue;
      const split = bestSplit(chars, slots, lineCount, maxEm);
      if (!split) continue;
      // 大きい文字ほど良いが、行の長さが極端に不揃いなら割り引く（balance=平均行長/最長行）。
      const score =
        fontSize * (0.6 + 0.4 * split.balance) - split.penalty - (lineCount === 3 ? PENALTY_THREE_LINES : 0);
      if (!best || score > best.score) best = { fontSize, lines: split.lines, score };
      // 同じフォントサイズなら、収まる最少行数より多く分けても見た目は良くならない
      // ことが多いので、減点の無い分け方が見つかった時点でこのサイズは打ち切る。
      if (split.penalty <= 0) break;
    }
  }
  return best;
}

/**
 * タイトルの改行位置とフォントサイズを決める（考え方はこの節冒頭のコメント参照）。
 * 最小サイズ・3行でも収まらない場合は、末尾を省略記号で切り詰めて収める。
 * テスト用にexportする。
 */
export function fitFeedTitle(title: string): { fontSize: number; lines: string[] } {
  const chars = [...title];
  for (let keep = chars.length; keep > 0; keep -= 1) {
    const candidate = keep === chars.length ? title : `${chars.slice(0, keep).join('').trimEnd()}…`;
    const layout = layoutFeedTitle(candidate);
    if (layout) return { fontSize: layout.fontSize, lines: layout.lines };
  }
  return { fontSize: FEED_TITLE_FONT_SIZES[FEED_TITLE_FONT_SIZES.length - 1], lines: [title] };
}

async function buildFeedTree(input: OgpImageInput) {
  const { mincho, gothic } = await loadFonts();
  const lanternDataUri = await loadLanternDataUri();
  const { fontSize, lines } = fitFeedTitle(input.title);

  const tree = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: `${FEED_WIDTH}px`,
        height: `${FEED_HEIGHT}px`,
        padding: `0 ${FEED_HORIZONTAL_PADDING}px`,
        backgroundColor: '#14110f',
        backgroundImage:
          'linear-gradient(160deg, #14110f 0%, #1c1611 55%, #2e1f14 100%),' +
          'radial-gradient(ellipse 65% 50% at 62% 42%, rgba(242,181,68,0.18), rgba(242,181,68,0) 60%)',
        color: '#f2e9d8',
        fontFamily: 'Noto Sans JP',
        overflow: 'hidden',
      },
      children: [
        // 飾り罫線（上）。column-images.tsのフィード画像と同じ意匠を、
        // border-topを持つ1px div（satoriが対応するCSSプロパティ）で再現する
        // （あちらはraw SVG合成、こちらはsatoriツリー内で完結させるための
        // 表現方法の違いのみ）。4:5化で伸びた余白に「意図的な枠」の印象を
        // 与える。
        {
          type: 'div',
          props: { style: { display: 'flex', height: '1px', marginTop: '30px', backgroundColor: 'rgba(216,203,184,0.14)' } },
        },
        // 提灯ゾーン: 上端に固定（高さは中身に合わせた自動サイズ）。
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'center', paddingTop: '64px' },
            children: [
              {
                type: 'img',
                props: {
                  // 罫線の提灯（PNG本体は480x240=2:1）。本来の比率のまま
                  // 幅を広げて余白との釣り合いを取る。
                  src: lanternDataUri,
                  width: 220,
                  height: 110,
                  style: { opacity: 0.85 },
                },
              },
            ],
          },
        },
        // タイトル+ラベルゾーン: flexGrowで残り全部の高さを取り、その中で
        // 縦方向に中央寄せする。1:1から4:5に高さが伸びた分（+270px）は
        // すべてこのゾーンが吸収するため、提灯・サイト名の位置は変わらず、
        // タイトル周りの余白だけが伸びる（＝余白が「意図的な間」に見える）。
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    fontFamily: 'Shippori Mincho',
                    fontSize,
                    fontWeight: 700,
                    lineHeight: 1.4,
                    textAlign: 'center',
                    letterSpacing: '0.02em',
                  },
                  // 行ごとに独立したdivとして描画する（satoriの自動折り返しに
                  // 任せず、fitFeedTitleが決めた行単位を厳密に守るため）。
                  children: lines.map((line) => ({ type: 'div', props: { children: line } })),
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    fontSize: 30,
                    marginTop: '28px',
                    color: '#e8c468',
                    letterSpacing: '0.05em',
                  },
                  children: input.label,
                },
              },
            ],
          },
        },
        // サイト名ゾーン: 下端に固定。
        {
          type: 'div',
          props: {
            style: { display: 'flex', justifyContent: 'center', paddingBottom: '56px' },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    fontSize: 26,
                    letterSpacing: '0.15em',
                    // コラムのフィード画像のサイト名ラベルと同じ色（生成り色、非完全白）。
                    color: 'rgba(216,203,184,0.82)',
                  },
                  children: '本寺小路ガイド',
                },
              },
            ],
          },
        },
        // 飾り罫線（下）。上と対になる位置に置く。
        {
          type: 'div',
          props: { style: { display: 'flex', height: '1px', marginBottom: '30px', backgroundColor: 'rgba(216,203,184,0.14)' } },
        },
      ],
    },
  };

  return { tree, mincho, gothic };
}

/**
 * Instagram投稿用フィード画像（1080×1350 WebP、4:5）を生成する。
 * renderOgpImageと同様、フォントに無い文字やその他のレンダリング失敗時は
 * 例外を投げる（呼び出し元でcatchし、Instagram素材生成自体をスキップ
 * すること。scripts/lib/instagramMaterialAgent.ts参照）。
 */
export async function renderInstagramFeedImage(input: OgpImageInput): Promise<Buffer> {
  const { tree, mincho, gothic } = await buildFeedTree(input);

  const svg = await satori(tree, {
    width: FEED_WIDTH,
    height: FEED_HEIGHT,
    fonts: [
      { name: 'Shippori Mincho', data: mincho, weight: 700, style: 'normal' },
      { name: 'Noto Sans JP', data: gothic, weight: 400, style: 'normal' },
    ],
  });

  // コラムのフィード画像(createFeedImage)と同じWebP・品質で揃える。
  return sharp(Buffer.from(svg)).webp({ quality: 84 }).toBuffer();
}
