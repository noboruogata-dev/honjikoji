/**
 * src/lib/omikuji.ts
 *
 * 「本寺小路おみくじ」の格付けテーブル・お告げ文言・抽選ロジック。
 * サーバー処理なし（静的サイト）の前提で、抽選はすべてクライアント側
 * （src/components/OmikujiButton.astro のscript）で行う。ここには純粋な
 * データと関数だけを置き、localStorage・DOM操作などブラウザ依存の処理は
 * 一切含めない（テストしやすく、他の用途にも流用しやすくするため）。
 */

export interface OmikujiRank {
  key: string;
  /** 格付け名（例: 満灯） */
  name: string;
  /** よみ（例: まんとう） */
  reading: string;
  /** 提灯7個中、点灯として表示する数。「主」も演出上は7だが、色・演出を
   *  rare フラグで別扱いにすることで「特別枠」を表現する。 */
  lanternCount: number;
  /** 出現率（%）。全ランクの合計は100になる。 */
  weight: number;
  /** 和の言い回し（例: 百夜に三度） */
  phrase: string;
  /** trueなら「主」。演出・配色を他ランクと変える。 */
  rare?: boolean;
}

// 出現率: 3 + 12 + 25 + 25 + 20 + 10 + 4.5 + 0.5 = 100
export const OMIKUJI_RANKS: OmikujiRank[] = [
  { key: 'manto', name: '満灯', reading: 'まんとう', lanternCount: 7, weight: 3, phrase: '百夜に三度' },
  { key: 'oochouchin', name: '大提灯', reading: 'おおぢょうちん', lanternCount: 6, weight: 12, phrase: '八夜に一度' },
  { key: 'akari', name: '灯', reading: 'あかり', lanternCount: 5, weight: 25, phrase: '四夜に一度' },
  { key: 'tentou', name: '点灯', reading: 'てんとう', lanternCount: 4, weight: 25, phrase: '四夜に一度' },
  { key: 'koakari', name: '小灯', reading: 'こあかり', lanternCount: 3, weight: 20, phrase: '五夜に一度' },
  { key: 'hakumei', name: '薄明', reading: 'はくめい', lanternCount: 2, weight: 10, phrase: '十夜に一度' },
  { key: 'kie', name: '消', reading: 'きえ', lanternCount: 1, weight: 4.5, phrase: '二十夜に一度' },
  { key: 'nushi', name: '主', reading: 'ぬし', lanternCount: 7, weight: 0.5, phrase: '二百夜に一度', rare: true },
];

/**
 * 格付けごとのお告げ文言（各5〜8本）。店名・実在店への言及はしない。
 * 「消」は凶に相当するが突き放さず、別の過ごし方を提示する。
 * 「主」だけ語り口を変え、レア枠らしい特別感を出す。
 */
