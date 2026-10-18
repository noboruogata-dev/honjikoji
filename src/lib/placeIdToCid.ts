/**
 * src/lib/placeIdToCid.ts
 *
 * Google Place ID（"ChIJ..."形式）から、Googleマップの埋め込みで「その1件の
 * 掲載だけ」を指せる cid（10進数文字列）を取り出す。
 *
 * 店名・住所の検索クエリで埋め込むと、移転前の古い掲載と移転後の掲載の
 * 両方にピンが立つことがある（Osteria Kissui tei で発生）。Place ID に
 * 対応するcidで埋め込めば、保存済みの1件だけが表示される。
 *
 * "ChIJ"形式のPlace IDは、base64urlでデコードすると
 * 0x0A 0x12 0x09 <8byte: FIDの上位> 0x11 <8byte: FIDの下位> の20バイトで、
 * 下位8バイトをリトルエンディアンの符号なし整数として読んだものがcid。
 * 形式が想定と違う場合は null を返し、呼び出し側は従来の検索クエリに
 * フォールバックする。
 */
export function placeIdToCid(placeId: string): string | null {
  if (!/^ChIJ[A-Za-z0-9_-]{23}$/.test(placeId)) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(placeId, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 20 || bytes[0] !== 0x0a || bytes[2] !== 0x09 || bytes[11] !== 0x11) return null;

  return bytes.readBigUInt64LE(12).toString();
}
