/**
 * 本寺小路夜話の3段階生成パイプライン。
 *
 * Agent 1: Google Search Groundingで主張単位の事実・出典・確度を収集
 * Agent 2: Agent 1のJSONだけを事実源として執筆（Groundingなし）
 * Agent 3: Zodと決定論的ルールで検証。通常はdraft、--publish時は公開状態で保存
 *
 * 例:
 *   npm run generate:column -- --category=alcohol --dry-run
 *   npm run generate:column -- --category=history --topic="本寺小路の花街としての歩み"
 *   npm run generate:column -- --category=people --kind=fiction
 *   npm run generate:column -- --category=people --kind=interview --source-file=./interview-notes.txt
 *   npm run generate:column -- --category=alcohol --publish
 */

import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendStepSummary,
  callGroundedJsonAgent,
  callPlainJsonAgent,
  FatalPipelineError,
  getExistingEntries,
  logZodIssues,
  normalizeText,
  parseJsonOrThrow,
  slugify,
  toYamlString,
  uniqueSlug,
} from './lib/gemini-agents.js';
import {
  CLAIM_STATUSES,
  columnFrontmatterSchema,
  columnResearchSchema,
  columnWriterSchema,
  resolveProfile,
  SOURCE_TYPES,
  sourcesForUsedClaims,
  validateColumnDraft,
  type ColumnFrontmatter,
  type ColumnProfile,
  type ColumnResearch,
  type ColumnWriter,
} from './lib/column-pipeline.js';
import {
  buildColumnImagePrompt,
  buildColumnMidImagePrompt,
  findMidImageInsertion,
  generateColumnImages,
} from './lib/column-images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLUMNS_DIR = path.resolve(__dirname, '../src/content/columns');
const NEWS_DIR = path.resolve(__dirname, '../src/content/news');
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_ATTEMPTS = 3;
const MAX_SOURCE_CHARS = 30_000;

interface CliOptions {
  category: string;
  kind?: string;
  topic?: string;
  sourceFile?: string;
  dryRun: boolean;
  noImage: boolean;
  publish: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  let noImage = false;
  let publish = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--no-image') {
      noImage = true;
      continue;
    }
    if (arg === '--publish') {
      publish = true;
      continue;
    }
    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (match) values.set(match[1], match[2]);
  }
  return {
    category: values.get('category') ?? '',
    kind: values.get('kind'),
    topic: values.get('topic'),
    sourceFile: values.get('source-file'),
    dryRun,
    noImage,
    publish,
  };
}

function todayInTokyo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function loadProvidedMaterial(sourceFile?: string): Promise<string> {
  if (!sourceFile) return '';
  const absolute = path.resolve(process.cwd(), sourceFile);
  const raw = await readFile(absolute, 'utf-8');
  if (!raw.trim()) throw new Error(`取材資料が空です: ${sourceFile}`);
  if ([...raw].length > MAX_SOURCE_CHARS) {
    throw new Error(`取材資料が${MAX_SOURCE_CHARS.toLocaleString()}字を超えています。分割してください。`);
  }
  return raw.trim();
}

const researchResponseSchema = {
  type: Type.OBJECT,
  properties: {
    notFound: { type: Type.BOOLEAN },
    topic: { type: Type.STRING },
    slug: { type: Type.STRING },
    angle: { type: Type.STRING },
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          statement: { type: Type.STRING },
          status: { type: Type.STRING, description: CLAIM_STATUSES.join(' / ') },
          sourceTitle: { type: Type.STRING },
          sourceUrl: { type: Type.STRING },
          sourceType: { type: Type.STRING, description: SOURCE_TYPES.join(' / ') },
        },
        required: ['id', 'statement', 'status', 'sourceTitle', 'sourceUrl'],
      },
    },
  },
  required: ['notFound', 'topic', 'slug', 'angle', 'claims'],
};

const writerResponseSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    body: { type: Type.STRING },
    usedClaimIds: { type: Type.ARRAY, items: { type: Type.STRING } },
    disclaimer: { type: Type.STRING },
  },
  required: ['title', 'summary', 'body', 'usedClaimIds', 'disclaimer'],
};

