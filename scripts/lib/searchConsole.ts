/**
 * scripts/lib/searchConsole.ts
 *
 * Google Search Console API（Search Analytics）の最小クライアント。
 *
 * googleapis パッケージは依存が非常に大きいため使わず、サービスアカウントの
 * JWT（RS256）を node:crypto で署名してアクセストークンを取得し、REST を
 * 直接叩く。必要なのは searchanalytics.query の1エンドポイントだけである。
 *
 * 認証情報:
 *   GSC_SERVICE_ACCOUNT_JSON … サービスアカウントの鍵JSON（ファイルの中身を
 *     そのまま1つの文字列として。GitHub Secrets にそのまま貼り付ける想定）。
 *   GSC_SITE_URL … Search Console のプロパティ。ドメインプロパティなら
 *     "sc-domain:honjikoji.jp"、URLプレフィックスなら "https://honjikoji.jp/"。
 *
 * サービスアカウントのメールアドレスを、Search Console の該当プロパティに
 * 「ユーザー（制限付き）」として追加しておく必要がある（読み取りのみで足りる）。
 */
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function parseServiceAccountKey(raw: string | undefined): ServiceAccountKey {
  if (!raw || raw.trim() === '') {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON が設定されていません。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON がJSONとして読めません（鍵ファイルの中身をそのまま設定してください）。');
  }
  const key = parsed as Partial<ServiceAccountKey>;
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON に client_email / private_key がありません。');
  }
  // Secrets経由で改行が "\\n" のまま入るケースに備えて正規化する。
  return { client_email: key.client_email, private_key: key.private_key.replace(/\\n/g, '\n') };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function buildSignedJwt(key: ServiceAccountKey, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(key.private_key));
  return `${header}.${claim}.${signature}`;
}

export async function getAccessToken(key: ServiceAccountKey, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildSignedJwt(key),
    }),
  });
  if (!res.ok) {
    throw new Error(`アクセストークンの取得に失敗しました（HTTP ${res.status}）: ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('アクセストークンがレスポンスに含まれていません。');
  return data.access_token;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsQuery {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dimensions: Array<'page' | 'query' | 'date' | 'device' | 'country'>;
  rowLimit?: number;
}

/** searchanalytics.query を、rowLimit 単位でページングしながら全件取得する。 */
export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  query: SearchAnalyticsQuery,
  fetchImpl: typeof fetch = fetch
): Promise<SearchAnalyticsRow[]> {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const rowLimit = query.rowLimit ?? 5000;
  const rows: SearchAnalyticsRow[] = [];

  for (let startRow = 0; ; startRow += rowLimit) {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: query.startDate,
        endDate: query.endDate,
        dimensions: query.dimensions,
        rowLimit,
        startRow,
        dataState: 'final',
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const hint =
        res.status === 403
          ? '（サービスアカウントがSearch Consoleのプロパティにユーザー追加されているか、GSC_SITE_URLの表記が一致しているか確認してください）'
          : '';
      throw new Error(`Search Console APIの呼び出しに失敗しました（HTTP ${res.status}）${hint}: ${text}`);
    }
    const data = (await res.json()) as { rows?: SearchAnalyticsRow[] };
    const page = data.rows ?? [];
    rows.push(...page);
    if (page.length < rowLimit) break;
  }

  return rows;
}
