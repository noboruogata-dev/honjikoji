import { z } from 'zod';
import { analyzeArticleStructure, checkArticleStructure } from './gemini-agents.js';

export const COLUMN_CATEGORIES = ['お酒の豆知識', '街の歴史', '店と人', '夜の作法'] as const;
export const COLUMN_KINDS = ['standard', 'history', 'interview', 'fiction'] as const;
export const CLAIM_STATUSES = ['verified', 'single-source', 'oral-tradition', 'unverified'] as const;
export const SOURCE_TYPES = ['official', 'primary', 'secondary', 'provided'] as const;

export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const claimSchema = z.object({
  id: z.string().regex(/^claim-[1-9]\d*$/, 'claim id は claim-1 形式にしてください'),
  statement: z.string().min(1),
  status: z.enum(CLAIM_STATUSES),
  sourceTitle: z.string().default(''),
  sourceUrl: z.union([z.literal(''), z.url()]).default(''),
  sourceType: z.enum(SOURCE_TYPES).optional(),
});

export const columnResearchSchema = z.object({
  notFound: z.boolean(),
  topic: z.string(),
  slug: z.string(),
  angle: z.string(),
  claims: z.array(claimSchema),
});

export const columnWriterSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().min(1),
  usedClaimIds: z.array(z.string()),
  disclaimer: z.string().default(''),
});

export const columnFrontmatterSchema = z.object({
  title: z.string().min(1),
  pubDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(COLUMN_CATEGORIES),
  summary: z.string().min(1),
  kind: z.enum(COLUMN_KINDS),
  draft: z.boolean(),
  sources: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.url(),
        type: z.enum(SOURCE_TYPES),
      })
    )
    .optional(),
  disclaimer: z.string().min(1).optional(),
  illustration: z.object({ src: z.string().min(1), alt: z.string().min(1) }).optional(),
  eyecatch: z.object({ src: z.string().min(1), alt: z.string().min(1) }).optional(),
  imageStatus: z.enum(['draft', 'qa-passed', 'reviewed']).optional(),
});

export type ColumnResearch = z.infer<typeof columnResearchSchema>;
export type ColumnWriter = z.infer<typeof columnWriterSchema>;
export type ColumnFrontmatter = z.infer<typeof columnFrontmatterSchema>;

export interface ColumnProfile {
  category: ColumnCategory;
  kind: ColumnKind;
  researchFocus: string;
  writerVoice: string;
  /** 「お酒の豆知識」カテゴリのときだけ設定される、循環中のサブテーマ。
   *  ログ表示・Job Summaryでの記録に使う。 */
  subtheme?: SakeSubtheme;
}

export const CATEGORY_ALIASES: Record<string, ColumnCategory> = {
  alcohol: 'お酒の豆知識',
  history: '街の歴史',
  people: '店と人',
  manners: '夜の作法',
};

/** .github/workflows/generate-column.yml の categories 配列（alcohol manners
 *  history people）と同じ長さ。並び順には依存しない（サブテーマの循環は
 *  「お酒の豆知識が回ってくる4週おきのサイクル数」だけを使うため）。
 *  カテゴリの数を変える場合はワークフロー側と合わせてここも見直すこと。 */
const CATEGORY_CYCLE_LENGTH = 4;

export interface SakeSubtheme {
  key: string;
  /** ログ・Job Summary表示用の短い名前。 */
  label: string;
  researchFocus: string;
}

/**
 * 「お酒の豆知識」カテゴリの中で循環させる4つの切り口。新潟の日本酒は
 * 競合の強い領域のため、一般論に流れないよう切り口ごとに調査方針を絞る。
 * 「三条・燕三条周辺の蔵」は該当する蔵が限られ一次情報も乏しい可能性が
 * あるため、他の3つよりnotFoundになりやすい想定（generate-column.ts側で
 * 失敗時にサブテーマ名をJob Summaryへ記録する）。
 */
