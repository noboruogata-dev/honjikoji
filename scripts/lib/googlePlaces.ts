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
 * フィールドマスクは places.id と places.displayName のみを要求する。
 * displayName を含むため Text Search は Essentials ではなく Pro ティアの
 * SKU で課金されるが、記事生成1件につき数回しか呼ばないので許容する。
 * 2026年10月、「蕎麦割烹 麦」の記事で places[0] が近所の別店舗「そば処今泉」
 * だったのに id しか見ていなかったため気付けず、誤ったPlace IDのまま公開
 * された（実際の店舗は閉店済みでGoogleに登録が無かった）。店名の照合に
 * displayName が必須なので、これ以外のフィールドは増やさないこと。
 */

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const placeDetailsUrl = (placeId: string) =>
  `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=ja&regionCode=JP`;

export interface ResolvedPlace {
  placeId: string;
}

/** Place Details (New) の regularOpeningHours.periods 1件分。day は 0=日曜〜6=土曜。 */
export interface GoogleOpeningPeriod {
  open: { day: number; hour: number; minute: number };
  close: { day: number; hour: number; minute: number };
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

/** 店名照合用の正規化。全角/半角・大文字小文字・空白・記号の差を吸収する。 */
function normalizeStoreName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･'’"“”.,、。&＆\-‐－ー~〜()（）「」]/g, '');
}

/**
 * 店名の照合で「一致」の根拠にしない、業態を表すだけの語。
 * これらが共通しているだけでは同じ店とはみなさない（例: 「割烹 A」と「割烹 B」）。
 */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set(
  [
    'bar', 'wine', 'winebar', 'osteria', 'cafe', 'dining', 'izakaya',
    '割烹', '蕎麦割烹', '天婦羅割烹', '料亭', '居酒屋', '酒場', '大衆酒場', 'スナック', 'バー',
    'そば処', '蕎麦処', 'すし処', '寿司処', '鮨処', 'そば', '蕎麦', 'すし', '寿司', '鮨',
    '焼肉', '大衆焼肉', '炭火焼', 'もつ焼', 'もつ焼き', '焼鳥', '焼き鳥', 'やきとり',
    '旬彩', '食堂', '本店', '支店',
  ].map(normalizeStoreName)
);

/**
 * 記事の店名とGoogle側の displayName が同じ店を指していそうかを判定する。
 *
 * どちらかの正規化後の全体がもう一方に含まれていれば一致とする
 * （例: 「割烹 きくや」⊃「きくや」）。そうでなければ、記事の店名を空白で
 * 区切った語のうち業態語（GENERIC_NAME_TOKENS）以外の語が displayName に
 * 含まれていれば一致とする（例: 「天婦羅割烹 みや嶋」の「みや嶋」が
 * 「みや嶋天婦羅割烹」に含まれる）。
 *
 * 英字とカナの表記違い（「Bar Keywest」と「キーウエスト」）は一致と判定
 * できない。誤った店のPlace IDで公開するより見送るほうが安全なので、
 * 意図的にこちら側（不一致）へ倒している。
 */
