# OGP画像生成用フォント（サブセット済み）

`scripts/generate-ogp-images.ts`（satori）が使う日本語フォント。どちらも
**サブセット済み**で、フルセットのGoogle Fontsから常用漢字＋かな＋英数字＋
実際のリポジトリ内コンテンツで使われている文字だけを抜き出してある。

| ファイル | 由来 | フルセットのサイズ | サブセット後 |
|---|---|---|---|
| `ShipporiMincho-Bold-subset.ttf` | Shippori Mincho Bold (700) | 8.56 MB | **1.39 MB** |
| `NotoSansJP-Regular-subset.ttf` | Noto Sans JP（可変フォントをwght=400で静的化） | 5.77 MB（静的化後） | **0.97 MB** |

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

`subset-charset.txt` に実際に使った文字（2,470字）がそのまま入っている。
内訳:
- 常用漢字 2,136字（[joyo-kanji-list (KEINOS)](https://gist.github.com/KEINOS/fb660943484008b7f5297bb627e0e1b1) の2010年版データより）
- ひらがな・カタカナ（Unicodeブロック全体）
- ASCII印字可能文字（英数字・半角記号）
- よく使う日本語の句読点・記号（「」『』・〜ー￥（）など）
- 生成時点で `src/content/{spots,news,columns}/*.md` のFrontmatterに
  実際に登場していた文字（店名・ジャンル・カテゴリ等の安全網）

## 文字が足りなくなったら（今後のメンテナンス）

新しい店舗・コラム・ニュースのタイトルに、上記のどれにも含まれない文字
（常用漢字外の人名用漢字や旧字体など）が使われた場合、
`scripts/generate-ogp-images.ts` はその1件だけ生成に失敗し、
`ogp-default.png` に自動フォールバックする（サイト全体が壊れることはない）。
ビルドログに `[generate-ogp-images] ... の生成に失敗しました` という警告が
出るので、それが増えてきたら以下の手順でサブセットを作り直す:

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
