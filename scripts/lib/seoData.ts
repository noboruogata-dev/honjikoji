/**
 * scripts/lib/seoData.ts
 *
 * seo-report.ts（⑤分析）と seo-rewrite.ts（⑥リライト）が共通で使う、
 * 記事の読み込みと Search Console からの候補取得。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { getAccessToken, parseServiceAccountKey, querySearchAnalytics } from './searchConsole.js';
import { selectCandidates, type ArticleInfo, type Collection, type SeoCandidates } from './seoCandidates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = path.resolve(__dirname, '../../src/content');
const COLLECTIONS: Collection[] = ['spots', 'columns', 'news'];

/** Search Console の確定データは2〜3日遅れるため、終了日は3日前にする。 */
const DATA_LAG_DAYS = 3;

export interface LoadedArticle extends ArticleInfo {
  filePath: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  seoTitle?: string;
}

export function splitFrontmatter(raw: string): { frontmatterText: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  return { frontmatterText: match[1], body: match[2] };
}

export async function loadArticles(): Promise<LoadedArticle[]> {
  const articles: LoadedArticle[] = [];
  for (const collection of COLLECTIONS) {
    const dir = path.join(CONTENT_DIR, collection);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = await readFile(filePath, 'utf-8');
      const parts = splitFrontmatter(raw);
      if (!parts) continue;
      let fm: Record<string, unknown>;
      try {
        const data = parseYaml(parts.frontmatterText);
        if (typeof data !== 'object' || data === null) continue;
        fm = data as Record<string, unknown>;
      } catch {
        continue;
      }
      const slug = file.replace(/\.md$/, '');
      articles.push({
        collection,
        slug,
        title: typeof fm.title === 'string' ? fm.title : slug,
        description:
          typeof fm.description === 'string' ? fm.description : typeof fm.summary === 'string' ? fm.summary : '',
        body: parts.body,
        seoTitle: typeof fm.seoTitle === 'string' ? fm.seoTitle : undefined,
        filePath,
        raw,
        frontmatter: fm,
      });
    }
  }
  return articles;
}

function isoDateDaysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface FetchedCandidates {
  siteUrl: string;
  startDate: string;
  endDate: string;
  candidates: SeoCandidates;
  articles: LoadedArticle[];
}

/** 環境変数 GSC_SERVICE_ACCOUNT_JSON / GSC_SITE_URL を使って候補を取得する。 */
export async function fetchCandidates(days: number): Promise<FetchedCandidates> {
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) throw new Error('GSC_SITE_URL が設定されていません（例: sc-domain:honjikoji.jp）。');
  const key = parseServiceAccountKey(process.env.GSC_SERVICE_ACCOUNT_JSON);

  const endDate = isoDateDaysAgo(DATA_LAG_DAYS);
  const startDate = isoDateDaysAgo(DATA_LAG_DAYS + days - 1);
  console.log(`[seo] 対象期間: ${startDate} 〜 ${endDate}（${siteUrl}）`);

  const token = await getAccessToken(key);
  const [pageRaw, pageQueryRaw] = await Promise.all([
    querySearchAnalytics(token, siteUrl, { startDate, endDate, dimensions: ['page'] }),
    querySearchAnalytics(token, siteUrl, { startDate, endDate, dimensions: ['page', 'query'] }),
  ]);
  console.log(`[seo] 取得: ページ ${pageRaw.length}行 / ページ×クエリ ${pageQueryRaw.length}行`);

  const pageRows = pageRaw.map((r) => ({
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
  const pageQueryRows = pageQueryRaw.map((r) => ({
    page: r.keys[0],
    query: r.keys[1],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));

  const articles = await loadArticles();
  const candidates = selectCandidates(pageRows, pageQueryRows, articles);
  return { siteUrl, startDate, endDate, candidates, articles };
}