export function isLikelySameStore(storeName: string, displayName: string): boolean {
  const a = normalizeStoreName(storeName);
  const b = normalizeStoreName(displayName);
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes(b) || b.includes(a)) return true;

  return storeName
    .normalize('NFKC')
    .split(/\s+/)
    .map(normalizeStoreName)
    .some((token) => token.length >= 2 && !GENERIC_NAME_TOKENS.has(token) && b.includes(token));
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
  log(`  X-Goog-FieldMask: places.id,places.displayName`);
  log(`  body: ${JSON.stringify(requestBody)}`);

  let response: Response;
  try {
    response = await fetchImpl(TEXT_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // フィールドマスクは id と店名照合用の displayName のみ（ファイル先頭コメント参照）。
        'X-Goog-FieldMask': 'places.id,places.displayName',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.log(`[googlePlaces] Text Search "${textQuery}" がfetch例外で失敗しました。`);
    log(`fetch自体が例外を投げました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const bodyText = await response.text();
  log(`response status: ${response.status} ${response.statusText}`);
  log(`response body: ${bodyText}`);

  if (!response.ok) {
    // エラーレスポンスボディ（Google API標準の { error: { code, message,
    // status } } 形式）はAPIキーの値自体を含まず、リクエストの何が invalid
    // だったかを示すだけなので常時ログする。2026年9月、Place ID解決が
    // 全店舗でHTTP 400になる不具合の原因調査に必要だったため追加
    // （ステータスコードだけでは「何が invalid か」が分からず特定できなかった）。
    console.log(`[googlePlaces] Text Search "${textQuery}" がHTTP ${response.status} で失敗しました: ${bodyText}`);
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    log('レスポンスボディをJSONとしてパースできませんでした。');
    return null;
  }

  const places = (data as { places?: Array<{ id?: unknown; displayName?: { text?: unknown } }> } | null)
    ?.places;
  if (!places?.some((p) => typeof p.id === 'string' && p.id.length > 0)) {
    // Text Search自体の検索語（storeName/address、当サイト側で組み立てた
    // クエリ）と「0件だった」という事実は、Googleから返された内容
    // （Google Maps Content）ではないため、verboseに関わらず常時ログして
    // よい。placeId自体もGoogle Maps Platform利用規約でキャッシュ・保存が
    // 明示的に許可されている（ファイル先頭コメント参照）。この常時ログが
    // 無かったため、2026年9月に本番でPlace ID未解決が続いた際、原因
    // （クエリが実際に何だったか、0件かAPIエラーか）を後から一切追跡
    // できなかった。
    console.log(`[googlePlaces] Text Search "${textQuery}" は0件でした。`);
    log('レスポンスに places[].id が含まれていませんでした（該当0件、またはフィールドマスク不一致）。');
    return null;
  }

  // 検索結果の先頭が目的の店とは限らない（近所の別店舗が返ることがある）。
  // 店名が一致する候補だけを採用し、無ければ「解決できなかった」とする。
  const matched = places.find(
    (p) =>
      typeof p.id === 'string' &&
      p.id.length > 0 &&
      typeof p.displayName?.text === 'string' &&
      isLikelySameStore(storeName, p.displayName.text)
  );
  if (!matched) {
    const names = places.map((p) => String(p.displayName?.text ?? '?')).join(' / ');
    console.log(
      `[googlePlaces] Text Search "${textQuery}" の候補に店名「${storeName}」と一致するものがありませんでした: ${names}`
    );
    return null;
  }

  const placeId = matched.id as string;
  console.log(`[googlePlaces] Text Search "${textQuery}" → ${placeId}（${String(matched.displayName?.text)}）`);
  return { placeId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResolvePlaceIdRetryOptions extends ResolvePlaceIdOptions {
  /** 最大試行回数（1回目 + リトライ）。既定3回。 */
  attempts?: number;
  /** 各試行の間隔（ミリ秒）。既定2000ms。 */
  delayMs?: number;
}

/**
 * resolvePlaceId を間隔を空けて複数回リトライする。
 *
 * Text Search自体が一過性のエラー（ネットワーク瞬断、Google側のインデックス
 * 反映タイミング等）で失敗し、直後に同じクエリを投げ直すと解決できることが
 * 実際に確認されている（新規オープン店の記事で、生成時は解決できなかった
 * Place IDが翌日には同じText Searchで解決できた事例）。
 *
 * 呼び出し元（scripts/generate-spot.tsのAgent3）は、全リトライを終えても
 * nullなら「Place IDを解決できなかった」として記事の保存自体を見送る
 * （誤情報が検証・ライブ表示のどちらの安全策も経由せず公開されるのを防ぐ
 * ため）。1回勝負ではなく複数回試すことで、この見送りが一過性のエラー
 * だけを理由に発生する頻度を下げる。
 *
 * apiKey が未設定の場合は1回も試さずnullを返す（無駄な待機を避ける。
 * 呼び出し元はこれを「設定不備」として別途扱う）。
 */
export async function resolvePlaceIdWithRetry(
  storeName: string,
  address: string,
  apiKey: string | undefined,
  options: ResolvePlaceIdRetryOptions = {}
): Promise<ResolvedPlace | null> {
  if (!apiKey) return null;

  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 2000;
  const verbose = options.verbose ?? false;

  let result: ResolvedPlace | null = null;
  for (let i = 1; i <= attempts; i += 1) {
    result = await resolvePlaceId(storeName, address, apiKey, options);
    if (result) return result;

    if (verbose) {
      console.error(`[googlePlaces] Place ID解決 ${i}/${attempts}回目が失敗しました。`);
    }
    if (i < attempts) await sleep(delayMs);
  }
  return result;
}

/**
 * Place Details (New) から regularOpeningHours.periods を取得する。
 *
 * 「Agent 1が導出したhoursの検証」専用（scripts/lib/hoursComparison.ts）。
 * Google Maps Platform利用規約上、opening hoursはfrontmatter等への永続保存が
 * 許可されていないため、取得した値はその場での比較にのみ使い、呼び出し元
 * では絶対に保存しないこと（functions/api/place-hours.tsと同じ「都度ライブ
 * 取得・保存しない」方針）。
 *
 * verboseは既定でfalse（呼び出し元に明示的に強制しない）。scripts/generate-spot.ts
 * の自動実行（GitHub Actions）から呼ぶ場合はverbose:trueを渡さないこと
 * ―true にすると営業時間の実データがActionsのログに残ってしまい、規約が
 * 禁止する「Google Maps Contentの保存」に該当し得る。--backfill-place-id等、
 * 人間が手元で対話的にデバッグする用途でのみtrueにする想定。
 */
export async function resolveRegularOpeningHoursPeriods(
  placeId: string,
  apiKey: string | undefined,
  options: ResolvePlaceIdOptions = {}
): Promise<GoogleOpeningPeriod[] | null> {
  const verbose = options.verbose ?? false;
  const log = (msg: string) => {
    if (verbose) console.error(`[googlePlaces] ${msg}`);
  };

  if (!apiKey) {
    log('APIキーが渡されていません（GOOGLE_PLACES_API_KEY未設定）。');
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = placeDetailsUrl(placeId);

  log(`request: GET ${url}`);
  log(`  X-Goog-Api-Key: ${maskApiKey(apiKey)}`);
  log(`  X-Goog-FieldMask: regularOpeningHours`);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        // フィールドマスクは regularOpeningHours のみ。他のフィールドを
        // 足すと上位SKUの課金対象が増えるため絶対に増やさないこと。
        'X-Goog-FieldMask': 'regularOpeningHours',
      },
    });
  } catch (err) {
    log(`fetch自体が例外を投げました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const bodyText = await response.text();
  log(`response status: ${response.status} ${response.statusText}`);
  // verbose時のみ全文を出す。既定(false)では営業時間の実データを一切ログに残さない。
  log(`response body: ${bodyText}`);

  if (!response.ok) return null;

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    log('レスポンスボディをJSONとしてパースできませんでした。');
    return null;
  }

  const periods = (data as { regularOpeningHours?: { periods?: unknown } } | null)?.regularOpeningHours?.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    log('レスポンスに regularOpeningHours.periods が含まれていませんでした。');
    return null;
  }

  return periods as GoogleOpeningPeriod[];
}

