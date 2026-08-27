/**
 * scripts/match-youtube.ts
 *
 * 燕三条TV（@TsubameSanjoTV）チャンネルの動画を、掲載店舗
 * （src/content/spots/）と決定論的に照合し、frontmatterの youtubeVideos に
 * 自動で紐付けるスクリプト。generate-spot.ts / generate-news.ts と同じ思想
 * （決定論的処理を優先し、LLMに事実判断をさせない）で実装しており、
 * このスクリプトはLLMを一切呼び出さない（文字列正規化・照合のみ）。
 *
 * 処理:
 *   1. YouTube Data API v3 でチャンネルの全動画（videoId/title/publishedAt）を
 *      ページネーション対応で取得
 *   2. 店名とタイトルを正規化して照合
 *      - 店名がタイトルに完全に含まれる場合のみ「確信度: 高」→ 自動採用
 *      - それ以外の部分一致は「確信度: 中/低」→ matched-candidates.json に
 *        出力するのみで自動採用しない（誤って別の店の動画を紐付けるのを
 *        避けるため。少しでも曖昧なら採用しない）
 *      - 同じ動画が複数の店舗名に「完全一致」した場合は曖昧とみなし、
 *        全て確信度「中」に格下げする（自動採用しない）
 *      - "bar"/"cafe"/"居酒屋"等の一般名詞はGENRE_STOPWORDSとして
 *        中/低判定の類似度計算から除外する（店名との偶然一致がノイズ候補に
 *        なるのを防ぐため）
 *   3. 確信度「高」のみ各店舗のfrontmatterに追記する。既存の動画ID・labelは
 *      一切変更しない（追記のみ・上書きなし）。自動マッチではlabelを設定しない。
 *   4. どの店舗名とも一致しなかった動画（未記事化店舗の可能性）を、
 *      タイトルから機械的に判定したarea・store（正規表現で抽出できた場合のみ。
 *      抽出できない・形式が違う場合はnullのままとし、推測はしない）とともに
 *      unmatched-videos.json に一覧出力する。storeで拾えない分は人が
 *      直接ファイルを編集してstoreManualに書き込める。再実行のたびに
 *      ファイル全体を再生成するが、既存のstoreManualは必ず引き継ぐ（上書きしない）。
 *
 * 使い方:
 *   npm run match:youtube               # 実行して書き込む
 *   npm run match:youtube -- --dry-run  # 書き込まずに結果だけ確認する
 *
 * 事前準備:
 *   .env に YOUTUBE_API_KEY を設定してください（.env.example 参照。ローカルでは
 *   .env、GitHub Actionsでは Secrets の YOUTUBE_API_KEY を参照します）。
 *   Google Cloud ConsoleでYouTube Data API v3を有効化し、APIキーを発行してください。
 */

import 'dotenv/config';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { toYamlString } from './lib/gemini-agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOTS_DIR = path.resolve(__dirname, '../src/content/spots');
const CANDIDATES_PATH = path.resolve(__dirname, '../matched-candidates.json');
const UNMATCHED_PATH = path.resolve(__dirname, '../unmatched-videos.json');

// 燕三条TV（@TsubameSanjoTV）のチャンネルID。疎通確認済み。
// ハンドルからの都度解決（channels.list?forHandle=...）はAPI呼び出しを
// 1回増やすだけなので、既知のIDを定数として持たせて省略する。
const CHANNEL_ID = 'UCPkS_OOnZlB9NXCQNndNEaA';
const CHANNEL_HANDLE = '@TsubameSanjoTV';
// 標準的なYouTubeチャンネルでは、「アップロード動画」プレイリストIDは
// チャンネルIDの先頭 "UC" を "UU" に置き換えたものと一致する（YouTube側の
// 既知の命名規則）。これによりchannels.list呼び出し自体も省略できる。
const UPLOADS_PLAYLIST_ID = CHANNEL_ID.replace(/^UC/, 'UU');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

interface ChannelVideo {
  videoId: string;
  title: string;
  publishedAt: string;
}

interface MatchCandidate {
  spotSlug: string;
  spotTitle: string;
  videoId: string;
  videoTitle: string;
  publishedAt: string;
  confidence: 'medium' | 'low';
  reason: string;
}

