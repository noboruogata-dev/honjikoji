/**
 * scripts/lib/instagramMaterialAgent.ts
 *
 * Agent: Instagram Material — 記事の生成・公開が成功した後に呼ぶ、
 * Instagram投稿素材の準備エージェント。文面生成（Agent:InstagramCaption、
 * LLM）・フィード画像の解決（scripts/lib/instagramFeedImage.ts。コラムは
 * 専用イラスト優先、無ければ文字ベース画像を生成）・Slack通知
 * （Incoming Webhook）を1つにまとめる。
 *
 * どの段階で失敗しても記事の公開自体をブロックしない。例外は一切外へ
 * 投げず、失敗はログに残したうえで { posted: false } を返す。
 */

import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import { runInstagramCaptionAgent, type InstagramContentType } from './instagram-caption.js';
import { resolveInstagramFeedImage } from './instagramFeedImage.js';
import { notifyInstagramMaterial } from './slackNotify.js';

// astro.config.mjs の `site` と同じ値。
const SITE_URL = 'https://honjikoji.jp';

export interface InstagramMaterialInput {
  type: InstagramContentType;
  /** Slack表示用の種別ラベル（例: "店舗記事" "コラム" "お知らせ"）。 */
  contentLabel: string;
  slug: string;
  title: string;
  /** 記事の要約（description/summary）。キャプション生成の材料。 */
  summary: string;
  /** 記事本文（Markdown）。キャプション生成の材料。 */
  body: string;
  /** 画像内に出すラベル（例: "居酒屋 ／ 本寺小路" "お知らせ" "街の歴史"）。文字ベース画像でのみ使う。 */
  imageLabel: string;
  /** サイトルート相対のURLパス（例: "/spots/xxx/"）。 */
  urlPath: string;
  projectRoot: string;
}

export interface InstagramMaterialResult {
  posted: boolean;
  /**
   * Job Summaryに残すべき警告（フォントの欠字検出など、運営者が気づく
   * 必要のある事象）。無ければ設定しない。呼び出し元のappendStepSummaryに
   * 含めること。
   */
  warning?: string;
}

export async function runInstagramMaterialAgent(
  ai: GoogleGenAI,
  input: InstagramMaterialInput
): Promise<InstagramMaterialResult> {
  const label = '[Agent:InstagramMaterial]';

  try {
    const caption = await runInstagramCaptionAgent(ai, {
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
    });
    if (!caption) {
      console.warn(`${label} 文面の生成に失敗したため、Instagram素材の準備をスキップします。`);
      return { posted: false };
    }

    const image = await resolveInstagramFeedImage({
      type: input.type,
      slug: input.slug,
      title: input.title,
      imageLabel: input.imageLabel,
      projectRoot: input.projectRoot,
    });
    if (!image.ok || !image.imagePath || !image.imageUrl) {
      const warning = `Instagram素材: フィード画像を準備できませんでした（${image.error ?? '不明なエラー'}）。`;
      console.warn(`${label} ${warning}`);
      return { posted: false, warning };
    }
    console.log(
      `${label} フィード画像: ${path.relative(input.projectRoot, image.imagePath)}（source: ${image.source}）`
    );

    const articleUrl = `${SITE_URL}${input.urlPath}`;

    const result = await notifyInstagramMaterial({
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      contentLabel: input.contentLabel,
      title: input.title,
      articleUrl,
      imageUrl: image.imageUrl,
      captionFullText: caption.fullText,
      lengthNote: caption.lengthNote,
    });
    return { posted: result.sent };
  } catch (err) {
    console.error(
      `${label} 予期しないエラーが発生しました（記事の公開自体は継続します）: ${err instanceof Error ? err.message : String(err)}`
    );
    return { posted: false };
  }
}
