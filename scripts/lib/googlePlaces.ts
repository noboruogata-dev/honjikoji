/**
 * scripts/lib/googlePlaces.ts
 *
 * Google Places API (New) の Text Search を使い、店名・住所から Place ID を
 * 決定論的に解決する（LLM不使用）。
 *
 * Place ID の永続保存はGoogle Maps Platform利用規約で明示的に許可されている
 * （Service Specific Terms §3 Google ID Caching）ため、frontmatterに保存して
 * よい。営業時間などの他のフィールドはここでは一切取得しない（規約上の
 * キャッシュ許可がないため保存できない。詳細ページでのライブ取得は
 * functions/api/place-hours.ts が別途担当する）。
 *
 * フィールドマスクは places.id のみを要求する。不要なフィールドを含めると
 * 上位SKU（Pro/Enterprise）で課金されるため、Text Search自体はEssentials
 * ティアのまま完結させる。
 */

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

export interface ResolvedPlace {
  placeId: string;
}

export interface ResolvePlaceIdOptions {
  /** テスト用の fetch 差し替え。省略時はグローバル fetch を使う。 */
  fetchImpl?: typeof fetch;
  /**
   * true にすると、リクエスト内容（キーはマスク）とレスポンスの
   * ステータス・ボディ全文を console.error に出力する
   * （--backfill-place-id からのデバッグ用途。通常のAgent3実行では使わない）。
   */
  verbose?: boolean;
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 6)}...(${apiKey.length}文字)`;
}

/**
 * 店名＋住所からPlace IDを解決する。APIキー未設定・該当なし・APIエラーの
 * 場合はすべて null を返す（例外を投げない）。呼び出し側は「解決できな
 * かった」を通常の結果として扱い、既存の動作へフォールバックすればよい
 * （scripts/generate-spot.tsのAgent3、および--backfill-place-idの方針）。
 */
export async function resolvePlaceId(
  storeName: string,
  address: string,
  apiKey: string | undefined,
  options: ResolvePlaceIdOptions = {}
): Promise<ResolvedPlace | null> {
  const verbose = options.verbose ?? false;
  const log = (msg: string) => {
    if (verbose) console.error(`[googlePlaces] ${msg}`);
  };

  if (!apiKey) {
    log('APIキーが渡されていません（GOOGLE_PLACES_API_KEY未設定）。');
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const textQuery = `${storeName} ${address}`;
  const requestBody = { textQuery, languageCode: 'ja', regionCode: 'JP' };

  log(`query: "${textQuery}"`);
  log(`request: POST ${TEXT_SEARCH_URL}`);
  log(`  X-Goog-Api-Key: ${maskApiKey(apiKey)}`);
  log(`  X-Goog-FieldMask: places.id`);
  log(`  body: ${JSON.stringify(requestBody)}`);

  let response: Response;
  try {
    response = await fetchImpl(TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // フィールドマスクは id のみ。Essentialsティアで完結させる。
        'X-Goog-FieldMask': 'places.id',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    log(`fetch自体が例外を投げました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const bodyText = await response.text();
  log(`response status: ${response.status} ${response.statusText}`);
  log(`response body: ${bodyText}`);

  if (!response.ok) return null;

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    log('レスポンスボディをJSONとしてパースできませんでした。');
    return null;
  }

  const places = (data as { places?: Array<{ id?: unknown }> } | null)?.places;
  const placeId = places?.[0]?.id;
  if (typeof placeId !== 'string' || placeId.length === 0) {
    log('レスポンスに places[0].id が含まれていませんでした（該当0件、またはフィールドマスク不一致）。');
    return null;
  }

  return { placeId };
}
