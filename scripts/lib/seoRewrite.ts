/**
 * scripts/lib/seoRewrite.ts
 *
 * SEO自動運転の「⑥リライト」の非LLM部分: 対象記事の選定、Geminiへの
 * プロンプト構築、提案の決定論的な検証、Markdownファイルへの反映、
 * PR本文の組み立て。LLM呼び出しは scripts/seo-rewrite.ts 側に置き、
 * ここはGeminiを呼ばずに単体テストできるようにする（sourceVerification.ts
 * と同じ考え方）。
 *
 * 書き換えてよい範囲（ユーザーと合意した方針）:
 *   - 自動で提案してよい: seoTitle（検索結果用タイトル）、description/summary、
 *     店名の表記ゆれの一文（PR上で人が確認する前提）
 *   - 裏付けが取れたときだけ: メニュー・価格（Google Search Groundingの引用が
 *     あるものだけ。取れなければ書かずにPR本文で報告する）
 *   - 書き換えない: title（店名・見出し）、営業時間・住所などの事実情報、本文の既存段落
 */
import { z } from 'zod';
import { containsTerm, type PageQueryRow, type SeoCandidates } from './seoCandidates.js';
import type { LoadedArticle } from './seoData.js';
import { splitFrontmatter } from './seoData.js';

export const REWRITE_LIMITS = {
  /** 1回の実行で書き換える記事の上限（PRを人が確認しきれる量に抑える）。 */
  maxTargets: 3,
  /** 同じ記事を再度リライト対象にするまでの間隔（日）。効果を測る期間を確保する。 */
  cooldownDays: 28,
  seoTitleMin: 10,
  seoTitleMax: 40,
  descriptionMin: 70,
  descriptionMax: 140,
  /** メニュー調査を行う「メニュー」系クエリの最低表示回数。 */
  menuQueryMinImpressions: 5,
  /** 本文中の「〇〇円」がこの数未満なら、メニュー情報が足りないとみなす。 */
  menuPriceMinCount: 3,
  menuItemsMin: 3,
  menuItemsMax: 8,
} as const;

// ============================================================
// 対象記事の選定
// ============================================================

export type RewriteReason = 'lowCtr' | 'striking' | 'uncovered';

export interface RewriteTarget {
  article: LoadedArticle;
  reasons: RewriteReason[];
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  queries: PageQueryRow[];
  /** 表記ゆれ・地名など、タイトル・説明文にも本文にも無い語。 */
  missingTerms: string[];
  needsMenu: boolean;
}

export function countPrices(body: string): number {
  return (body.match(/[0-9０-９][0-9０-９,，]*\s*円/g) ?? []).length;
}

export function needsMenuResearch(article: Pick<LoadedArticle, 'collection' | 'body'>, queries: PageQueryRow[]): boolean {
  if (article.collection !== 'spots') return false;
  const asksMenu = queries.some(
    (q) => /メニュー|値段|料金|価格/.test(q.query) && q.impressions >= REWRITE_LIMITS.menuQueryMinImpressions
  );
  return asksMenu && countPrices(article.body ?? '') < REWRITE_LIMITS.menuPriceMinCount;
}

/** 既にメニュー的な語として扱う（表記ゆれ候補から外す）語。 */
const GENERIC_TERMS = /^(メニュー|値段|料金|価格|営業時間|口コミ|予約|駐車場|ランチ|地図|アクセス|場所|定休日)$/;

export function pickTargets(
  candidates: SeoCandidates,
  articles: LoadedArticle[],
  recentlyRewritten: Set<string>,
  maxTargets: number = REWRITE_LIMITS.maxTargets
): RewriteTarget[] {
  const byKey = new Map<string, RewriteTarget>();
  const keyOf = (a: { collection: string; slug: string }) => `${a.collection}/${a.slug}`;
  const articleByKey = new Map(articles.map((a) => [keyOf(a), a]));

  const touch = (
    info: { collection: string; slug: string },
    row: { impressions: number; clicks: number; ctr: number; position: number } | undefined,
    reason: RewriteReason
  ) => {
    const key = keyOf(info);
    const article = articleByKey.get(key);
    if (!article || recentlyRewritten.has(key)) return undefined;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return existing;
    }
    const queries = candidates.topQueries[key] ?? [];
    const target: RewriteTarget = {
      article,
      reasons: [reason],
      impressions: row?.impressions ?? queries.reduce((s, q) => s + q.impressions, 0),
      clicks: row?.clicks ?? queries.reduce((s, q) => s + q.clicks, 0),
      ctr: row?.ctr ?? 0,
      position: row?.position ?? 0,
      queries,
      missingTerms: [],
      needsMenu: needsMenuResearch(article, queries),
    };
    byKey.set(key, target);
    return target;
  };

  for (const p of candidates.lowCtr) touch(p.article, p, 'lowCtr');
  for (const p of candidates.striking) touch(p.article, p, 'striking');
  for (const u of candidates.uncovered) {
    const target = touch(u.article, undefined, 'uncovered');
    if (!target) continue;
    for (const q of u.queries) {
      for (const term of q.missingInBody) {
        if (!GENERIC_TERMS.test(term) && !target.missingTerms.includes(term)) target.missingTerms.push(term);
      }
    }
  }

  return [...byKey.values()].sort((a, b) => b.impressions - a.impressions).slice(0, maxTargets);
}

