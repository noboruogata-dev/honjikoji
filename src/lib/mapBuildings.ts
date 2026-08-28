/**
 * src/lib/mapBuildings.ts
 *
 * 建物ID（RojiMap.svg の bldg-01〜bldg-20）と店舗slugの対応表。
 * 実際の位置関係は未確定なため、暫定で3店舗を仮の区画に割り当てている。
 * 実地図が確定したら、この対応（右辺のslugと左辺の建物IDの組み合わせ）
 * だけを差し替えればよい。
 *
 * 対応表に無い建物IDは「空き区画」として扱われ、src/pages/map/index.astro
 * 側でリンク化・ホバー演出のいずれも行われない。
 */
export const MAP_BUILDING_TO_SPOT: Record<string, string> = {
  'bldg-03': 'bar-keywest', // 仮の位置。実際の区画が判明次第差し替える
  'bldg-07': 'sumibiyaki-kuon', // 仮の位置
  'bldg-15': 'taisyu-yakiniku-sankiraku', // 仮の位置
};