export const SAKE_SUBTHEMES: SakeSubtheme[] = [
  {
    key: 'niigata-general',
    label: '新潟の酒全般',
    researchFocus:
      '新潟県酒造組合や県公式資料、蔵元自身の公式サイトなど一次情報を優先し、新潟の酒どころとしての気候風土や「淡麗辛口」と呼ばれてきた背景、県内の酒蔵の広がりなど、新潟の日本酒を大きく捉える基礎知識を集める。特定の一つの蔵に深入りしない。',
  },
  {
    key: 'sanjo-breweries',
    label: '三条・燕三条周辺の蔵',
    researchFocus:
      '三条市・燕市・燕三条エリアに実在する酒蔵について、各蔵の公式サイトまたは新潟県酒造組合など一次情報で確認できる範囲の事実だけを集める。創業年・代表銘柄・受賞歴等の具体的な数字・固有名詞は、出典で裏が取れたものに限る。裏が取れなければ収集を諦め、notFoundとする。',
  },
  {
    key: 'how-to-enjoy',
    label: '飲み方・選び方',
    researchFocus:
      '日本酒造組合中央会など公的・一次情報を優先し、燗酒の温度帯、酒器の選び方、料理との合わせ方など、今夜から試せる実用的な知識を集める。特定の店舗・商品を推奨する情報は集めない。',
  },
  {
    key: 'terminology',
    label: '用語・ラベルの読み方',
    researchFocus:
      '国税庁の清酒の製法品質表示基準、酒造組合等の公式情報を優先し、「純米」「吟醸」「精米歩合」などの日本酒用語やラベル表示のルールを、正確に説明できる範囲で集める。',
  },
];

/**
 * 「お酒の豆知識」カテゴリ内で循環させるサブテーマを、日時から決定論的に
 * 選ぶ（状態ファイルは持たない）。カテゴリ自体の週次循環
 * （generate-column.ymlの `$(date -u +%s) / 604800 % 4`）と同じ考え方で、
 * 「お酒の豆知識」が回ってくる4週おきのサイクル数（週番号をCATEGORY_
 * CYCLE_LENGTHで割った商）を、さらにSAKE_SUBTHEMES.lengthで割った余りを使う。
 * Date.getTime()はローカルタイムゾーンに関わらず常にUTC基準のため、
 * bashのdate -u +%sと同じ結果になる（Asia/Tokyo変換は行わない）。
 */
export function resolveSakeSubtheme(now: Date = new Date()): SakeSubtheme {
  const weeksSinceEpoch = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
  const alcoholCycleIndex = Math.floor(weeksSinceEpoch / CATEGORY_CYCLE_LENGTH);
  return SAKE_SUBTHEMES[alcoholCycleIndex % SAKE_SUBTHEMES.length];
}

export function resolveProfile(categoryArg: string, kindArg?: string, now: Date = new Date()): ColumnProfile {
  const category = CATEGORY_ALIASES[categoryArg.toLowerCase()];
  if (!category) {
    throw new Error(`category は ${Object.keys(CATEGORY_ALIASES).join(' / ')} のいずれかを指定してください。`);
  }

  if (category === '街の歴史') {
    if (kindArg && kindArg !== 'history') throw new Error('街の歴史の kind は history 固定です。');
    return {
      category,
      kind: 'history',
      researchFocus:
        '三条市・本寺小路・本町の歴史。行政、図書館、博物館、新聞、郷土資料などを優先し、伝承は「伝承が記録されている根拠」まで確認する。',
      writerVoice: '確認済み事実と伝承の境界を明示し、断定を避けながら街の記憶を丁寧にたどる。',
    };
  }

  if (category === '店と人') {
    const kind = kindArg ?? 'fiction';
    if (kind !== 'fiction' && kind !== 'interview') {
      throw new Error('店と人の kind は fiction または interview を指定してください。');
    }
    return {
      category,
      kind,
      researchFocus:
        kind === 'fiction'
          ? '本寺小路・三条の夜の一般的な街並みや文化的背景。実在店舗・実在人物の逸話は収集しない。'
          : '公開情報による周辺背景の確認。人物・店舗固有の事実は運営者提供の取材資料だけを採用する。',
      writerVoice:
        kind === 'fiction'
          ? '架空の人物と架空の店だけで描く短編。実在の店舗・人物を想起させる固有情報を避ける。'
          : '取材対象の言葉と事実を尊重し、推測で心情・経歴・発言を補わない。',
    };
  }

  if (kindArg && kindArg !== 'standard') {
    throw new Error(`${category} の kind は standard 固定です。`);
  }

  if (category === 'お酒の豆知識') {
    const subtheme = resolveSakeSubtheme(now);
    return {
      category,
      kind: 'standard',
      researchFocus: subtheme.researchFocus,
      writerVoice: '初心者にも分かる言葉で、知識をひけらかさず、今夜試せる楽しみ方へつなげる。',
      subtheme,
    };
  }

  return {
    category,
    kind: 'standard',
    researchFocus: '公的な飲酒情報や一般的な接客・飲食店マナーを優先し、安全で気持ちのよい夜の過ごし方を集める。',
    writerVoice: '説教調を避け、一見客も常連も気持ちよく過ごすための作法を柔らかく提案する。',
  };
}