type Area = 'honjikoji' | 'sanjo' | 'tsubame' | 'unknown';

interface UnmatchedVideo extends ChannelVideo {
  area: Area;
  // 正規表現で機械的に抽出した店名。形式に合致しなければnull（推測しない）。
  store: string | null;
  // 人がunmatched-videos.jsonを直接編集して書き込む店名。再実行のたびに
  // このファイルは再生成されるが、既存のstoreManualは必ず引き継ぐ（上書きしない）。
  storeManual: string | null;
  // 表示用に解決済みの店名（storeManualがあればそちらを優先、無ければstore）。
  storeDisplay: string | null;
}

// ============================================================
// 未マッチ動画タイトルからの機械的な分類・抽出
// （すべて正規表現による決定論的処理のみ。推測は一切行わない）
// ============================================================

/** タイトル文字列中の地名からエリアを判定する。優先順位はhonjikoji > sanjo > tsubame。 */
export function classifyArea(title: string): Area {
  if (title.includes('本寺小路')) return 'honjikoji';
  if (title.includes('新潟県三条市')) return 'sanjo';
  if (title.includes('新潟県燕市')) return 'tsubame';
  return 'unknown';
}

// 「【燕三条TV】<店名>（<補足>）｜<地名>」形式（補足は任意）にのみマッチする。
// 店名部分に「｜」「（」が含まれるケースは考慮しない＝この形式に該当しないと
// 判断してnullを返す（推測で店名を切り出さない）。
const TITLE_STORE_PATTERN = /^【燕三条TV】(.+?)(?:（[^）]*）)?｜.+$/;

/** タイトルが規則的な形式に一致する場合のみ店名部分を抽出する。一致しなければnull。 */
export function extractStoreName(title: string): string | null {
  const match = title.match(TITLE_STORE_PATTERN);
  if (!match) return null;
  const store = match[1].trim();
  return store.length > 0 ? store : null;
}

/**
 * 既存の unmatched-videos.json から、人が手で書き込んだ storeManual を
 * videoId をキーに読み込む。ファイルが無い（初回実行）・壊れている場合は
 * 空のMapを返す（このスクリプト自身がstoreManualを書くことは無いので、
 * 読み取りに失敗しても書き込み処理には何の影響も無い）。
 */
export async function loadExistingStoreManual(filePath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return map;
  }
  try {
    const data = JSON.parse(raw) as { videos?: Array<{ videoId?: unknown; storeManual?: unknown }> };
    for (const v of data.videos ?? []) {
      if (typeof v.videoId === 'string' && typeof v.storeManual === 'string' && v.storeManual.trim()) {
        map.set(v.videoId, v.storeManual.trim());
      }
    }
  } catch (err) {
    console.warn(
      `[match-youtube] 既存の ${path.basename(filePath)} の解析に失敗したため、storeManualの引き継ぎをスキップします。`,
      err
    );
  }
  return map;
}

// ============================================================
// YouTube Data API v3
// ============================================================

async function fetchAllChannelVideos(apiKey: string): Promise<ChannelVideo[]> {
  const videos: ChannelVideo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('playlistId', UPLOADS_PLAYLIST_ID);
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('key', apiKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `YouTube Data API呼び出しに失敗しました（HTTP ${res.status}）。APIキーやAPIの有効化状況をご確認ください。\n${body}`
      );
    }
    const json = (await res.json()) as {
      items?: Array<{
        snippet?: {
          title?: string;
          publishedAt?: string;
          resourceId?: { videoId?: string };
        };
      }>;
      nextPageToken?: string;
    };

    for (const item of json.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      const publishedAt = item.snippet?.publishedAt;
      if (videoId && title && publishedAt) {
        videos.push({ videoId, title, publishedAt });
      }
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  return videos;
}

// ============================================================
// 店名・タイトルの正規化と照合（誤爆回避を最優先した保守的な実装）
// ============================================================

