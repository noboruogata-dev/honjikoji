import { describe, expect, it } from 'vitest';
import { buildGoogleMapsUrl } from './structuredData';

describe('buildGoogleMapsUrl', () => {
  it('店名・所在地をキー不要のGoogle マップ検索に渡す', () => {
    const url = new URL(buildGoogleMapsUrl('酒場 A&B 三条市'));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/');
    expect(url.searchParams.get('api')).toBe('1');
    expect(url.searchParams.get('query')).toBe('酒場 A&B 三条市');
    expect(url.searchParams.has('query_place_id')).toBe(false);
    expect(url.searchParams.has('key')).toBe(false);
  });

  it('Place IDがある場合も検索語を残し、正しい店舗を指定する', () => {
    const url = new URL(buildGoogleMapsUrl('日本料理 小山屋 三条市', 'ChIJ4zRf2lri9F8Rmo4RRz7nfy8'));
    expect(url.searchParams.get('query')).toBe('日本料理 小山屋 三条市');
    expect(url.searchParams.get('query_place_id')).toBe('ChIJ4zRf2lri9F8Rmo4RRz7nfy8');
  });
});