function researchPrompt(
  profile: ColumnProfile,
  topic: string | undefined,
  excludedTitles: string[],
  providedMaterial: string
): string {
  const requestedTopic = topic ? `今回の指定テーマ: ${topic}` : 'カテゴリ内から、既存記事と重ならないテーマを1つ選ぶ。';
  const exclusions = excludedTitles.length
    ? `既存記事（重複禁止）:\n${excludedTitles.map((title) => `- ${title}`).join('\n')}`
    : '既存記事はまだありません。';
  const provided = providedMaterial
    ? `\n--- 運営者提供資料 ---\n${providedMaterial}\n--- 提供資料ここまで ---\n提供資料由来の主張は sourceType="provided"、sourceTitle="運営者提供資料"、sourceUrl="" とする。資料にない人物の発言・経歴・心情を補わない。`
    : '';

  return `あなたは本寺小路夜話のResearch Agentです。Google Search Groundingを使い、記事執筆前の事実台帳を作ってください。

カテゴリ: ${profile.category}
記事種別: ${profile.kind}
調査方針: ${profile.researchFocus}
${requestedTopic}
${exclusions}
${provided}

主張はclaimsへ1件ずつ分割し、次を厳守してください。
- idはclaim-1、claim-2の連番
- verified: 信頼できる一次資料、または独立した複数資料で確認できた
- single-source: 1資料でのみ確認できた
- oral-tradition: 郷土資料や聞き書きに「その伝承が存在する」と記録されている
- unverified: 根拠を確認できない。記事本文では使用禁止
- Web由来の主張はsourceTitle、sourceUrl、sourceTypeを必須にする
- sourceUrlには、その記述を確認できる記事・資料ページを指定する。jpg/png等の画像ファイル直URLや、検索結果URLを出典にしない
- 検索結果のスニペットだけを根拠にせず、参照先の内容を確認する
- 「発祥」「最初」「唯一」などの強い断定は一次資料なしでverifiedにしない
- 実在しない資料、URL、人物、店舗、出来事を作らない
- ${profile.kind === 'fiction' ? '実在店舗・実在人物の逸話を集めない。街の一般的背景だけを調べる。' : '記事に使える具体的事実を集める。'}

指定テーマに必要な根拠を得られない場合はnotFound=trueとし、claimsを空にしてください。
slugは英小文字とハイフンだけで作成してください。出力は指定スキーマに準拠したJSONだけにしてください。`;
}

function writerPrompt(profile: ColumnProfile, research: ColumnResearch): string {
  const kindRules =
    profile.kind === 'history'
      ? '- oral-traditionを使う場合は「伝承」「語り継がれている」「諸説ある」等を本文で明示する。\n- single-sourceは「〜と記録されています」等とし、確定事実のように断定しない。'
      : profile.kind === 'fiction'
        ? '- 架空の人物・架空の店だけを使う。実在する店名、人物、具体的経歴を出さない。\n- 本文冒頭に「※この物語はフィクションです。」を入れ、disclaimerにも同じ趣旨を書く。\n- 本寺小路や三条市など実在地域の背景説明を使う場合、その根拠となるclaim idをusedClaimIdsへ入れる。架空の人物・筋書きにclaim idは不要。'
        : profile.kind === 'interview'
          ? '- 人物・店舗固有の内容はsourceType=providedの主張だけを使う。\n- 発言を新しく作らず、心情を推測しない。'
          : '- 読者が今夜試せる具体的な楽しみ方へつなげる。';

  return `あなたは本寺小路夜話のWriter Agentです。Groundingや検索は使えません。
以下のResearch JSONだけを事実ソースとして執筆し、書かれていない固有名詞・数値・年代・由来・発言を作らないでください。

カテゴリ: ${profile.category}
記事種別: ${profile.kind}
文体: ${profile.writerVoice}

--- Research JSON ---
${JSON.stringify(research, null, 2)}
--- ここまで ---

執筆要件:
- title: 25〜40字程度
- summary: 80〜120字程度。本文冒頭と同じ文章にしない
- body: Markdown、800〜1,200字程度、です・ます調
- 200字超は2段落以上、400字超は##見出しを1つ以上、1段落150字程度まで
- 使用した事実ごとに対応するclaim idをusedClaimIdsへ入れる
- status=unverifiedの主張は絶対に使わない
- 他サイトの文章を転載しない
${kindRules}

出力は指定スキーマに準拠したJSONだけにしてください。`;
}

