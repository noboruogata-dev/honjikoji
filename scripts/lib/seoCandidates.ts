/**
 * scripts/lib/seoCandidates.ts
 *
 * Search Console の数値から「手を入れる価値のある記事」を選ぶ純粋関数群。
 * API呼び出しやファイル読み込みは持たない（scripts/seo-report.ts 側）。
 *
 * 選定ルール（しきい値は THRESHOLDS にまとめてある。サイトが小さいうちは
 * 低めにしてあり、表示回数が増えてきたら上げる）:
 *
 *   lowCtr     … 平均順位10位以内なのに、順位相応のCTRの半分を下回る記事。
 *                タイトル・description の改善で伸びる余地が大きい。
 *   striking   … 平均順位 8〜20位（1ページ目の下〜2ページ目）の記事。
 *                見出し・本文の補強で1ページ目上位を狙える。
 *   uncovered  … 記事が表示されている検索クエリのうち、タイトル・説明文に
 *                含まれていない語を含むもの。追記すべき論点の手がかり。
 *   gaps       … サイト全体で表示はされているが平均順位20位より下のクエリ。
 *                既存記事では答えきれていない＝新規記事のネタ候補。
 */

export const THRESHOLDS = {
  lowCtrMinImpressions: 50,
  lowCtrMaxPosition: 10,
  /** 順位相応CTRに対して、これを下回る比率なら lowCtr とみなす。 */
  lowCtrRatio: 0.5,
  strikingMinImpressions: 20,
  strikingMinPosition: 8,
  strikingMaxPosition: 20,
  uncoveredMinImpressions: 5,
  uncoveredPerPage: 5,
  gapMinImpressions: 10,
  gapMinPosition: 20,
  gapLimit: 15,
} as const;

/**
 * 順位ごとのおおよそのCTR目安（自然検索・モバイル込みの一般的な水準）。
 * 厳密な値ではなく「明らかに低い」を拾うための物差しとして使う。
 */
const EXPECTED_CTR_BY_POSITION = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];

export function expectedCtr(position: number): number {
  const index = Math.max(0, Math.round(position) - 1);
  return EXPECTED_CTR_BY_POSITION[index] ?? 0.01;
}

export type Collection = 'spots' | 'columns' | 'news';

export interface ArticleInfo {
  collection: Collection;
  slug: string;
  title: string;
  /** spots は description、columns/news は summary。 */
  description: string;
  /** Markdown本文（任意）。あると「本文には書いてあるか」も判定できる。 */
  body?: string;
}

export interface PageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PageQueryRow extends PageRow {
  query: string;
}

export function parseArticlePath(pageUrl: string): { collection: Collection; slug: string } | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(pageUrl).pathname);
  } catch {
    return null;
  }
  const match = pathname.match(/^\/(spots|columns|news)\/([^/]+)\/?$/);
  if (!match) return null;
  return { collection: match[1] as Collection, slug: match[2] };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * term が haystack に含まれるか。完全一致しなくても、2文字以上の断片に
 * 分けてすべて haystack に見つかれば含まれるとみなす（「どっぽ酒采とお食事」
 * のように、店名の語順違い・空白なしで打たれた検索語を誤検知しないため）。
 * 「いま泉」と「今泉」のような表記ゆれは断片が見つからないので未記載になる。
 */
export function containsTerm(haystack: string, term: string): boolean {
  const h = normalize(haystack);
  const t = normalize(term);
  if (t.length === 0 || h.includes(t)) return true;
  const chars = [...t];
  // 先頭から最長一致で貪欲に切っていく。
  let i = 0;
  while (i < chars.length) {
    let matched = 0;
    for (let len = chars.length - i; len >= 2; len--) {
      if (h.includes(chars.slice(i, i + len).join(''))) {
        matched = len;
        break;
      }
    }
    if (matched === 0) return false;
    i += matched;
  }
  return true;
}

