# OGP画像生成用フォント（サブセット済み）

`scripts/generate-ogp-images.ts`・`scripts/lib/instagramMaterialAgent.ts`
（どちらもsatori経由）が使う日本語フォント。どちらも**サブセット済み**で、
フルセットのGoogle FontsからJIS X 0208（第1水準・第2水準漢字）相当＋
かな＋英数字を抜き出してある。

| ファイル | 由来 | フルセットのサイズ | サブセット後 |
|---|---|---|---|
| `ShipporiMincho-Bold-subset.ttf` | Shippori Mincho Bold (700) | 8.56 MB | **3.82 MB** |
| `NotoSansJP-Regular-subset.ttf` | Noto Sans JP（可変フォントをwght=400で静的化） | 5.77 MB（静的化後） | **2.56 MB** |

合計約6.4MB（旧: 常用漢字ベースの2,470字構成で合計2.36MB）。

ライセンスはどちらも [SIL Open Font License](https://openfontlicense.org/)
（Google Fontsで配布されているものと同じ）。再配布・改変（サブセット化含む）
は許諾されている。

## なぜサブセット化したか

satoriはブラウザのCSS `@font-face`のような遅延読み込みができず、レンダリング
に使うフォントの実バイナリを丸ごとメモリに読み込む必要がある。日本語フォント
はフルセットだと1書体あたり5〜9MBあり、店舗・コラム・ニュースの3種類×
複数書体をリポジトリにそのままコミットするとリポジトリが大きく太ってしまう
ため、実際に使う可能性が高い文字だけに絞った。

## サブセットの文字範囲

`subset-charset.txt` に実際に使った文字（6,992字）がそのまま入っている。
内訳:
- **JIS X 0208 全域（6,879字）**: 区1-8（記号・英数・かな等）＋区16-47
  （第1水準漢字）＋区48-84（第2水準漢字）。EUC-JPの区点コードを全域
  走査して有効な符号位置をUnicodeにデコードして収集した（Pythonの
  `codecs`標準ライブラリのみで再現可能。外部の文字リストに依存しない）。
  第2水準まで含めることで、店名・地名に使われがちな旧字体・異体字・
  人名用漢字（「烹」「嶋」「粋」「亭」等）を広くカバーする。
- 旧サブセット（常用漢字2,136字＋実コンテンツ由来の文字）との和集合を
  取っているため、以前カバーしていた文字が漏れることはない。

これでも、JIS X 0208にすら無い外字・異体字（第3・第4水準漢字、機種依存
文字、絵文字等）は依然としてカバーできない。そのため「文字が足りなく
なったら」ではなく「足りない可能性は常にある」前提で、
`scripts/lib/ogpImage.ts` の `checkGlyphCoverage()` が実際に描画する
文字列をレンダリング前に検査し、フォントに無い文字があれば検出する
（呼び出し側で生成をスキップし、ログ・Job Summaryに警告を残す。
「文字化けした画像が黙って本番に出る」状態を防ぐための仕組み。
詳細は該当関数のコメント、および `scripts/generate-ogp-images.ts` ・
`scripts/lib/instagramMaterialAgent.ts` での呼び出し箇所を参照）。

## それでも文字が足りなくなったら（今後のメンテナンス）

`checkGlyphCoverage()` が欠字を検出すると、`scripts/generate-ogp-images.ts`
はその1件だけ生成をスキップして `ogp-default.png` に自動フォールバックし
（サイト全体が壊れることはない）、`scripts/lib/instagramMaterialAgent.ts`
はInstagram素材の準備自体をスキップする。どちらもログと
GitHub ActionsのJob Summaryに警告が残るので、それを見て以下の手順で
サブセットを作り直す:

```bash
pip install fonttools
# 1. Google Fontsから元のフルセットフォントを取得
#    https://github.com/google/fonts/raw/main/ofl/shipporimincho/ShipporiMincho-Bold.ttf
#    https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf
# 2. Noto Sans JPは可変フォントなので、まず静的化する
fonttools varLib.instancer -o NotoSansJP-Regular-static.ttf NotoSansJP-Regular.ttf wght=400
# 3. subset-charset.txt に必要な文字を追記してから、サブセット化する
pyftsubset <元フォント> \
  --text-file=subset-charset.txt \
  --output-file=<出力ファイル名> \
  --layout-features='*' --glyph-names --symbol-cmap --legacy-cmap \
  --notdef-glyph --notdef-outline --recommended-glyphs \
  --name-IDs='*' --name-legacy --name-languages='*'
```
