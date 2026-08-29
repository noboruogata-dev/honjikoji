/**
 * src/lib/guides.ts
 *
 * テーマ別まとめページ（/guides/）のデータ定義。検索エンジンは
 * /spots/?scene=late のようなクエリ付きURLをインデックスしないため、
 * 「三条 深夜 飲み屋」のような複合語の検索流入を静的ページで受け止める。
 *
 * 抽出条件は content.config.ts の既存フィールド（vibes / hours / budgetMin）
 * だけから機械的に導出する。新しいfrontmatterフィールドは追加しない。
 * vibesの一致文字列は src/pages/spots/index.astro の scenes/seatTypes と
 * 同じ語彙（"深夜営業"等）を意図的に再利用している（表記ゆれを避けるため）。
 *
 * 導入文（intro）はLLM等での自動生成をせず、手書きで用意したもの。
 */
import { parseTimeToMinutes, type HourRule } from './hours';

/** matches() 判定に必要な最小限の店舗情報。CollectionEntry<'spots'>['data']・
 *  生frontmatterオブジェクトの双方が構造的にこれを満たす。 */
export interface GuideSpotInput {
  vibes: string[];
  hours?: HourRule[];
  budgetMin?: number;
}

/** このページ以下の店舗数だと検索結果としては薄すぎる、というnoindexの閾値。
 *  店舗が増えて閾値以上になれば、ビルドのたびに自動的にnoindexが外れる。 */
export const GUIDE_MIN_SPOTS_FOR_INDEX = 3;

// spots/index.astro の scenes/seatTypes と同じ照合文字列。
const VIBE_LATE_NIGHT = '深夜営業';
const VIBE_COUNTER = 'カウンター席あり';
const VIBE_SHIME = '2次会・締めに最適';
const VIBE_FIRST = '1軒目におすすめ';
const BUDGET_3000_MAX = 3000;
const MIDNIGHT_MINUTES = 24 * 60;

/** hoursのいずれかの区間が「当日24:00以降」まで営業しているか。
 *  hours.tsのclose表記（日またぎは24を超える値、例: "26:00"）をそのまま利用する。 */
function closesAtOrAfterMidnight(hours: HourRule[] | undefined): boolean {
  if (!hours) return false;
  return hours.some((rule) => {
    const closeMinutes = parseTimeToMinutes(rule.close);
    return closeMinutes !== null && closeMinutes >= MIDNIGHT_MINUTES;
  });
}

export interface GuideDefinition {
  slug: string;
  /** H1・<title>に使う正式タイトル。 */
  title: string;
  /** 一覧・ナビ用の短いラベル。 */
  shortLabel: string;
  /** meta description。 */
  description: string;
  /** 導入文（200〜300字、手書き）。2〜3段落に分割した配列で、各要素が1段落に対応する。
   *  「テーマから探す」ハブページのカード紹介文にも使う（その場合は結合して表示）。 */
  intro: string[];
  /** 関連ガイドへのリンク用slug。 */
  relatedSlugs: string[];
  /** /spots/ の既存フィルタへ引き継げる場合のクエリ付きパス（無ければ/spots/にリンクするだけ）。 */
  spotsQuery?: string;
  /** 該当判定。hashigoは全店が対象のため常にtrueを返す（グルーピングして表示するだけ）。 */
  matches: (spot: GuideSpotInput) => boolean;
}