async function runResearchAgent(
  ai: GoogleGenAI,
  profile: ColumnProfile,
  topic: string | undefined,
  excludedTitles: string[],
  providedMaterial: string
): Promise<ColumnResearch> {
  const label = '[Agent1:Research]';
  console.log(`${label} ${profile.category}（${profile.kind}）の事実と出典を調査中...`);
  const raw = await callGroundedJsonAgent(ai, {
    label,
    prompt: researchPrompt(profile, topic, excludedTitles, providedMaterial),
    responseSchema: researchResponseSchema,
  });
  const result = columnResearchSchema.safeParse(parseJsonOrThrow(raw, label));
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent1のJSONがスキーマに準拠していません。');
  }
  console.log(`${label} 完了。主張${result.data.claims.length}件を収集しました。`);
  return result.data;
}

async function runWriterAgent(
  ai: GoogleGenAI,
  profile: ColumnProfile,
  research: ColumnResearch
): Promise<ColumnWriter> {
  const label = '[Agent2:Writer]';
  console.log(`${label} Research JSONだけを使って本文を執筆中...`);
  const raw = await callPlainJsonAgent(ai, {
    label,
    prompt: writerPrompt(profile, research),
    responseSchema: writerResponseSchema,
  });
  const result = columnWriterSchema.safeParse(parseJsonOrThrow(raw, label));
  if (!result.success) {
    logZodIssues(result, label);
    throw new Error('Agent2のJSONがスキーマに準拠していません。');
  }
  console.log(`${label} 完了。本文${[...result.data.body].length}字。`);
  return result.data;
}

function buildFrontmatter(frontmatter: ColumnFrontmatter): string {
  const lines = [
    '---',
    `title: ${toYamlString(frontmatter.title)}`,
    `pubDate: ${frontmatter.pubDate}`,
    `category: ${toYamlString(frontmatter.category)}`,
    `summary: ${toYamlString(frontmatter.summary)}`,
    `kind: ${frontmatter.kind}`,
    `draft: ${frontmatter.draft}`,
  ];
  if (frontmatter.disclaimer) lines.push(`disclaimer: ${toYamlString(frontmatter.disclaimer)}`);
  if (frontmatter.illustration) {
    lines.push('illustration:');
    lines.push(`  src: ${toYamlString(frontmatter.illustration.src)}`);
    lines.push(`  alt: ${toYamlString(frontmatter.illustration.alt)}`);
  }
  if (frontmatter.eyecatch) {
    lines.push('eyecatch:');
    lines.push(`  src: ${toYamlString(frontmatter.eyecatch.src)}`);
    lines.push(`  alt: ${toYamlString(frontmatter.eyecatch.alt)}`);
  }
  if (frontmatter.imageStatus) lines.push(`imageStatus: ${frontmatter.imageStatus}`);
  if (frontmatter.sources?.length) {
    lines.push('sources:');
    for (const source of frontmatter.sources) {
      lines.push(`  - title: ${toYamlString(source.title)}`);
      lines.push(`    url: ${toYamlString(source.url)}`);
      lines.push(`    type: ${source.type}`);
    }
  }
  return `${lines.concat('---', '', '').join('\n')}`;
}