/**
 * Place Details (New) の businessStatus。
 * OPERATIONAL=営業中 / CLOSED_TEMPORARILY=一時休業 / CLOSED_PERMANENTLY=閉店。
 */
export type BusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';

const BUSINESS_STATUSES: readonly string[] = [
  'OPERATIONAL',
  'CLOSED_TEMPORARILY',
  'CLOSED_PERMANENTLY',
];

/**
 * Place Details (New) から businessStatus だけを取得する。
 *
 * 閉店した店を掲載し続けるのは地域メディアとして最も避けたい状態なので、
 * Agent3（scripts/generate-spot.ts）はPlace ID解決の直後にこれを呼び、
 * CLOSED_PERMANENTLY なら記事を保存せず見送る。既存店舗の定期点検
 * （scripts/check-business-status.ts、週次ワークフロー）からも同じ関数を使う。
 *
 * businessStatus は「今の状態」であり、Google Maps Platform利用規約上
 * frontmatter等への永続保存は許可されていない。判定・報告にその場で使う
 * だけにとどめ、絶対に記事へ書き込まないこと（opening hoursと同じ方針。
 * resolveRegularOpeningHoursPeriods のコメント参照）。
 *
 * なおフィールドマスクに businessStatus を含むPlace Detailsリクエストは
 * Essentialsではなく Pro ティアのSKUで課金される。1店舗1回に限定し、
 * 他のフィールドを足さないこと（displayNameを足すとSKUは変わらないが、
 * ここでは判定に不要なので要求しない）。
 *
 * 取得できなかった場合（APIキー未設定・HTTPエラー・想定外の値）はnullを
 * 返す。呼び出し側は「閉店と断定できなかった」として扱い、記事をブロック
 * しない（Google側の一時的な障害で正常な店の記事が落ちるのを避ける）。
 */
export async function resolveBusinessStatus(
  placeId: string,
  apiKey: string | undefined,
  options: ResolvePlaceIdOptions = {}
): Promise<BusinessStatus | null> {
  const verbose = options.verbose ?? false;
  const log = (msg: string) => {
    if (verbose) console.error(`[googlePlaces] ${msg}`);
  };

  if (!apiKey) {
    log('APIキーが渡されていません（GOOGLE_PLACES_API_KEY未設定）。');
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = placeDetailsUrl(placeId);

  log(`request: GET ${url}`);
  log(`  X-Goog-Api-Key: ${maskApiKey(apiKey)}`);
  log(`  X-Goog-FieldMask: businessStatus`);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        // フィールドマスクは businessStatus のみ。増やさないこと（上記コメント参照）。
        'X-Goog-FieldMask': 'businessStatus',
      },
    });
  } catch (err) {
    console.log(`[googlePlaces] businessStatus取得 (${placeId}) がfetch例外で失敗しました。`);
    log(`fetch自体が例外を投げました: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const bodyText = await response.text();
  log(`response status: ${response.status} ${response.statusText}`);
  log(`response body: ${bodyText}`);

  if (!response.ok) {
    console.log(
      `[googlePlaces] businessStatus取得 (${placeId}) がHTTP ${response.status} で失敗しました: ${bodyText}`
    );
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(bodyText);
  } catch {
    log('レスポンスボディをJSONとしてパースできませんでした。');
    return null;
  }

  const status = (data as { businessStatus?: unknown } | null)?.businessStatus;
  if (typeof status !== 'string' || !BUSINESS_STATUSES.includes(status)) {
    // businessStatus はGoogleが値を持たない場所では省略される。閉店の
    // 判定材料が無いという意味でnullを返す（「営業中」とみなさない）。
    log(`レスポンスに既知の businessStatus が含まれていませんでした: ${String(status)}`);
    return null;
  }

  return status as BusinessStatus;
}
