import { describe, expect, it } from 'vitest';
import { placeIdToCid } from './placeIdToCid';

describe('placeIdToCid', () => {
  it('Place IDからcidを取り出す（Places APIのgoogleMapsUriのcidと一致）', () => {
    expect(placeIdToCid('ChIJe0OMWmnj9F8RI-acwErt74A')).toBe('9290905461603493411');
  });

  it('形式が想定と違えばnull', () => {
    expect(placeIdToCid('')).toBeNull();
    expect(placeIdToCid('not-a-place-id')).toBeNull();
    expect(placeIdToCid('ChIJ')).toBeNull();
  });
});