function splitTerms(query: string): string[] {
  return query
    .normalize('NFKC')
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** クエリのうち、タイトル・説明文に含まれていない語を返す（空白区切り）。 */
export function missingTerms(query: string, article: Pick<ArticleInfo, 'title' | 'description'>): string[] {
  const haystack = `${article.title}${article.description}`;
  return splitTerms(query).filter((term) => !containsTerm(haystack, term));
}

/** タイトル・説明文・本文のどこにも含まれていない語を返す。 */
export function missingTermsInBody(query: string, article: Pick<ArticleInfo, 'title' | 'description' | 'body'>): string[] {
  const haystack = `${article.title}${article.description}${article.body ?? ''}`;
  return splitTerms(query).filter((term) => !containsTerm(haystack, term));
}

export interface PageCandidate extends PageRow {
  article: ArticleInfo;
  expectedCtr?: number;
}

export interface UncoveredCandidate {
  article: ArticleInfo;
  page: string;
  /**
   * missing … タイトル・説明文に無い語（検索結果の見出し・説明に出ない）
   * missingInBody … 本文にも無い語（記事に情報そのものが無い）
   */
  queries: Array<PageQueryRow & { missing: string[]; missingInBody: string[] }>;
}

export interface SeoCandidates {
  totals: { clicks: number; impressions: number; articlePages: number; otherPages: number };
  lowCtr: PageCandidate[];
  striking: PageCandidate[];
  uncovered: UncoveredCandidate[];
  gaps: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  /** 記事ページごとの上位クエリ（表示回数順・最大10件）。キーは "collection/slug"。 */
  topQueries: Record<string, PageQueryRow[]>;
}

export function selectCandidates(
  pageRows: PageRow[],
  pageQueryRows: PageQueryRow[],
  articles: ArticleInfo[]
): SeoCandidates {
  const articleByKey = new Map(articles.map((a) => [`${a.collection}/${a.slug}`, a]));
  const findArticle = (page: string): ArticleInfo | undefined => {
    const parsed = parseArticlePath(page);
    return parsed ? articleByKey.get(`${parsed.collection}/${parsed.slug}`) : undefined;
  };

  const articlePages: PageCandidate[] = [];
  let otherPages = 0;
  for (const row of pageRows) {
    const article = findArticle(row.page);
    if (article) articlePages.push({ ...row, article });
    else otherPages += 1;
  }

  const lowCtr = articlePages
    .filter(
      (p) =>
        p.impressions >= THRESHOLDS.lowCtrMinImpressions &&
        p.position <= THRESHOLDS.lowCtrMaxPosition &&
        p.ctr < expectedCtr(p.position) * THRESHOLDS.lowCtrRatio
    )
    .map((p) => ({ ...p, expectedCtr: expectedCtr(p.position) }))
    .sort((a, b) => b.impressions - a.impressions);

  const striking = articlePages
    .filter(
      (p) =>
        p.impressions >= THRESHOLDS.strikingMinImpressions &&
        p.position >= THRESHOLDS.strikingMinPosition &&
        p.position <= THRESHOLDS.strikingMaxPosition
    )
    .sort((a, b) => b.impressions - a.impressions);

  const uncoveredByPage = new Map<string, UncoveredCandidate>();
  for (const row of pageQueryRows) {
    if (row.impressions < THRESHOLDS.uncoveredMinImpressions) continue;
    const article = findArticle(row.page);
    if (!article) continue;
    const missing = missingTerms(row.query, article);
    if (missing.length === 0) continue;
    const entry = uncoveredByPage.get(row.page) ?? { article, page: row.page, queries: [] };
    entry.queries.push({ ...row, missing, missingInBody: missingTermsInBody(row.query, article) });
    uncoveredByPage.set(row.page, entry);
  }
  const uncovered = [...uncoveredByPage.values()]
    .map((entry) => ({
      ...entry,
      queries: entry.queries.sort((a, b) => b.impressions - a.impressions).slice(0, THRESHOLDS.uncoveredPerPage),
    }))
    .sort(
      (a, b) =>
        b.queries.reduce((sum, q) => sum + q.impressions, 0) - a.queries.reduce((sum, q) => sum + q.impressions, 0)
    );

  // クエリ単位で全ページを合算し、サイト全体として弱いクエリを拾う。
  const byQuery = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>();
  for (const row of pageQueryRows) {
    const agg = byQuery.get(row.query) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
    agg.clicks += row.clicks;
    agg.impressions += row.impressions;
    agg.weightedPosition += row.position * row.impressions;
    byQuery.set(row.query, agg);
  }
  const gaps = [...byQuery.entries()]
    .map(([query, agg]) => ({
      query,
      clicks: agg.clicks,
      impressions: agg.impressions,
      position: agg.impressions > 0 ? agg.weightedPosition / agg.impressions : 0,
    }))
    .filter((q) => q.impressions >= THRESHOLDS.gapMinImpressions && q.position > THRESHOLDS.gapMinPosition)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, THRESHOLDS.gapLimit);

  const topQueries: Record<string, PageQueryRow[]> = {};
  for (const row of pageQueryRows) {
    const parsed = parseArticlePath(row.page);
    if (!parsed) continue;
    const key = `${parsed.collection}/${parsed.slug}`;
    (topQueries[key] ??= []).push(row);
  }
  for (const key of Object.keys(topQueries)) {
    topQueries[key] = topQueries[key].sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  }

  return {
    topQueries,
    totals: {
      clicks: pageRows.reduce((sum, r) => sum + r.clicks, 0),
      impressions: pageRows.reduce((sum, r) => sum + r.impressions, 0),
      articlePages: articlePages.length,
      otherPages,
    },
    lowCtr,
    striking,
    uncovered,
    gaps,
  };
}

