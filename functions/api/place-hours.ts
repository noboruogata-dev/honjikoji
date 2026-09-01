/**
 * functions/api/place-hours.ts
 *
 * Cloudflare Pages Functions（リポジトリルート直下 /functions のファイルベース
 * ルーティング）。astro.config.mjs の output モードやアダプタとは無関係に、
 * Cloudflare Pages がビルド出力（dist/）とは独立してこのフォルダを検出し、
 * デプロイする。dist/ に _worker.js が無い限り自動的に directory mode で
 * 動作するため、このサイト（output: 'static'、アダプタ未導入）では
 * astro.config.mjs の変更もアダプタ追加も不要で、既存の静的ページには
 * 一切影響しない。
 *
 * GET /api/place-hours?placeId=xxxx
 *
 * Google Place Details (New) を都度ライブ呼び出しし、営業時間
 * （regularOpeningHours.weekdayDescriptions）だけを返す。
 *
 * Google Maps Platform利用規約上、opening hoursには明示的なキャッシュ許可が
 * ない（許可されているのは place_id の無期限保存と、緯度経度の30日一時
 * キャッシュのみ）。そのためこのレスポンスは一切保存・共有キャッシュせず、
 * 呼び出しのたびにGoogleへ都度問い合わせ、Cache-Control: no-store を付けて
 * そのまま返す。フィールドマスクは regularOpeningHours のみを要求し、
 * 不要なフィールド（Pro/Enterprise SKU課金対象）を含めない。
 *
 * このエンドポイントはpublicにGET可能で、かつAPIキーを内部で使うため、
 * 任意のplaceIdに対する「無料のGoogle Places代理呼び出し」として悪用され
 * 得る。sec-fetch-siteヘッダで同一オリジンからの呼び出しかを緩く確認するが
 * これは詐称可能な軽い抑止に過ぎない。実質的な歯止めは、Google Cloud
 * Console側でこのAPIキーに設定する1日あたりのクォータ上限（悪用時の被害を
 * 上限で切るための最終防御線）。
 */

interface Env {
  GOOGLE_PLACES_API_KEY?: string;
}

interface PagesFunctionContext {
  request: Request;
  env: Env;
}

const NO_STORE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
}

// Google Place IDは英数字・アンダースコア・ハイフンのみで構成される。
const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{10,255}$/;

export async function onRequestGet(context: PagesFunctionContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const placeId = url.searchParams.get('placeId');

  if (!placeId || !PLACE_ID_PATTERN.test(placeId)) {
    return jsonResponse({ error: 'invalid placeId' }, 400);
  }

  // 悪用抑止の軽い足切り（詐称可能なため、あくまで補助）。同一オリジンの
  // fetchであれば通常 same-origin が送られる。ヘッダ自体が無い（curl等）
  // 場合は判定できないため通す。
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin') {
    return jsonResponse({ error: 'forbidden' }, 403);
  }

  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'not configured' }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=ja&regionCode=JP`,
      {
        headers: {
          'X-Goog-Api-Key': apiKey,
          // フィールドマスクは regularOpeningHours のみ。他のフィールドを
          // 足すと上位SKUの課金対象が増えるため絶対に増やさないこと。
          'X-Goog-FieldMask': 'regularOpeningHours',
        },
      }
    );
  } catch {
    return jsonResponse({ error: 'upstream fetch failed' }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse({ error: 'upstream error', status: upstream.status }, 502);
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    return jsonResponse({ error: 'invalid upstream response' }, 502);
  }

  const weekdayDescriptions = (
    data as { regularOpeningHours?: { weekdayDescriptions?: unknown } } | null
  )?.regularOpeningHours?.weekdayDescriptions;

  if (!Array.isArray(weekdayDescriptions) || weekdayDescriptions.length === 0) {
    return jsonResponse({ error: 'no hours available' }, 404);
  }

  const lines = weekdayDescriptions.filter((line): line is string => typeof line === 'string');
  if (lines.length === 0) {
    return jsonResponse({ error: 'no hours available' }, 404);
  }

  return jsonResponse({ weekdayDescriptions: lines });
}
