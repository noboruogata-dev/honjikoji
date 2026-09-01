/**
 * scripts/lib/slackNotify.ts
 *
 * Instagram投稿素材（文面・正方形画像）ができたことをSlackへ通知する。
 *
 * Incoming Webhook（環境変数 SLACK_WEBHOOK_URL）はファイルアップロードに
 * 対応していない（それにはBotトークンを使う files.getUploadURLExternal 系の
 * 別APIが必要で、今回はWebhook運用という方針のため使わない）。そのため
 * 画像はBlock Kitの image ブロックで本番URLを参照する形にする。
 *
 * このジョブがgit pushした直後は、Cloudflare Pagesのビルド・デプロイが
 * まだ完了していない可能性があり、Slackが画像や記事URLを取得しようとした
 * 瞬間だけ404で崩れて見えることがある（数分で解消する）。そのため
 * メッセージ冒頭に必ずその旨の注記を入れる。
 *
 * SLACK_WEBHOOK_URL未設定時は送信をスキップし、ログに残す（例外を投げない）。
 */

export interface InstagramNotifyInput {
  webhookUrl: string | undefined;
  /** Slack表示用の種別ラベル（例: "店舗記事" "コラム" "お知らせ"）。 */
  contentLabel: string;
  title: string;
  articleUrl: string;
  imageUrl: string;
  /** caption本文+ハッシュタグ、そのまま貼り付けられる完成形（instagram-caption.tsのfullText）。 */
  captionFullText: string;
  lengthNote?: string;
}

export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

export async function notifyInstagramMaterial(
  input: InstagramNotifyInput,
  fetchImpl: typeof fetch = fetch
): Promise<NotifyResult> {
  const label = '[slackNotify]';

  if (!input.webhookUrl) {
    console.log(`${label} SLACK_WEBHOOK_URL が未設定のため、Slack通知をスキップします。`);
    return { sent: false, reason: 'not-configured' };
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📸 Instagram投稿素材: ${input.contentLabel}`, emoji: true },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '反映まで数分かかります。画像や記事リンクがすぐ開けない場合は、少し待ってから再度お試しください。',
        },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${input.title}*\n<${input.articleUrl}|${input.articleUrl}>` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*投稿文面（タップしてコピー）*\n\`\`\`${input.captionFullText}\`\`\`` },
    },
    ...(input.lengthNote
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${input.lengthNote}` }] }]
      : []),
    {
      type: 'image',
      image_url: input.imageUrl,
      alt_text: input.title,
    },
  ];

  try {
    const res = await fetchImpl(input.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`${label} 送信が失敗しました（status ${res.status}）: ${body}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    console.log(`${label} 送信しました。`);
    return { sent: true };
  } catch (err) {
    console.error(`${label} 送信中に例外が発生しました: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: 'exception' };
  }
}