// ============================================================
// メタ情報（seoTitle / description）の提案
// ============================================================

export const metaProposalSchema = z.object({
  seoTitle: z.string(),
  description: z.string(),
  /** 検索クエリに現れた、この店・記事の別表記（例: 「キーウエスト」）。確信が無ければ空配列。 */
  alternateNames: z.array(z.string()),
  rationale: z.string(),
});
export type MetaProposal = z.infer<typeof metaProposalSchema>;

/** callPlainJsonAgent に渡す responseSchema（Gemini の OpenAPI 形式）。 */
export const metaProposalResponseSchema = {
  type: 'object',
  properties: {
    seoTitle: { type: 'string' },
    description: { type: 'string' },
    alternateNames: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: ['seoTitle', 'description', 'alternateNames', 'rationale'],
} as const;

const REASON_LABELS: Record<RewriteReason, string> = {
  lowCtr: '検索結果に表示されているのにクリックされにくい',
  striking: '検索順位が8〜20位で、あと一歩で上位に入れる',
  uncovered: '記事に書かれていない語で検索されている',
};

export function buildMetaPrompt(target: RewriteTarget): string {
  const { article } = target;
  const isSpot = article.collection === 'spots';
  const queries = target.queries
    .map((q) => `- 「${q.query}」表示${q.impressions}回 / クリック${q.clicks} / 平均${q.position.toFixed(1)}位`)
    .join('\n');
  return `あなたは新潟県三条市の飲み屋街「本寺小路」の地域メディア「本寺小路ガイド」の編集者です。
Google検索の結果に表示される「タイトル」と「説明文」を、検索した人がクリックしたくなる形に書き直してください。

# 対象記事
- 種類: ${isSpot ? '店舗紹介' : article.collection === 'columns' ? 'コラム' : 'お知らせ'}
- 現在の見出し（title。変更しない）: ${article.title}
- 現在の検索結果用タイトル: ${article.seoTitle ?? '（未設定。見出しがそのまま使われている）'}
- 現在の説明文: ${article.description}

# この記事を選んだ理由
${target.reasons.map((r) => `- ${REASON_LABELS[r]}`).join('\n')}

# この記事が表示されている検索クエリ（Search Console・直近28日）
${queries || '（なし）'}

# 記事本文（事実の根拠はここと上の説明文だけ）
${article.body}

# 書き方のルール（厳守）
1. 本文と現在の説明文に書かれている事実だけを使う。本文に無い情報（メニュー名・価格・年数・受賞歴・営業時間など）を足さない。数字は本文にあるものだけ使う。
2. seoTitle は${REWRITE_LIMITS.seoTitleMin}〜${REWRITE_LIMITS.seoTitleMax}文字。末尾に「｜本寺小路ガイド」は付けない（自動で付く）。${isSpot ? '店名（見出し）をそのまま含め、「三条市」または「本寺小路」を入れる。' : ''}
3. description は${REWRITE_LIMITS.descriptionMin}〜${REWRITE_LIMITS.descriptionMax}文字。検索クエリでよく使われている語のうち、本文で裏付けられるものを自然に入れる。
4. 誇張表現（「絶対」「No.1」「最高」など）や、根拠の無い比較は使わない。
5. alternateNames には、検索クエリに現れた語のうち「明らかにこの店・記事の名前の別表記」（カタカナ表記・ひらがな表記など）だけを入れる。少しでも別の店の可能性があるなら入れない。無ければ空配列。
6. rationale に、何をどう変えたかを1〜2文で書く。`;
}

/** 文字列中の数字の並び（全角は半角に寄せる。桁区切りは無視）。 */
function numbersIn(text: string): string[] {
  return (text.normalize('NFKC').match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
}

/** 提案を決定論的に検証し、問題点の一覧を返す（空なら採用可）。 */
export function validateMetaProposal(proposal: MetaProposal, target: RewriteTarget): string[] {
  const errors: string[] = [];
  const { article } = target;
  const seoTitleLen = [...proposal.seoTitle].length;
  const descLen = [...proposal.description].length;

  if (seoTitleLen < REWRITE_LIMITS.seoTitleMin || seoTitleLen > REWRITE_LIMITS.seoTitleMax) {
    errors.push(`seoTitleの長さが範囲外です（${seoTitleLen}文字）。`);
  }
  if (/本寺小路ガイド/.test(proposal.seoTitle)) errors.push('seoTitleにサイト名が含まれています。');
  if (descLen < REWRITE_LIMITS.descriptionMin || descLen > REWRITE_LIMITS.descriptionMax) {
    errors.push(`descriptionの長さが範囲外です（${descLen}文字）。`);
  }
  if (article.collection === 'spots' && !containsTerm(proposal.seoTitle, article.title)) {
    errors.push('seoTitleに店名が含まれていません。');
  }

  // 本文・frontmatterに無い数字を持ち込んでいないか（価格・年数の捏造対策）。
  const sourceNumbers = new Set(numbersIn(article.raw));
  const invented = [...numbersIn(proposal.seoTitle), ...numbersIn(proposal.description)].filter(
    (n) => !sourceNumbers.has(n)
  );
  if (invented.length > 0) errors.push(`記事に無い数字が含まれています: ${[...new Set(invented)].join(', ')}`);

  // 別表記は検索クエリに実際に現れた語だけ（モデルの創作を防ぐ）。
  const allQueries = target.queries.map((q) => q.query.normalize('NFKC'));
  for (const name of proposal.alternateNames) {
    if (!allQueries.some((q) => q.includes(name.normalize('NFKC')))) {
      errors.push(`別表記「${name}」が検索クエリに見当たりません。`);
    }
  }

  return errors;
}

// ============================================================
// メニュー調査（Grounding）
// ============================================================

export const menuResearchSchema = z.object({
  found: z.boolean(),
  items: z.array(
    z.object({
      name: z.string().min(1),
      /** 「650円」「1,200円（税込）」など、確認できた表記のまま。不明なら空文字。 */
      price: z.string(),
    })
  ),
  sourceUrls: z.array(z.string().url()),
});
export type MenuResearch = z.infer<typeof menuResearchSchema>;

export function buildMenuPrompt(article: Pick<LoadedArticle, 'title' | 'frontmatter'>): string {
  const address = typeof article.frontmatter.address === 'string' ? article.frontmatter.address : '';
  return `新潟県三条市の飲食店「${article.title}」（住所: ${address}）のメニューと価格を、Google検索で調べてください。

# ルール（厳守）
- 公式サイト、公式SNS、食べログ・ホットペッパー等のグルメサイト、地域メディアの記事など、検索で実際に確認できた情報だけを使う。
- 同名の別の店（他の市町村の店など）の情報を混ぜない。住所が一致しない情報は使わない。
- 推測で品目や価格を補わない。価格が確認できない品目は price を空文字にする。
- 確認できた品目が${REWRITE_LIMITS.menuItemsMin}件未満なら found を false にし、items は空配列にする。
- items は代表的なものを最大${REWRITE_LIMITS.menuItemsMax}件まで。
- sourceUrls には実際に参照したページのURLを入れる。

# 出力形式
{"found": true, "items": [{"name": "品目名", "price": "650円"}], "sourceUrls": ["https://..."]}`;
}

export function validateMenuResearch(research: MenuResearch, groundingSourceCount: number): string[] {
  const errors: string[] = [];
  if (groundingSourceCount === 0) errors.push('Google検索の引用が0件でした（検索結果に基づかない可能性）。');
  if (!research.found) errors.push('メニュー情報が十分に見つかりませんでした。');
  if (research.items.length < REWRITE_LIMITS.menuItemsMin) errors.push(`品目が${research.items.length}件しかありません。`);
  if (research.sourceUrls.length === 0) errors.push('参照URLがありません。');
  return errors;
}

export function buildMenuSection(research: MenuResearch, today: string): string {
  const [year, month] = today.split('-');
  const items = research.items
    .slice(0, REWRITE_LIMITS.menuItemsMax)
    .map((item) => (item.price ? `- ${item.name}：${item.price}` : `- ${item.name}`))
    .join('\n');
  return `## メニューと価格の例

${items}

※${Number(year)}年${Number(month)}月時点でWeb上で確認できた情報です。メニュー・価格は変わることがあるため、最新の内容はお店でご確認ください。`;
}

// ============================================================
// Markdownファイルへの反映（コメントや並び順を保つため文字列操作で行う）
// ============================================================

const yamlString = (value: string) => JSON.stringify(value);

export function applyMetaEdits(raw: string, edits: { seoTitle: string; description: string }): string {
  const parts = splitFrontmatter(raw);
  if (!parts) throw new Error('frontmatterが見つかりません。');
  let fm = parts.frontmatterText;

  const descLine = /^(description|summary): ".*"$/m;
  if (!descLine.test(fm)) {
    throw new Error('description/summary が1行の文字列ではないため、安全に書き換えられません。');
  }
  fm = fm.replace(descLine, (_m, key: string) => `${key}: ${yamlString(edits.description)}`);

  if (/^seoTitle: .*$/m.test(fm)) {
    fm = fm.replace(/^seoTitle: .*$/m, `seoTitle: ${yamlString(edits.seoTitle)}`);
  } else if (/^title: .*$/m.test(fm)) {
    fm = fm.replace(/^(title: .*)$/m, `$1\nseoTitle: ${yamlString(edits.seoTitle)}`);
  } else {
    throw new Error('title 行が見つかりません。');
  }

  return `---\n${fm}\n---\n${parts.body}`;
}

/** 本文の最後の「## 」見出しの前に節を差し込む（見出しが無ければ末尾に追加）。 */
export function insertSectionBeforeLastHeading(body: string, section: string): string {
  const trimmed = body.replace(/\s+$/, '');
  const index = trimmed.lastIndexOf('\n## ');
  if (index <= 0) return `${trimmed}\n\n${section}\n`;
  return `${trimmed.slice(0, index)}\n\n${section}\n${trimmed.slice(index)}\n`;
}

export function buildAlternateNamesNote(title: string, names: string[]): string {
  return `※「${title}」は「${names.join('」「')}」と表記されることもあります。`;
}

export function appendToBody(raw: string, transform: (body: string) => string): string {
  const parts = splitFrontmatter(raw);
  if (!parts) throw new Error('frontmatterが見つかりません。');
  return `---\n${parts.frontmatterText}\n---\n${transform(parts.body)}`;
}

// ============================================================
// PR本文
// ============================================================

export interface RewriteResult {
  target: RewriteTarget;
  meta?: { before: { seoTitle?: string; description: string }; after: MetaProposal };
  metaSkipped?: string[];
  menu?: { items: MenuResearch['items']; sourceUrls: string[] };
  menuSkipped?: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function buildPrBody(results: RewriteResult[], range: { startDate: string; endDate: string }): string {
  const lines: string[] = [];
  lines.push(`Search Console（${range.startDate}〜${range.endDate}）の数値をもとに、改善候補の記事を自動でリライトしました。`);
  lines.push('**マージ前に、特に「要確認」の項目を見てください。** 不要な変更はこのPR上で直接編集・削除して構いません。');
  lines.push('');

  for (const r of results) {
    const { article } = r.target;
    lines.push(`## ${article.title}（\`${article.collection}/${article.slug}\`）`);
    lines.push(
      `表示 ${r.target.impressions} / クリック ${r.target.clicks}${r.target.ctr ? ` / CTR ${pct(r.target.ctr)}` : ''}${r.target.position ? ` / 平均 ${r.target.position.toFixed(1)}位` : ''} — 理由: ${r.target.reasons.map((x) => REASON_LABELS[x]).join('、')}`
    );
    lines.push('');
    if (r.meta) {
      lines.push('**検索結果用タイトル**');
      lines.push(`- 前: ${r.meta.before.seoTitle ?? `（未設定・見出し「${article.title}」）`}`);
      lines.push(`- 後: ${r.meta.after.seoTitle}`);
      lines.push('**説明文**');
      lines.push(`- 前: ${r.meta.before.description}`);
      lines.push(`- 後: ${r.meta.after.description}`);
      lines.push(`- 変更意図: ${r.meta.after.rationale}`);
      if (r.meta.after.alternateNames.length > 0) {
        lines.push(`- ⚠️ **要確認（表記ゆれ）**: 本文末に「${r.meta.after.alternateNames.join('」「')}」とも表記される旨を追記しました。本当に同じ店の別表記か確認してください。`);
      }
    } else if (r.metaSkipped) {
      lines.push(`タイトル・説明文: 提案が検証を通らなかったため変更していません（${r.metaSkipped.join(' / ')}）`);
    }
    if (r.menu) {
      lines.push('');
      lines.push('⚠️ **要確認（メニュー）**: 「メニューと価格の例」の節を追加しました。下の参照元と内容が一致しているか確認してください。');
      for (const item of r.menu.items) lines.push(`- ${item.name}${item.price ? `：${item.price}` : ''}`);
      lines.push('参照元:');
      for (const url of r.menu.sourceUrls) lines.push(`- ${url}`);
    } else if (r.menuSkipped) {
      lines.push('');
      lines.push(`メニュー: 「メニュー」で検索されていますが、裏付けの取れる情報が見つからなかったため追記していません（${r.menuSkipped.join(' / ')}）。お店に確認できたら手動で追記してください。`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
