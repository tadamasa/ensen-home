# 縁泉(ホーム画面アプリ)

iPhoneのホーム画面から開く、自分用の縁泉。https://tadamasa.github.io/ensen-home/

縁泉は「縁の生起」(人・場所・作品・モノ・食 × 関係動詞7語)を記録するライフログです。このアプリは、入力よりも**後から掘る**ほうに重心を置いています。

- **泉**: カレンダーで日を選ぶと、その日の縁・写真の痕跡・家の出入りが一本の流れで並びます。縁ごとに「谺」(同じ相手と前に結んだ日)が出ます。痕跡は「縁にする」で記録に昇格。下に、その日の日記・読み終えた本・観た映画。
- **結ぶ**: 種別・名前・動詞・ひとこと・★・写真。台帳との照合で「再会」を提案し、近くの前に結んだ場所を候補に出します。「試すことに」で霧の中に置く(期限なし)。
- **眺める**: 縁の地図(国土地理院の淡色地図、点を押すとその場所との縁の履歴)、初出の川、再会の川(間が空くほど高い弧)、霧の中へ、評価の間、遠い対(Gemini)。霧の中へでは、7月にブクログから取り込んだ「読みたい」を「読書メモで管理している読みたい」の折りたたみに分けます(消さない・状態も変えない。そこから「試した」「手放す」も押せ、読書メモで突き合わせる CSV を書き出せます)。
- **設定**: 縁泉ハブ、泉の四季(暦と時刻で移ろう)、Gemini、バックアップ。

スコア・連続記録・通知はありません。

データは端末の IndexedDB が正本で、圏外でも開けて書けます。いまの縁泉スプレッドシートを縁泉ハブとして同期します(`hub/`)。縁泉のGASアプリやiOSショートカットで入った縁も届きます。

構成は読書メモ(tadamasa/reading-memo の docs/home-app-architecture.md)・日記(tadamasa/diary-home)と同じです。地図は Leaflet 1.9.4(BSD-2、`vendor/leaflet/`)。

## 他アプリとの約束

縁泉ハブ(`hub/Code.gs`)と、このアプリが読み書きするところ。列の名前や形を変えるときは、ここに書いた相手に響きます(2026-11-02 時点)。

| 相手 | シート | 列 | 読む/書く |
|---|---|---|---|
| 縁泉 `ensen` | events | 16列すべて(event_id … enrich) | 読む・追記だけ(source=home) |
| 縁泉 `ensen` | intents | 9列すべて。enrich の `src_id`(ブクログ取込は `booklog:<itemId>:読みたい`)と `keys.isbn` をアプリへ渡す | 読む・追記・status と fulfilled_event_id だけ本人の操作で書く |
| 縁泉 `ensen` | appraisals / actants / traces / place_names / spot_fixes | 各シートの全列 | 読む・追記(actants は last_seen・count も更新) |
| 縁泉 `ensen` | _sync | kind, id, rev, mtime, deleted, hash | このハブ専用 |
| 読書ハブ | books, notes | 共通ライブラリ DayReaders が見出しで引く(books: id, deleted, title, author, status, category, finishedAt, json / notes: deleted, bookId, text) | 読むだけ |
| 映画ハブ | views, films | DayReaders が見出しで引く(views: deleted, date, filmId, filmTitle, place, venue, score, text / films: id, title, year, directors, json) | 読むだけ |
| 日記の記録 | CoreData | DayReaders が見出しで引く(Date, Time, Text, Feelings, Thinkings) | 読むだけ |

- **共通ライブラリ**: DayReaders(tadamasa/diary-home の `lib/day-readers`)、スクリプトID `1AERbCrDNFVHKT1YDCTSensHNs4X8QrACyaS-p3xDFhqrUq2r7NGMuMwk`、**版 1** を固定(`hub/appsscript.json`)。使う関数は diaryForDate・booksForDate・filmsForDate・monthMarks。
- **spot_fixes の約束**(旅先も読む): ts は `yyyy-MM-dd'T'HH:mm:ss+09:00` にそろえ、文字列のまま比べる。同じ台帳はいちばん新しい行、同じ秒なら後に追記された行が勝つ。詳しくは [hub/README.md](hub/README.md#spot_fixes-を読む相手旅先との約束)。
- **events.source**: 縁泉GASの夜間取込で `reading`(読書メモの読了)・`movie`(映画メモの鑑賞)が入る。泉では「読書メモ」「映画メモ」と出す。
- **読書メモ**(https://tadamasa.github.io/reading-memo/): 「読みたい」は読書メモに一本化。霧の中への「一覧を書き出す」は CSV(UTF-8、見出し `itemId,isbn13,title,status`)。itemId はブクログのアイテムID(ISBN10 か ASIN)で、読書メモの本の json にある同じ値と完全一致で突き合わせる。isbn13 は enrich の keys.isbn のまま(無いときは空。`B000PTYQZ6` は映像ソフトの JAN)。

## 開発

```
npm run serve   # http://localhost:8766/
npm test        # ハブ(Code.gs)を模擬環境で動かすテストを含む
```

出すたびに `sw.js` の `VERSION` を上げ、ファイルを足したら `SHELL` にも足します。