export const OMIKUJI_TEXTS: Record<string, string[]> = {
  manto: [
    '路地じゅうの提灯が、あなたのために灯る夜。三軒でも、五軒でも歩き通せ。',
    '今夜は主役でいい。断りかけていた誘いにも、乗ってみろ。',
    '財布の紐は緩めていい。今夜だけは、灯りが元を取らせてくれる。',
    '迷ったら、一番灯りの強い店へ行け。今夜はそこが正解だ。',
    '一杯目から、うまい酒に当たる。今夜のあなたは、それだけの引きを持っている。',
    '知らない店の扉を開け。今夜だけは、その勇気に灯りが応える。',
    '朝まで灯りが消えない夜。帰る理由を、今夜は探さなくていい。',
  ],
  oochouchin: [
    '二軒目まで迷わず行け。今夜の勘は当たる。',
    '顔なじみの店より、少し背伸びした店を選べ。今夜は似合う。',
    '奢られたら、次は必ず奢れ。今夜の縁は長く続く。',
    '隣の客と目が合ったら、会釈しろ。今夜はそこから始まる。',
    '三軒目まで灯りをたどれ。締めの一杯が、一番うまい。',
    '今夜の一杯目は、いつもと違う酒を頼め。',
  ],
  akari: [
    '一軒目で長居するな。灯りは奥にもある。',
    'カウンターの端が空いていたら、それはあなたの席だ。',
    '今夜は少しだけ財布を開け。締まり屋の夜は、また今度でいい。',
    '誰かと乾杯しろ。理由は後からついてくる。',
    '帰り道、遠回りしてみろ。灯りが一つ増えているかもしれない。',
    '二軒目に迷ったら、来た道を戻れ。見落とした灯りがある。',
  ],
  tentou: [
    '先客が三人いる店を選べ。多すぎず、少なすぎず。',
    '熱燗を頼め。理由は飲めばわかる。',
    '今夜は聞き役に回れ。悪くない夜になる。',
    'メニューの一番上より、隣の客の皿を見て決めろ。',
    '今夜は奢るより奢られろ。借りは、また今度の酒で返せ。',
    '提灯の色が濃い店を選べ。今夜はそこに用がある。',
  ],
  koakari: [
    '今夜は静かな店を選べ。賑やかさは求めるな。',
    '一杯だけのつもりで、ちょうどいい。',
    '今夜は誰かの話を聞く日。自分の話は明日でいい。',
    '今夜は締めの一杯を先に決めておけ。迷いが減る。',
    '隣の常連の注文を真似しろ。今夜はそれが正解だ。',
  ],
  hakumei: [
    '無理に二軒目を探すな。一軒で満たされる夜もある。',
    '今夜は早めに切り上げろ。灯りは明日も消えない。',
    '「もう一杯」と言いかけて、やめられたら大吉。',
    '今夜は財布の中身を数えてから店に入れ。',
    '一軒で十分な夜もある。無理に灯りを探すな。',
  ],
  kie: [
    '今夜は静かに飲む夜。灯りは、また明日ついている。',
    '早く帰って、湯を沸かせ。それも夜の過ごし方だ。',
    '今夜は家の灯りを消さずに帰れ。それだけでいい夜になる。',
    '財布は閉じておけ。今夜は、飲まない一軒目を探せ。',
    '星を見て帰れ。路地の灯りより、今夜はそっちだ。',
  ],
  nushi: [
    '本寺小路が、あなたを覚えた。今夜、灯りはあなたのために揺れる。',
    '路地の奥で、誰かがあなたを待っている気がする夜。行ってみろ。',
    '千の夜のうち、一夜だけの巡り合わせ。今夜の一杯を、忘れるな。',
    '提灯の灯りが、今夜だけあなたの名を呼ぶ。',
    '今夜だけは、路地があなたの名を覚えている。迷わず、奥まで行け。',
  ],
};

export interface OmikujiResult {
  rank: OmikujiRank;
  text: string;
}

/** 出現率にもとづき、累積分布で1つの格付けを選ぶ。 */
export function drawRank(rand: () => number = Math.random): OmikujiRank {
  const roll = rand() * 100;
  let acc = 0;
  for (const rank of OMIKUJI_RANKS) {
    acc += rank.weight;
    if (roll < acc) return rank;
  }
  // 浮動小数点の誤差でどれにも当たらなかった場合の保険（実質発生しない）。
  return OMIKUJI_RANKS[OMIKUJI_RANKS.length - 1];
}

/** 指定の格付けキーから、お告げ文言を1本ランダムに選ぶ。 */
export function drawText(rankKey: string, rand: () => number = Math.random): string {
  const texts = OMIKUJI_TEXTS[rankKey];
  if (!texts || texts.length === 0) return '';
  return texts[Math.floor(rand() * texts.length)];
}

/** 格付け・お告げ文言をまとめて1回引く。randは2回呼ばれる（格付け→文言）。 */
export function draw(rand: () => number = Math.random): OmikujiResult {
  const rank = drawRank(rand);
  const text = drawText(rank.key, rand);
  return { rank, text };
}

const TIME_ZONE = 'Asia/Tokyo';
/** この時刻（Asia/Tokyo）を境に「今日のおみくじ」が切り替わる。 */
export const ROLLOVER_HOUR = 6;

/**
 * 「おみくじの日付キー」（YYYY-MM-DD）を返す。Asia/Tokyoの午前6時を境に
 * 日付が切り替わる（深夜に飲んでいる人が日付をまたいで引き直せてしまう
 * ことを避けるため）。Intlが使えない極端な環境でもエラーで機能全体を
 * 止めないよう、失敗時はローカル時刻ベースの簡易フォールバックを返す。
 */
export function getOmikujiDayKey(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const year = Number(get('year'));
    const month = Number(get('month'));
    const day = Number(get('day'));
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;
    if (![year, month, day, hour].every(Number.isFinite)) throw new Error('invalid parts');

    const DAY_MS = 24 * 60 * 60 * 1000;
    let dateValue = Date.UTC(year, month - 1, day);
    if (hour < ROLLOVER_HOUR) dateValue -= DAY_MS;
    return new Date(dateValue).toISOString().slice(0, 10);
  } catch {
    // Asia/Tokyo基準の6時切り替えは諦め、UTC基準の日付をそのまま使う
    // （精度は落ちるが、機能自体は動き続ける）。
    return now.toISOString().slice(0, 10);
  }
}
