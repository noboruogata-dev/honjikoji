/**
 * scripts/lib/instagramMaterialAgent.ts
 *
 * Agent: Instagram Material — 記事の生成・公開が成功した後に呼ぶ、
 * Instagram投稿素材の準備エージェント。文面生成（Agent:InstagramCaption、
 * LLM）・正方形画像生成（satori+sharp）・Slack通知（Incoming Webhook）を
 * 1つにまとめる。
 *
 * どの段階で失敗しても記事の公開自体をブロックしない。例外は一切外へ
 * 投げず、失敗はログに残したうえで { posted: false } を返す。
 */

import { GoogleGenAI } from '@google/genai';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runInstagramCaptionAgent, type InstagramContentType } from './instagram-caption.js';
import { renderInstagramSquareImage } from './ogpImage.js';
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
  /** 画像内に出すラベル（例: "居酒屋 ／ 本寺小路" "お知らせ" "街の歴史"）。scripts/generate-ogp-images.tsのlabel生成と揃える。 */
  imageLabel: string;
  /** サイトルート相対のURLパス（例: "/spots/xxx/"）。 */
  urlPath: string;
  projectRoot: string;
}

export interface InstagramMaterialResult {
  posted: boolean;
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

    const imageDir = path.join(input.projectRoot, 'public/images/instagram');
    await mkdir(imageDir, { recursive: true });
    const imageFileName = `${input.type}-${input.slug}-square.webp`;
    const imagePath = path.join(imageDir, imageFileName);

    let imageBuffer: Buffer;
    try {
      imageBuffer = await renderInstagramSquareImage({ type: input.type, title: input.title, label: input.imageLabel });
    } catch (err) {
      console.warn(
        `${label} 正方形画像の生成に失敗したため、Instagram素材の準備をスキップします: ${err instanceof Error ? err.message : String(err)}`
      );
      return { posted: false };
    }
    await writeFile(imagePath, imageBuffer);
    console.log(`${label} 正方形画像を保存しました: ${path.relative(input.projectRoot, imagePath)}`);

    const articleUrl = `${SITE_URL}${input.urlPath}`;
    const imageUrl = `${SITE_URL}/images/instagram/${imageFileName}`;

    const result = await notifyInstagramMaterial({
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      contentLabel: input.contentLabel,
      title: input.title,
      articleUrl,
      imageUrl,
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
