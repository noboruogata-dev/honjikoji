/**
 * scripts/lib/slackNotify.ts
 *
 * Instagram投稿素材（文面・正方形画像）ができたことをSlackへ通知する。
 *
 * Incoming Webhook（環境変数 SLACK_WEBHOOK_URL）はファイルアップロードに
 * 対応していない（それにはBotトークンを使う files.getUploadURLExternal 系の
 * 別APIが必要で、今回はWebhook運用という方針のため使わない）。
 *
 * 画像はBlock Kitの `image` ブロックではなく、mrkdwn内のリンクとして送る。
 * `image` ブロックはSlack側が送信時に image_url を同期的にダウンロード
 * 検証し、到達不能だとメッセージ全体を invalid_blocks（HTTP 400）で拒否する
 * 仕様がある（実際に発生を確認した）。このジョブがgit pushするのはNode
 * スクリプトの実行が終わった後（ワークフローの別ステップ）で、かつ
 * Cloudflare Pages側のビルド・デプロイはさらにその後に非同期で走るため、
 * この関数が呼ばれる時点で本番URLはほぼ確実にまだ存在しない
 * （＝いくら待っても間に合わない。呼び出し元のジョブ内でリトライしても無意味）。
 *
 * リンクのunfurl（自動でプレビュー画像を展開表示。展開されればスマホで
 * 長押し保存できる）には表記に注意が必要: Slack公式ドキュメントによると
 * 「表示ラベルがURLのプロトコルを除いた部分と完全一致する場合、リンクは
 * unfurlされない」。`<url|url>`（ラベル=URL自体）はこの抑制ルールに
 * 該当してunfurlされないため、ラベル無しの `<url>` 形式で書くこと
 * （URLがその時点で生きていれば自動でunfurlされ、スマホのSlackアプリで
 * プレビュー画像を長押し保存できる。生きていなければunfurlされないだけで
 * メッセージ自体は失われない）。
 *
 * キャプション本文はコードブロック（```）で囲まない。Slackモバイルでは
 * コードブロックが折り返されず横スクロールになり読みにくいため。通常の
 * テキストでもSlackモバイルは長押しでコピーできる。
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
          text: '反映まで数分かかります。画像プレビューやリンクがすぐ開けない場合は、少し待ってから再度お試しください。',
        },
      ],
    },
    {
      // ラベル無し<url>形式。<url|url>（ラベル=URL）はSlackの仕様で
      // unfurlされないため使わないこと（このファイル冒頭コメント参照）。
      type: 'section',
      text: { type: 'mrkdwn', text: `*${input.title}*\n<${input.articleUrl}>` },
    },
    {
      // コードブロックにしない（Slackモバイルで横スクロールになるため）。
      // 通常のmrkdwnテキストでもSlackモバイルは長押しでコピーできる。
      type: 'section',
      text: { type: 'mrkdwn', text: `*投稿文面（長押しでコピー）*\n${input.captionFullText}` },
    },
    ...(input.lengthNote
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${input.lengthNote}` }] }]
      : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*正方形画像*\n<${input.imageUrl}>` },
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