function sourceIsUsable(claim: ColumnResearch['claims'][number]): boolean {
  if (claim.status === 'unverified') return false;
  if (claim.sourceType === 'provided') return Boolean(claim.sourceTitle);
  if (!claim.sourceTitle || !claim.sourceUrl || !claim.sourceType) return false;
  // 画像・動画・PDFそのものは、文脈や記述内容を確認できる「記事ページ」ではない。
  // 歴史生成で検索結果の画像URLが混入した事例があるため決定論的に拒否する。
  return !/\.(?:avif|gif|jpe?g|png|webp|svg|mp4|webm|pdf)(?:[?#].*)?$/i.test(claim.sourceUrl);
}

export interface QaResult {
  errors: string[];
  warnings: string[];
}

export function validateColumnDraft(
  profile: ColumnProfile,
  research: ColumnResearch,
  writer: ColumnWriter,
  hasProvidedMaterial: boolean
): QaResult {
  const errors: string[] = [];
  const warnings = checkArticleStructure(analyzeArticleStructure(writer.body));
  const claims = new Map(research.claims.map((claim) => [claim.id, claim]));
  const usedIds = new Set(writer.usedClaimIds);

  if (writer.usedClaimIds.length === 0 && profile.kind !== 'fiction') {
    errors.push('事実記事なのに usedClaimIds が空です。');
  }

  for (const id of usedIds) {
    const claim = claims.get(id);
    if (!claim) {
      errors.push(`WriterがResearchに存在しない主張ID「${id}」を使用しています。`);
      continue;
    }
    if (!sourceIsUsable(claim)) {
      errors.push(`主張「${id}」は出典が不十分、または未確認のため本文に使用できません。`);
    }
    if (claim.status === 'oral-tradition' && profile.kind !== 'history') {
      errors.push(`伝承「${id}」は街の歴史記事以外では使用できません。`);
    }
  }

  if (profile.kind === 'history') {
    const usedTradition = [...usedIds].some((id) => claims.get(id)?.status === 'oral-tradition');
    if (usedTradition && !/(諸説|伝承|語り継|記録され)/.test(writer.body)) {
      errors.push('伝承を使用していますが、本文に伝承・諸説であることの明示がありません。');
    }
  }

  if (profile.kind === 'fiction') {
    if (!writer.disclaimer || !writer.body.includes('フィクション')) {
      errors.push('フィクション記事には免責文と本文中の「フィクション」表記が必要です。');
    }
    // 実在地域の説明を含むなら、その背景事実もResearch JSONに結び付いている必要がある。
    if (/(本寺小路|三条市|三条別院|本町)/.test(writer.body) && writer.usedClaimIds.length === 0) {
      errors.push('実在地域を描写するフィクションには、背景事実のusedClaimIdsが1件以上必要です。');
    }
  }

  if (profile.kind === 'interview') {
    if (!hasProvidedMaterial) errors.push('取材記事には --source-file で運営者提供資料が必要です。');
    const usedProvided = [...usedIds].some((id) => claims.get(id)?.sourceType === 'provided');
    if (!usedProvided) errors.push('取材記事は運営者提供資料に基づく主張を1件以上使用する必要があります。');
  }

  if (writer.summary.trim() === writer.body.trim().split(/\n{2,}/)[0]?.replace(/^#+\s*/, '').trim()) {
    warnings.push('summary と本文の書き出しが同一です。');
  }

  return { errors, warnings };
}

export function sourcesForUsedClaims(research: ColumnResearch, usedClaimIds: string[]) {
  const used = new Set(usedClaimIds);
  const unique = new Map<string, { title: string; url: string; type: 'official' | 'primary' | 'secondary' | 'provided' }>();
  for (const claim of research.claims) {
    if (!used.has(claim.id) || !claim.sourceType || !claim.sourceUrl || !claim.sourceTitle) continue;
    const source = { title: claim.sourceTitle, url: claim.sourceUrl, type: claim.sourceType };
    unique.set(`${source.url}|${source.title}`, source);
  }
  return [...unique.values()];
}