export function katakanaToHiragana(input: string): string {
  return input.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

const CORPORATE_SUFFIXES = /(株式会社|有限会社|合同会社|㈱|㈲|\(株\)|\(有\))/g;

/**
 * 店名・動画タイトル比較用の正規化。
 *   - 全角/半角の統一（NFKC）
 *   - カタカナ→ひらがな統一
 *   - 空白除去（全角スペース含む）
 *   - 法人格の除去
 *   - 小文字化
 * 長音記号(ー)・中黒(・)・ハイフン等は店名を区別する情報になりうるため、
 * 誤爆回避を優先してあえて除去しない（正規化は保守的に留める）。
 */
export function normalizeStoreName(input: string): string {
  let s = input.normalize('NFKC');
  s = katakanaToHiragana(s);
  s = s.replace(/\s+/g, '');
  s = s.replace(CORPORATE_SUFFIXES, '');
  s = s.toLowerCase();
  return s;
}

// 正規化後の店名がこの文字数未満の場合は、完全一致でも自動採用しない
// （短い文字列は無関係なタイトルにも偶然含まれやすく誤爆リスクが高いため）。
const MIN_NAME_LENGTH_FOR_HIGH_CONFIDENCE = 3;
// 「中」「低」候補として報告する最低類似度（連続一致文字数 / 店名の文字数）。
// "bar"のような一般名詞3文字だけの一致がノイズ候補として大量に出ないよう、
// ストップワード除去とあわせて閾値も引き上げている。
const MEDIUM_CONFIDENCE_RATIO = 0.65;
const LOW_CONFIDENCE_RATIO = 0.4;

// ジャンル・業態を表す一般名詞。単独では店名の識別に使えず、"Bar Keywest"の
// "bar"のように無関係な動画タイトルとの偶然の一致を大量に生むため、
// low/medium判定の類似度計算からは除外する（high判定＝店名の完全一致には
// 影響させない。"BAR"単体という店名は現実的に無いため、完全一致の強い
// シグナルまで弱める必要はない）。
const GENRE_STOPWORDS = [
  'bar',
  'cafe',
  'café',
  'bistro',
  'dining',
  'kitchen',
  'grill',
  'restaurant',
  'shop',
  'store',
  '居酒屋',
  'すなっく',
  '焼肉',
  'やきにく',
  'らーめん',
  'おでん',
  '立ち飲み',
  'たちのみ',
  '立ち呑み',
  'たちのみ',
  '小料理屋',
  'こりょうりや',
  '割烹',
  'かっぽう',
  '焼き鳥',
  'やきとり',
  '焼鳥',
  '食堂',
  'しょくどう',
  '酒場',
  'さかば',
  '三条市',
  '三条',
  '燕三条',
  '本寺小路',
  '本町',
].map((w) => normalizeStoreName(w));

/** 類似度計算の前処理として、正規化済み文字列から一般名詞を取り除く。 */
function stripGenreStopwords(normalized: string): string {
  let s = normalized;
  for (const stopword of GENRE_STOPWORDS) {
    if (stopword) s = s.split(stopword).join('');
  }
  return s;
}

/** 2文字列間の最長共通「連続」部分文字列の長さ（部分一致推定用）。 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const dp = new Array(b.length + 1).fill(0);
  let max = 0;
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      if (dp[j] > max) max = dp[j];
      prev = temp;
    }
  }
  return max;
}

type MatchTier = 'high' | 'medium' | 'low' | null;

export function classifyMatch(storeTitle: string, videoTitle: string): { tier: MatchTier; reason: string } {
  const normStore = normalizeStoreName(storeTitle);
  const normVideo = normalizeStoreName(videoTitle);
  if (!normStore) return { tier: null, reason: '' };

  if (normVideo.includes(normStore)) {
    if (normStore.length < MIN_NAME_LENGTH_FOR_HIGH_CONFIDENCE) {
      return {
        tier: 'medium',
        reason: `店名がタイトルに完全に含まれるが、正規化後の店名が${MIN_NAME_LENGTH_FOR_HIGH_CONFIDENCE}文字未満のため誤爆リスクがあり要確認`,
      };
    }
    return { tier: 'high', reason: '店名がタイトルに完全に含まれる' };
  }

  // low/medium判定は一般名詞（bar/cafe/居酒屋 等）を除いた上で類似度を測る。
  // "Bar Keywest"の"bar"だけが一致してノイズ候補になるのを防ぐため。
  // high判定（完全一致）は上ですでに終えているので影響しない。
  const strippedStore = stripGenreStopwords(normStore);
  const strippedVideo = stripGenreStopwords(normVideo);
  if (strippedStore.length < 2) return { tier: null, reason: '' };

  const lcs = longestCommonSubstringLength(strippedStore, strippedVideo);
  const ratio = strippedStore.length > 0 ? lcs / strippedStore.length : 0;
  if (ratio >= MEDIUM_CONFIDENCE_RATIO) {
    return {
      tier: 'medium',
      reason: `店名の一部（連続${lcs}文字、店名の${Math.round(ratio * 100)}%）がタイトルに含まれる`,
    };
  }
  if (ratio >= LOW_CONFIDENCE_RATIO) {
    return {
      tier: 'low',
      reason: `店名のごく一部（連続${lcs}文字、店名の${Math.round(ratio * 100)}%）がタイトルに含まれる可能性`,
    };
  }
  return { tier: null, reason: '' };
}

// ============================================================
// frontmatterの読み込み・追記
// （既存内容を壊さない、テキスト単位でのライン挿入。フルパース→再ダンプは
//   コメントや書式を壊すため行わない）
// ============================================================

interface SpotFile {
  filePath: string;
  slug: string;
  raw: string;
  frontmatterText: string;
  title: string;
  existingVideoIds: Set<string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

async function loadSpotFiles(): Promise<SpotFile[]> {
  const files = (await readdir(SPOTS_DIR)).filter((f) => f.endsWith('.md'));
  const spots: SpotFile[] = [];

  for (const file of files) {
    const filePath = path.join(SPOTS_DIR, file);
    const raw = await readFile(filePath, 'utf-8');
    const match = raw.match(FRONTMATTER_RE);
    if (!match) {
      console.warn(`[match-youtube] ${file}: frontmatterが見つからないためスキップします。`);
      continue;
    }
    const frontmatterText = match[1];

    let data: { title?: unknown; youtubeVideos?: Array<{ id?: unknown }> };
    try {
      data = (parseYaml(frontmatterText) as typeof data) ?? {};
    } catch (err) {
      console.warn(`[match-youtube] ${file}: frontmatterのYAML解析に失敗したためスキップします。`, err);
      continue;
    }

    const title = typeof data.title === 'string' ? data.title : '';
    if (!title) {
      console.warn(`[match-youtube] ${file}: title が読み取れないためスキップします。`);
      continue;
    }

    const existingVideoIds = new Set(
      (data.youtubeVideos ?? [])
        .map((v) => (typeof v?.id === 'string' ? v.id : undefined))
        .filter((id): id is string => !!id)
    );

    spots.push({ filePath, slug: file.replace(/\.md$/, ''), raw, frontmatterText, title, existingVideoIds });
  }

  return spots;
}

/**
 * frontmatter内に新しいyoutubeVideosエントリ（label無し・idのみ）を追記する。
 * 既存のyoutubeVideos配列・他フィールド・コメント等の既存テキストは一切
 * 書き換えず、行として挿入するだけに留める（既存labelの保持もこれで自動的に
 * 満たされる。既存IDは呼び出し側で除外済みのため重複追加もしない）。
 */
export function appendYoutubeVideoIds(raw: string, frontmatterText: string, newIds: string[]): string {
  if (newIds.length === 0) return raw;

  const newLines = newIds.map((id) => `  - id: ${toYamlString(id)}`);
  const lines = frontmatterText.split('\n');
  const keyIndex = lines.findIndex((line) => /^youtubeVideos:\s*$/.test(line));

  let newFmLines: string[];
  if (keyIndex !== -1) {
    // 既存のyoutubeVideos:ブロックの末尾（次のトップレベルkey、または
    // frontmatter末尾）を探し、その直前に新しいエントリを挿入する。
    let endIndex = lines.length;
    for (let i = keyIndex + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) {
        endIndex = i;
        break;
      }
    }
    newFmLines = [...lines.slice(0, endIndex), ...newLines, ...lines.slice(endIndex)];
  } else {
    // youtubeVideos: 自体が無い場合は新設する。description: の直前に置くと
    // src/content.config.ts のフィールド定義順に近くなるため優先し、
    // 無ければ末尾に追加する。
    const descIndex = lines.findIndex((line) => /^description:/.test(line));
    const insertion = ['youtubeVideos:', ...newLines];
    newFmLines =
      descIndex !== -1
        ? [...lines.slice(0, descIndex), ...insertion, ...lines.slice(descIndex)]
        : [...lines, ...insertion];
  }

  return raw.replace(FRONTMATTER_RE, `---\n${newFmLines.join('\n')}\n---\n`);
}

