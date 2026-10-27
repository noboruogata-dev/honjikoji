import { describe, expect, it, vi } from 'vitest';
import { isLikelySameStore, resolveBusinessStatus, resolvePlaceId, resolvePlaceIdWithRetry } from './googlePlaces';

describe('resolvePlaceId', () => {
  it('APIキーが無ければfetchせずnullを返す', async () => {
    const fetchImpl = vi.fn();
    const result = await resolvePlaceId('三条屋', '新潟県三条市本町1-1-1', undefined, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('該当するPlace IDを解決する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [{ id: 'ChIJexample1234', displayName: { text: '三条屋' } }] }), { status: 200 })
    );
    const result = await resolvePlaceId('三条屋', '新潟県三条市本町1-1-1', 'test-key', { fetchImpl });
    expect(result).toEqual({ placeId: 'ChIJexample1234' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(init.headers['X-Goog-FieldMask']).toBe('places.id,places.displayName');
    const body = JSON.parse(init.body);
    expect(body.textQuery).toBe('三条屋 新潟県三条市本町1-1-1');
  });

  it('先頭が別店舗でも、店名が一致する候補のPlace IDを採用する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          places: [
            { id: 'ChIJother', displayName: { text: 'そば処今泉' } },
            { id: 'ChIJkikuya', displayName: { text: 'きくや' } },
          ],
        }),
        { status: 200 }
      )
    );
    const result = await resolvePlaceId('割烹 きくや', '新潟県三条市', 'test-key', { fetchImpl });
    expect(result).toEqual({ placeId: 'ChIJkikuya' });
  });

  it('店名が一致する候補が無ければnullを返す（別店舗のPlace IDを採用しない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [{ id: 'ChIJother', displayName: { text: 'そば処今泉' } }] }), {
        status: 200,
      })
    );
    const result = await resolvePlaceId('蕎麦割烹 麦', '新潟県三条市居島3-4', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('候補が0件ならnullを返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ places: [] }), { status: 200 }));
    const result = await resolvePlaceId('存在しない店', '新潟県三条市', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('APIがエラーを返してもnullを返す（例外を投げない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await resolvePlaceId('三条屋', '新潟県三条市', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('fetch自体が例外を投げてもnullを返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await resolvePlaceId('三条屋', '新潟県三条市', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });
});

describe('resolvePlaceIdWithRetry', () => {
  it('APIキーが無ければ1回もfetchせずnullを返す', async () => {
    const fetchImpl = vi.fn();
    const result = await resolvePlaceIdWithRetry('三条屋', '新潟県三条市', undefined, {
      fetchImpl,
      delayMs: 0,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('1回目で成功すればリトライしない', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ places: [{ id: 'ChIJexample1234', displayName: { text: '三条屋' } }] }), { status: 200 }));
    const result = await resolvePlaceIdWithRetry('三条屋', '新潟県三条市', 'test-key', {
      fetchImpl,
      delayMs: 0,
    });
    expect(result).toEqual({ placeId: 'ChIJexample1234' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('一過性のエラーの後、リトライで解決できればその結果を返す（回帰テスト: 実際に生成時は解決できなかったPlace IDが翌日の同じText Searchでは解決できた事例）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ places: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ places: [{ id: 'ChIJexample1234', displayName: { text: '三条屋' } }] }), { status: 200 }));
    const result = await resolvePlaceIdWithRetry('三条屋', '新潟県三条市', 'test-key', {
      fetchImpl,
      delayMs: 0,
    });
    expect(result).toEqual({ placeId: 'ChIJexample1234' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('既定回数（3回）すべて失敗したらnullを返す', async () => {
    // Response.text()はbodyを一度しか読めないため、複数回のfetchでは
    // 呼び出しごとに新しいResponseを返す必要がある（mockResolvedValueで
    // 同一インスタンスを使い回すと2回目以降で例外になる）。
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ places: [] }), { status: 200 }));
    const result = await resolvePlaceIdWithRetry('三条屋', '新潟県三条市', 'test-key', {
      fetchImpl,
      delayMs: 0,
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('attemptsオプションで試行回数を変更できる', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ places: [] }), { status: 200 }));
    const result = await resolvePlaceIdWithRetry('三条屋', '新潟県三条市', 'test-key', {
      fetchImpl,
      delayMs: 0,
      attempts: 2,
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('resolveBusinessStatus', () => {
  it('APIキーが無ければfetchせずnullを返す', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveBusinessStatus('ChIJexample1234', undefined, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('businessStatusのみをフィールドマスクに指定して取得する', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ businessStatus: 'OPERATIONAL' }), { status: 200 }));
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBe('OPERATIONAL');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJexample1234?languageCode=ja&regionCode=JP');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    // 上位SKUの課金対象を増やさないため、マスクは businessStatus のみに固定する。
    expect(init.headers['X-Goog-FieldMask']).toBe('businessStatus');
  });

  it('閉店（CLOSED_PERMANENTLY）をそのまま返す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ businessStatus: 'CLOSED_PERMANENTLY' }), { status: 200 })
      );
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBe('CLOSED_PERMANENTLY');
  });

  it('businessStatusが省略されていればnullを返す（営業中とみなさない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('未知の値はnullを返す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ businessStatus: 'SOMETHING_NEW' }), { status: 200 }));
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('APIがエラーを返してもnullを返す（例外を投げない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });

  it('fetch自体が例外を投げてもnullを返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await resolveBusinessStatus('ChIJexample1234', 'test-key', { fetchImpl });
    expect(result).toBeNull();
  });
});

describe('isLikelySameStore', () => {
  it.each([
    ['Anthem', 'Anthem'],
    ['バード', '軽食･喫茶バード'],
    ['酒采とお食事 どっぽ', '酒采とお食事どっぽ'],
    ['割烹 きくや', 'きくや'],
    ['もつ焼き たかはし', 'もつ焼たかはし'],
    ['Osteria Kissui tei', 'osteria kissuitei'],
    ["Sato's Bar", 'ＳＡＴＯ\'Ｓ ＢＡＲ'],
    ['炭火焼 く遠', 'く遠'],
    ['すし処 平井屋', '平井屋'],
    ['天婦羅割烹 みや嶋', 'みや嶋天婦羅割烹'],
  ])('「%s」と「%s」は同じ店とみなす', (storeName, displayName) => {
    expect(isLikelySameStore(storeName, displayName)).toBe(true);
  });

  it.each([
    ['蕎麦割烹 麦', 'そば処今泉'],
    ['割烹 きくや', '割烹 松木屋'],
    ['Wine Bar MARGAUX', 'Wine Bar Other'],
    ['そば処 今泉', 'そば処山河'],
  ])('「%s」と「%s」は別の店とみなす', (storeName, displayName) => {
    expect(isLikelySameStore(storeName, displayName)).toBe(false);
  });
});