export function buildColumnNewsMarkdown(slug: string, frontmatter: ColumnFrontmatter): string {
  const columnHref = `/columns/${slug}/`;
  const newsSummary = `本寺小路夜話に「${frontmatter.title}」を公開しました。`;
  return [
    '---',
    `title: ${toYamlString(`新しい夜話を公開しました｜${frontmatter.title}`)}`,
    `pubDate: ${frontmatter.pubDate}`,
    'category: NOTICE',
    `summary: ${toYamlString(newsSummary)}`,
    `relatedColumnSlug: ${toYamlString(slug)}`,
    '---',
    '',
    `${newsSummary}`,
    '',
    `${frontmatter.summary}`,
    '',
    `[コラムを読む](${columnHref})`,
    '',
  ].join('\n');
}

async function runQaAgent(
  ai: GoogleGenAI,
  profile: ColumnProfile,
  research: ColumnResearch,
  writer: ColumnWriter,
  existingSlugs: string[],
  hasProvidedMaterial: boolean,
  dryRun: boolean,
  noImage: boolean,
  publish: boolean
): Promise<{ filePath: string; warnings: string[] }> {
  const label = '[Agent3:QA]';
  console.log(`${label} Zod・出典・構造・記事種別を決定論的に検証中...`);
  const qa = validateColumnDraft(profile, research, writer, hasProvidedMaterial);
  for (const warning of qa.warnings) console.warn(`${label} [WARN] ${warning}`);
  if (qa.errors.length) {
    for (const error of qa.errors) console.error(`${label} [ERROR] ${error}`);
    throw new Error(`Agent3が${qa.errors.length}件の安全性・整合性エラーを検出しました。保存しません。`);
  }

  const sources = sourcesForUsedClaims(research, writer.usedClaimIds);
  const slug = uniqueSlug(slugify(research.slug), existingSlugs, 'column');
  const imageInput = {
    slug,
    title: writer.title,
    summary: writer.summary,
    category: profile.category,
    kind: profile.kind,
  };
  let images:
    | Awaited<ReturnType<typeof generateColumnImages>>
    | undefined;
  // 2枚目（本文中ほどの挿絵）を挿入した場合はimages.bodyに差し替える。
  // 生成しなかった場合はwriter.bodyのまま。
  let finalBody = writer.body;
  if (noImage) {
    console.warn(`${label} --no-image指定のため画像生成を省略します。`);
  } else if (dryRun) {
    console.log('\n----- 生成予定の画像プロンプト（1枚目・アイキャッチ） -----\n');
    console.log(buildColumnImagePrompt(imageInput));
    const insertion = findMidImageInsertion(writer.body);
    if (insertion) {
      console.log('\n----- 生成予定の画像プロンプト（2枚目・本文挿絵） -----\n');
      console.log(buildColumnMidImagePrompt(imageInput, insertion));
    } else {
      console.log('\n本文が短い、または見出しが少ないため2枚目の挿絵は生成しません。');
    }
  } else {
    images = await generateColumnImages(ai, imageInput, writer.body, PROJECT_ROOT);
    for (const warning of images.warnings) console.warn(`[Agent5:ImageQA] [WARN] ${warning}`);
    console.log(`[Agent5:ImageQA] 原画を保持しました: ${path.relative(process.cwd(), images.sourcePath)}`);
    finalBody = images.body;
  }
  const candidate = {
    title: writer.title,
    pubDate: todayInTokyo(),
    category: profile.category,
    summary: writer.summary,
    kind: profile.kind,
    draft: !publish,
    sources: sources.length ? sources : undefined,
    disclaimer: writer.disclaimer || undefined,
    illustration: images?.illustration,
    eyecatch: images?.eyecatch,
    imageStatus: images ? (publish ? 'qa-passed' as const : images.imageStatus) : undefined,
  };
  const parsed = columnFrontmatterSchema.safeParse(candidate);
  if (!parsed.success) {
    logZodIssues(parsed, label);
    throw new Error('Agent3がFrontmatterのスキーマ違反を検出しました。保存しません。');
  }

  const filePath = path.join(COLUMNS_DIR, `${slug}.md`);
  const markdown = buildFrontmatter(parsed.data) + finalBody.trim() + '\n';

  if (dryRun) {
    console.log(`${label} dry-runのため保存しません。予定ファイル: ${path.relative(process.cwd(), filePath)}`);
    console.log('\n----- 生成予定Markdown -----\n');
    console.log(markdown);
  } else {
    await writeFile(filePath, markdown, 'utf-8');
    console.log(`${label} ${publish ? '公開記事' : '下書き'}を保存しました: ${path.relative(process.cwd(), filePath)}`);
    if (publish) {
      const newsPath = path.join(NEWS_DIR, `column-${slug}.md`);
      await writeFile(newsPath, buildColumnNewsMarkdown(slug, parsed.data), { encoding: 'utf-8', flag: 'wx' });
      console.log(`${label} ニュース告知を保存しました: ${path.relative(process.cwd(), newsPath)}`);
    }
  }
  // images.warningsには2枚目の挿絵生成失敗（非ブロッキング）も含まれるため、
  // Job Summaryで見えるようqa.warningsとまとめて返す。
  return { filePath, warnings: [...qa.warnings, ...(images?.warnings ?? [])] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = resolveProfile(options.category, options.kind);
  const providedMaterial = await loadProvidedMaterial(options.sourceFile);

  if (profile.kind === 'interview' && !providedMaterial) {
    throw new Error('取材記事には --source-file=取材資料.txt が必要です。');
  }
  if (profile.kind !== 'interview' && providedMaterial) {
    throw new Error('--source-file は kind=interview の場合だけ指定できます。');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('.env に GEMINI_API_KEY を設定してください。');
  const ai = new GoogleGenAI({ apiKey });

  console.log('============================================================');
  console.log(' 本寺小路夜話 3段階生成パイプライン');
  console.log(` ${profile.category} / ${profile.kind} / ${options.dryRun ? 'DRY RUN' : options.publish ? 'AUTO PUBLISH' : 'DRAFT SAVE'}`);
  console.log(' Agent1(Research) -> Agent2(Writer) -> Agent3(QA)');
  console.log('============================================================');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n----- 試行 ${attempt}/${MAX_ATTEMPTS} -----`);
    const existing = await getExistingEntries(COLUMNS_DIR);
    try {
      const research = await runResearchAgent(ai, profile, options.topic, existing.titles, providedMaterial);
      if (research.notFound) {
        console.warn('[generate-column] 十分な根拠を確認できませんでした。別テーマで再試行します。');
        continue;
      }
      const duplicate = existing.titles.some((title) => normalizeText(title) === normalizeText(research.topic));
      if (duplicate) {
        console.warn(`[generate-column] 「${research.topic}」は既存記事と重複するため再試行します。`);
        continue;
      }

      const writer = await runWriterAgent(ai, profile, research);
      const saved = await runQaAgent(
        ai,
        profile,
        research,
        writer,
        existing.slugs,
        Boolean(providedMaterial),
        options.dryRun,
        options.noImage,
        options.publish
      );
      await appendStepSummary(
        [
          '## 📖 本寺小路夜話 コラム生成',
          '',
          `- タイトル: ${writer.title}`,
          `- カテゴリ: ${profile.category}`,
          `- 種別: ${profile.kind}`,
          `- 状態: ${options.dryRun ? 'dry-run（未保存）' : options.publish ? 'published（自動QA通過）' : 'draft（要確認）'}`,
          `- ファイル: \`${path.relative(process.cwd(), saved.filePath)}\``,
          `- QA警告: ${saved.warnings.length}件`,
          // 2枚目（本文挿絵）の生成失敗など、非ブロッキング警告の中身が
          // ログを開かなくてもJob Summaryだけで分かるよう本文も残す。
          ...saved.warnings.map((warning) => `  - ${warning}`),
        ].join('\n')
      );
      return;
    } catch (error) {
      if (error instanceof FatalPipelineError) throw error;
      console.error(`[generate-column] 試行${attempt}失敗:`, error instanceof Error ? error.message : error);
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
  throw new Error('十分な根拠を持つ未掲載テーマを選定できませんでした。');
}

main().catch((error) => {
  console.error('\n[generate-column] 安全に停止しました:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
