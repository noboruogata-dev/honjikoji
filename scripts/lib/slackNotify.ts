/**
 * scripts/lib/slackNotify.ts
 *
 * Instagram投稿素材（文面・正方形画像）ができたことをSlackへ通知する。
 *
 * Incoming Webhook（環境変数 SLACK_WEBHOOK_URL）はファイルアップロードに
 * 対応していない（それにはBotトークンを使う files.getUploadURLExternal 系の
 * 別APIが必要で、今回はWebhook運用という方針のため使わない）。
 *
 * 画像はBlock Kitの `image` ブロックではなく、あえてただのリンク
 * （sectionのmrkdwnリンク）として送る。`image` ブロックはSlack側が
 * 送信時に image_url を同期的にダウンロード検証し、到達不能だと
 * メッセージ全体を invalid_blocks（HTTP 400）で拒否する仕様がある
 * （実際に発生を確認した）。このジョブがgit pushするのはNode
 * スクリプトの実行が終わった後（ワークフローの別ステップ）で、かつ
 * Cloudflare Pages側のビルド・デプロイはさらにその後に非同期で走るため、
 * この関数が呼ばれる時点で本番URLはほぼ確実にまだ存在しない
 * （＝いくら待っても間に合わない。呼び出し元のジョブ内でリトライしても
 * 無意味）。plain textリンクであれば、Slack側の検証で通知全体が
 * 失われることはなく、Slackの自動リンク展開が後から効けば画像も
 * 表示される（効かなくても最低限リンクと文面は必ず届く）。
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
          text: '反映まで数分かかります。リンクがすぐ開けない場合は、少し待ってから再度お試しください。',
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
    // あえてimageブロックにしない（このファイル冒頭コメント参照）。
    // リンクとして貼るだけなら、Slack側の到達性検証で通知全体が
    // invalid_blocksになることはない。
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*正方形画像*\n<${input.imageUrl}|${input.imageUrl}>` },
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