// ============================================================
// レポート整形（Job Summary / ログ向けMarkdown）
// ============================================================

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const pos = (value: number) => value.toFixed(1);
const label = (a: ArticleInfo) => `${a.title}（${a.collection}/${a.slug}）`;

export function formatReport(candidates: SeoCandidates, range: { startDate: string; endDate: string }): string {
  const lines: string[] = [];
  const { totals } = candidates;
  lines.push(`## 本寺小路ガイド SEOレポート（${range.startDate} 〜 ${range.endDate}）`);
  lines.push('');
  lines.push(
    `クリック ${totals.clicks} / 表示 ${totals.impressions} / 表示のあった記事 ${totals.articlePages}件（記事以外のページ ${totals.otherPages}件）`
  );
  lines.push('');

  lines.push(`### ① CTRが低い記事（タイトル・説明文の改善候補）: ${candidates.lowCtr.length}件`);
  if (candidates.lowCtr.length === 0) lines.push('該当なし');
  for (const p of candidates.lowCtr) {
    lines.push(
      `- ${label(p.article)} — 表示 ${p.impressions} / CTR ${pct(p.ctr)}（目安 ${pct(p.expectedCtr ?? 0)}）/ 平均 ${pos(p.position)}位`
    );
  }
  lines.push('');

  lines.push(`### ② あと一歩の記事（平均${THRESHOLDS.strikingMinPosition}〜${THRESHOLDS.strikingMaxPosition}位・本文補強候補）: ${candidates.striking.length}件`);
  if (candidates.striking.length === 0) lines.push('該当なし');
  for (const p of candidates.striking) {
    lines.push(`- ${label(p.article)} — 表示 ${p.impressions} / クリック ${p.clicks} / 平均 ${pos(p.position)}位`);
  }
  lines.push('');

  lines.push(`### ③ 記事が拾えていないクエリ（追記候補）: ${candidates.uncovered.length}記事`);
  if (candidates.uncovered.length === 0) lines.push('該当なし');
  for (const entry of candidates.uncovered) {
    lines.push(`- ${label(entry.article)}`);
    for (const q of entry.queries) {
      const inBody = q.missing.filter((t) => !q.missingInBody.includes(t));
      const notes = [
        q.missingInBody.length > 0 ? `記事に無い: ${q.missingInBody.join('、')}` : '',
        inBody.length > 0 ? `本文にはあるが説明文に無い: ${inBody.join('、')}` : '',
      ].filter(Boolean);
      lines.push(`  - 「${q.query}」表示 ${q.impressions} / 平均 ${pos(q.position)}位 — ${notes.join(' / ')}`);
    }
  }
  lines.push('');

  lines.push(`### ④ サイト全体で弱いクエリ（新規記事のネタ候補・平均${THRESHOLDS.gapMinPosition}位より下）: ${candidates.gaps.length}件`);
  if (candidates.gaps.length === 0) lines.push('該当なし');
  for (const q of candidates.gaps) {
    lines.push(`- 「${q.query}」表示 ${q.impressions} / 平均 ${pos(q.position)}位`);
  }

  return lines.join('\n');
}
