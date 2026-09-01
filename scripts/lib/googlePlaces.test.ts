import { describe, expect, it, vi } from 'vitest';
import { resolvePlaceId } from './googlePlaces';

describe('resolvePlaceId', () => {
  it('APIキーが無ければfetchせずnullを返す', async () => {
    const fetchImpl = vi.fn();
    const result = await resolvePlaceId('三条屋', '新潟県三条市本町1-1-1', undefined, { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('該当するPlace IDを解決する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [{ id: 'ChIJexample1234' }] }), { status: 200 })
    );
    const result = await resolvePlaceId('三条屋', '新潟県三条市本町1-1-1', 'test-key', { fetchImpl });
    expect(result).toEqual({ placeId: 'ChIJexample1234' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(init.headers['X-Goog-FieldMask']).toBe('places.id');
    const body = JSON.parse(init.body);
    expect(body.textQuery).toBe('三条屋 新潟県三条市本町1-1-1');
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