export const GUIDES: GuideDefinition[] = [
  {
    slug: 'late-night',
    title: '本寺小路で深夜まで飲める店',
    shortLabel: '深夜まで飲める店',
    description:
      '三条市本寺小路で深夜まで営業している飲食店・BARをまとめました。仕事帰りの一杯、飲み会の後のもう一軒に。',
    intro: [
      '三条という街そのものは、決して眠らない街ではない。それでも本寺小路の灯りは、日付が変わっても消えない。中心市街地でこれほど遅くまで表に灯りが漏れる路地は、実はそう多くない。',
      '高度経済成長期からこの路地の灯りは絶やされることなく受け継がれてきたというが、深夜まで営業する店の存在もその一部だろう。',
      '仕事終わりが遅くなった日も、飲み会の後にもう一軒欲しくなった夜も、ここなら受け止めてくれる店がある。日付をまたいでも通える、本寺小路の店をまとめた。',
    ],
    relatedSlugs: ['hashigo', 'shime'],
    spotsQuery: '/spots/?scene=late',
    matches: (spot) => spot.vibes.includes(VIBE_LATE_NIGHT) || closesAtOrAfterMidnight(spot.hours),
  },
  {
    slug: 'hashigo',
    title: '本寺小路のハシゴ酒｜1軒目から〆まで',
    shortLabel: 'ハシゴ酒コース',
    description:
      '本寺小路のはしご酒コースを1軒目・2軒目・〆で紹介。路地一本で夜を完結させる、三条ならではの飲み歩き方。',
    intro: [
      '三条が金物と鍛冶の町として栄えた高度経済成長期、本寺小路には料亭や小料理屋、スナックが軒を連ね、夜ごと賑わったという。その名残もあってか、路地には今も店が肩を寄せ合うように並んでいる。だから他の街のように移動に気を遣わず、何軒でも歩いて回れる。',
      '1軒目は居酒屋で腹ごしらえをしながら夜のペースを作り、2軒目はBARやスナックでじっくり語らい、〆はラーメンやおでんで締めくくる。',
      '〆まで路地一本で完結する密度こそが、この街の贅沢さだ。その流れに沿って、店を並べた。',
    ],
    relatedSlugs: ['late-night', 'shime', 'counter'],
    matches: () => true,
  },
  {
    slug: 'counter',
    title: '一人でも入りやすいカウンターの店',
    shortLabel: 'カウンターの店',
    description:
      '本寺小路でカウンター席のある、一人でも入りやすい店をまとめました。大将・女将との会話も楽しみのひとつ。',
    intro: [
      '三条は決して大きな街ではない。だからこそ本寺小路には、一人でふらりと立ち寄れる店が多い。昭和レトロな看板建築の細い間口をくぐると、たいていカウンターが客を迎える。',
      '出張や一人旅でこの路地に迷い込んだ夜も、勝手はさほど変わらない。大将や女将と少し言葉を交わすうちに、一見さんもいつしか顔なじみになっていく。それがこの路地に今も残る独特の距離感だ。',
      'スマートフォンから顔を上げて、目の前の一杯と会話を味わえる、カウンターのある店だけを集めた。',
    ],
    relatedSlugs: ['hashigo', 'budget-3000'],
    spotsQuery: '/spots/?seat=counter',
    matches: (spot) => spot.vibes.includes(VIBE_COUNTER),
  },
  {
    slug: 'shime',
    title: '飲んだあとの〆に寄る店',
    shortLabel: '〆に寄る店',
    description: '本寺小路で飲んだあとの〆に寄れる店をまとめました。静かに一杯、小腹を満たすラーメンやおでんも。',
    intro: [
      '飲み会がお開きになった後、まっすぐ帰るには少し名残惜しい夜がある。本寺小路には、そんな気分を受け止める最後の一軒がある。1軒目、2軒目と重ねてきた夜も、ここでは他の街まで足を延ばさず、路地の中だけで完結する。',
      'にぎやかな居酒屋の後に、静かにグラスを傾けられる店。ラーメンやおでんで小腹を満たしてから帰る夜もある。〆まで路地一本で完結できるのが、この街の贅沢さだ。',
      '今夜の〆に、ふらりと寄れる店をまとめた。',
    ],
    relatedSlugs: ['hashigo', 'late-night'],
    spotsQuery: '/spots/?scene=shime',
    matches: (spot) => spot.vibes.includes(VIBE_SHIME),
  },
  {
    slug: 'budget-3000',
    title: '予算3,000円台で飲める店',
    shortLabel: '予算3,000円台',
    description: '本寺小路で予算3,000円台から楽しめる店をまとめました。気取らず立ち寄れる、三条らしい価格感の一軒を。',
    intro: [
      '本寺小路は、無理をして着飾って行くような街ではない。金物と鍛冶の町として栄えた三条には、腕一本で稼いだ金を気取らず使う職人気質が今も息づいている。',
      'ここに通うのは観光客より地元の常連が多く、店の値付けもその感覚に合わせて無理がない。仕事帰りのままふらりと立ち寄り、ほどよく飲んで、財布を気にせず帰れる。そのくらいの距離感が、この路地の性分に合っている。',
      '3,000円台で楽しめる、本寺小路らしい店をまとめた。',
    ],
    relatedSlugs: ['counter', 'hashigo'],
    spotsQuery: '/spots/?budget=3000',
    matches: (spot) => spot.budgetMin !== undefined && spot.budgetMin <= BUDGET_3000_MAX,
  },
];

export function getGuide(slug: string): GuideDefinition | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

/** hashigoを除いた、その店が該当するガイド一覧（店舗詳細ページの「このお店が載っているガイド」用）。
 *  hashigoは全店が対象になり差別化情報にならないため、意図的に除外する。 */
export function guidesForSpot(spot: GuideSpotInput): GuideDefinition[] {
  return GUIDES.filter((guide) => guide.slug !== 'hashigo' && guide.matches(spot));
}

export interface HashigoGroups<T> {
  first: T[];
  second: T[];
  shime: T[];
}

/**
 * ハシゴ酒ページ用のグルーピング。「〆タグ→〆 / 1軒目タグ→1軒目 /
 * どちらも無し→2軒目」の優先順位で全店を振り分ける（重複掲載はしない）。
 * getInputで呼び出し側の実際の型（CollectionEntry・生frontmatter等）から
 * GuideSpotInputを取り出す形にし、ロジック自体は型に依存しない。
 */
export function classifyHashigo<T>(items: T[], getInput: (item: T) => GuideSpotInput): HashigoGroups<T> {
  const groups: HashigoGroups<T> = { first: [], second: [], shime: [] };
  for (const item of items) {
    const input = getInput(item);
    if (input.vibes.includes(VIBE_SHIME)) groups.shime.push(item);
    else if (input.vibes.includes(VIBE_FIRST)) groups.first.push(item);
    else groups.second.push(item);
  }
  return groups;
}

/** /guides/ ハブページの導入文（他のGUIDES要素と揃えるため、あえてGUIDES配列には含めない）。
 *  2段落に分割した配列で、各要素が1段落に対応する。 */
export const GUIDES_HUB_INTRO = [
  '本寺小路は決して広い路地ではないが、一晩の過ごし方はいくつもある。深夜まで飲みたい夜、一人でふらりと立ち寄りたい夜、何軒か重ねて歩きたい夜。同じ路地でも、その日の気分によって選ぶ店は変わってくる。',
  'ジャンルだけでは伝わらない、夜の目的別に本寺小路の店をまとめた。',
];