// ============================================================
// メイン処理
// ============================================================

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error(
      '[match-youtube] YOUTUBE_API_KEY が設定されていません。.env に YOUTUBE_API_KEY=... を追加してください（.env.example 参照）。'
    );
    process.exit(1);
  }

  console.log('============================================================');
  console.log(' 燕三条TV 動画自動マッチング（決定論的処理のみ・LLM不使用）');
  console.log(` チャンネル: ${CHANNEL_HANDLE} (${CHANNEL_ID})${dryRun ? '  [--dry-run]' : ''}`);
  console.log('============================================================');

  const videos = await fetchAllChannelVideos(apiKey);
  console.log(`[match-youtube] チャンネル動画: ${videos.length}件取得しました。`);

  const spots = await loadSpotFiles();
  console.log(`[match-youtube] 店舗記事: ${spots.length}件読み込みました。`);

  // Pass 1: 全(店舗, 動画)ペアを分類（登録済みIDはそもそも対象外）。
  interface RawMatch {
    spot: SpotFile;
    video: ChannelVideo;
    tier: 'high' | 'medium' | 'low';
    reason: string;
  }
  const rawMatches: RawMatch[] = [];

  for (const spot of spots) {
    for (const video of videos) {
      if (spot.existingVideoIds.has(video.videoId)) continue;
      const { tier, reason } = classifyMatch(spot.title, video.title);
      if (tier) rawMatches.push({ spot, video, tier, reason });
    }
  }

  // Pass 2: 同じ動画が複数の異なる店舗名に「完全一致」した場合は曖昧なので、
  // 全て"medium"に格下げする（誤って別の店の動画を紐付けるのが最悪の失敗）。
  const highSpotsByVideoId = new Map<string, Set<string>>();
  for (const m of rawMatches) {
    if (m.tier !== 'high') continue;
    if (!highSpotsByVideoId.has(m.video.videoId)) highSpotsByVideoId.set(m.video.videoId, new Set());
    highSpotsByVideoId.get(m.video.videoId)!.add(m.spot.title);
  }
  for (const m of rawMatches) {
    const sameVideoStores = highSpotsByVideoId.get(m.video.videoId);
    if (m.tier === 'high' && sameVideoStores && sameVideoStores.size > 1) {
      m.tier = 'medium';
      m.reason = `複数の店舗名（${[...sameVideoStores].join(' / ')}）に完全一致したため要確認`;
    }
  }

  // Pass 3: 自動採用（high）とレポート（medium/low）に振り分け。
  const candidates: MatchCandidate[] = [];
  const spotUpdates = new Map<string, string[]>();

  for (const m of rawMatches) {
    if (m.tier === 'high') {
      const list = spotUpdates.get(m.spot.slug) ?? [];
      if (!list.includes(m.video.videoId)) list.push(m.video.videoId);
      spotUpdates.set(m.spot.slug, list);
    } else {
      candidates.push({
        spotSlug: m.spot.slug,
        spotTitle: m.spot.title,
        videoId: m.video.videoId,
        videoTitle: m.video.title,
        publishedAt: m.video.publishedAt,
        confidence: m.tier,
        reason: m.reason,
      });
    }
  }

  let autoAdopted = 0;
  for (const spot of spots) {
    const newIds = spotUpdates.get(spot.slug);
    if (!newIds || newIds.length === 0) continue;

    console.log(`[match-youtube] 自動採用: 「${spot.title}」に${newIds.length}件追加 -> ${newIds.join(', ')}`);
    autoAdopted += newIds.length;

    if (!dryRun) {
      const updated = appendYoutubeVideoIds(spot.raw, spot.frontmatterText, newIds);
      await writeFile(spot.filePath, updated, 'utf-8');
    }
  }

  if (candidates.length > 0) {
    console.log(`[match-youtube] 要確認候補: ${candidates.length}件`);
    for (const c of candidates) {
      console.log(
        `  - [${c.confidence}] 「${c.spotTitle}」<- 「${c.videoTitle}」(${c.videoId}) : ${c.reason}`
      );
    }
    if (!dryRun) {
      await writeFile(
        CANDIDATES_PATH,
        JSON.stringify(
          { generatedAt: new Date().toISOString(), channel: CHANNEL_HANDLE, candidates },
          null,
          2
        ) + '\n',
        'utf-8'
      );
      console.log(`[match-youtube] -> ${path.relative(process.cwd(), CANDIDATES_PATH)} に書き出しました。`);
    }
  }

  const matchedVideoIds = new Set<string>([
    ...rawMatches.map((m) => m.video.videoId),
    ...spots.flatMap((s) => [...s.existingVideoIds]),
  ]);
  // 未マッチ動画（どの店舗名とも一切一致しなかったもの）は、燕三条TVで
  // 取材済みだが未記事化の店舗の可能性が高い。generate-spot.ts の
  // リサーチ材料・記事化候補として使えるよう、タイトルから機械的に判定した
  // エリア・店名を付与して一覧を書き出す（いずれも正規表現のみで判定し、
  // 該当しない場合は unknown / null とし、推測は行わない）。
  // storeの自動抽出は形式が合致する場合のみに限定しており（作り込まない
  // 方針）、抽出できない分は人がstoreManualを直接書き込んで補う運用とする。
  // 既存のstoreManualは再実行のたびに必ず引き継ぎ、絶対に上書きしない。
  const existingStoreManual = await loadExistingStoreManual(UNMATCHED_PATH);
  const unmatchedVideos: UnmatchedVideo[] = videos
    .filter((v) => !matchedVideoIds.has(v.videoId))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .map((v) => {
      const store = extractStoreName(v.title);
      const storeManual = existingStoreManual.get(v.videoId) ?? null;
      return { ...v, area: classifyArea(v.title), store, storeManual, storeDisplay: storeManual ?? store };
    });

  // 並び順: honjikoji -> sanjo -> その他(tsubame/unknown)。各グループ内は
  // 公開日時の昇順（上のsortの結果）を保つ安定ソート。
  const AREA_ORDER: Record<Area, number> = { honjikoji: 0, sanjo: 1, tsubame: 2, unknown: 2 };
  unmatchedVideos.sort((a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area]);

  const areaCounts: Record<Area, number> = { honjikoji: 0, sanjo: 0, tsubame: 0, unknown: 0 };
  for (const v of unmatchedVideos) areaCounts[v.area] += 1;

  if (unmatchedVideos.length > 0 && !dryRun) {
    await writeFile(
      UNMATCHED_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          channel: CHANNEL_HANDLE,
          note: '燕三条TVで取材済みだが、店舗名と一致しなかった動画（未記事化の可能性がある店舗を含む）。area/storeはタイトルからの機械的な正規表現判定で、推測は行っていない。storeがnullの場合は、このファイルを直接編集してstoreManualに店名を書き込んでよい（再実行時も上書きされない）。storeDisplayはstoreManual優先の表示用フィールド。',
          videos: unmatchedVideos,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    console.log(`[match-youtube] -> ${path.relative(process.cwd(), UNMATCHED_PATH)} に書き出しました。`);
  }
  if (unmatchedVideos.length > 0) {
    console.log(
      `[match-youtube] 未マッチ動画のエリア内訳: 本寺小路${areaCounts.honjikoji}件 / 三条${areaCounts.sanjo}件 / 燕${areaCounts.tsubame}件 / 不明${areaCounts.unknown}件`
    );
  }

  console.log('============================================================');
  console.log(
    ` サマリ: 自動採用${autoAdopted}件 / 要確認${candidates.length}件 / 未マッチ${unmatchedVideos.length}件`
  );
  if (dryRun) console.log(' [--dry-run] ファイルへの書き込みは行っていません。');
  console.log('============================================================');
}

// このファイルが（テスト等から）importされただけの場合はmain()を自動実行しない。
// CLIとして直接実行された（tsx scripts/match-youtube.ts / npm run match:youtube）
// 場合のみ動く。
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('[match-youtube] エラーが発生しました:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
