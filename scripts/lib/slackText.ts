/**
 * scripts/lib/slackText.ts
 *
 * Slack Incoming Webhook へプレーンテキストを1通送る。SEOレポート・
 * リライトの要約通知用。未設定・失敗時はログだけ残して例外を投げない
 * （通知の失敗で本処理を止めないため。slackNotify.ts と同じ方針）。
 */
export async function notifySlackText(
  webhookUrl: string | undefined,
  text: string,
  label = '[slack]',
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (!webhookUrl) {
    console.log(`${label} SLACK_WEBHOOK_URL が未設定のため、Slack通知をスキップします。`);
    return false;
  }
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.warn(`${label} Slack通知に失敗しました（HTTP ${res.status}）。処理は続行します。`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`${label} Slack通知に失敗しました。処理は続行します:`, err instanceof Error ? err.message : err);
    return false;
  }
}
