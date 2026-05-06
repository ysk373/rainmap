# 具体データソースと LINE Bot 連携（推奨パターン）

## このドキュメントで分かること

- 雨レーダー風の地図を作るとき、**どのデータソースを選ぶか**（気象庁の無料 Web 配信・正式ルート・他サービス）の整理
- **なぜブラウザではなくバックエンド（サーバー／Worker）が気象庁などに取りに行くのか**、および **CORS** が何の話か（下記の短い説明）
- **LINE Bot から Web アプリの URL を開く**ときのおすすめの流れ（URI アクション・LIFF・位置情報の注意）
- 案 A（防災気象 jmatile 系）を選んだときの**実装の大まかな手順**

---

### なぜ「バックエンドがフェッチ」なのか（気象庁 URL・LINE 連携の文脈）

1. **負荷とマナー**  
   地図を動かすたびにタイル画像が大量に必要になります。それを**各ユーザーのブラウザが気象庁の URL に直接何度もアクセス**すると、公式サーバーへの負荷が大きくなりすぎます。**一度 Worker などに集約**し、キャッシュや取得間隔を守る方が安全です。

2. **URL を隠し、契約どおりに配る**  
   設計では、フロントは**自前 API が返すタイル URL だけ**を知り、気象庁の生 URL はクライアントに晒しません（`02`・`09` と整合）。規約・表示（帰属）もコントロールしやすくなります。

3. **ブラウザから直叩きしにくい／すべきでない事情**  
   公式側の設定によっては、**別ドメインから JavaScript で画像を取りに行く**とブラウザがブロックすることがあります。これが **CORS（Cross-Origin Resource Sharing）** の話です。簡単に言うと、「`https://A` のページから `https://B` へプログラムでデータを取りに行くとき、B のサーバーが『A からなら OK』とヘッダで許可しているか」で成否が決まります。**自前 API は CORS を自分で設定できる**ため、GitHub Pages 上のフロントからメタ・タイルを安定して取得しやすくなります。

LINE から開いた Web アプリも同じで、**ページは GitHub Pages**、**データ取得は Workers（別ドメイン）** になり、**API 側で CORS を許可する**必要があります（`09`）。

---

前提: **ライフライン用途**でも、データの**利用規約・二次利用・商用可否**はソースごとに異なる。以下は技術的なおすすめの組み合わせであり、**公開前に各公式の条件を確認すること（必要なら気象庁・事業者へ問い合わせ）**。

物理ホスティングは **`09-deployment-github-pages-and-cloudflare.md`** に従う（**GitHub Pages + Cloudflare Workers**）。

---

## 1. データソースの現実的な選択肢

### A. 気象庁・防災気象（高解像度降水ナウキャスト）タイル — **日本の「雨雲レーダー」に最も近い無料 Web 配信**

防災気象ページで使われている **PNG タイル**と、更新時刻を返す **JSON** が、ブラウザ向けに公開されている（コミュニティにより URL 構造が整理されている）。設計上は **`RadarProvider` の 1 実装**として扱う。

| 用途 | URL の例（論理） | 備考 |
|------|------------------|------|
| 解析・予報の対象時刻一覧 | `https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json`（解析含む系列） | 実装ではレスポンスをパースし `basetime` / `validtime` を列挙 |
| 別系列の対象時刻 | `https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json` | N1 / N2 の役割は実装時に公式ページ・既存実装と突き合わせる |
| タイル画像 | `https://www.jma.go.jp/bosai/jmatile/data/nowc/{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png` | Web メルカトル系のズーム／タイル座標（コミュニティ記事では z は粗い段階に限定されることが多い） |

**実装のおすすめ**

1. **バックエンドだけ**が `jma.go.jp` にアクセスする（キー不要・ブラウザに直接タイル URL を晒さない）。
2. 5 分更新に合わせ、**`targetTimes_*.json` を宣言周期 `T_decl` 以上の間隔でポーリング**し、メタデータ API（自前）の `frames[]` と `coverage` を組み立てる（`03`）。
3. タイルは **プロキシ＋キャッシュ**（`03` のオンデマンド／TTL と整合。**本プロジェクトでは Cloudflare Cache API / エッジキャッシュを主経路、KV はメタ索引・状態、`09`**）。同一タイルの無制限再取得を避け、**気象庁サーバへの負荷**を抑える。
4. UI に **「出典：気象庁」** 等、公式が求める表示を載せる（`02` の `provider_attribution` を活用）。

**リスク・注意**

- URL や JSON 形式は**無告知で変わりうる**。adapter に **バージョン分岐**と監視（404 急増）を用意する。
- **自動取得・再配布が利用規約で許される範囲**は、防災気象情報の利用条件・サイトポリシーで確認する。**LINE 経由の自作アプリは「公開サービス」に該当しうる**ため、特に慎重に。

### B. 気象庁情報カタログ → 気象業務支援センター（GRIB2 等）— **正式ルート・大量利用向け**

ナウキャスト等の**バイナリ格子データ**を契約・手続きのうえで取得するルート（詳細は [気象庁データガイド（降水等のナウキャスト）](https://www.data.jma.go.jp/developer/weatherdataguide/appendix/2-1-b.html) および [気象庁情報カタログ](https://www.data.jma.go.jp/suishin/cgi-bin/catalogue/make_product_page.cgi?id=Nowcast)）。

**実装のおすすめ**: GRIB2 を **eccodes / cfgrib** 等でデコード → 内部ラスタ → **自前タイル化**（`04` の `radar-render` パス）。コスト・契約・運用は重いが、**コンプラと安定供給**を取りにいくならこちら。

### C. Rain Viewer API — **実装は楽だが用途が狭い**

[Rain Viewer API](https://www.rainviewer.com/api.html) は **personal and educational use only** と明示されている。**ライフライン LINE Bot 連携のような公開サービス**がこれに含まれるかはグレーであり、**商用・組織運用では契約・別ライセンスの確認が必須**。無料枠の機能・レート制限も変わりやすい。

### D. Open-Meteo（JMA モデル降水など）— **「レーダー」ではない**

[Open-Meteo JMA API](https://open-meteo.com/en/docs/jma-api) はモデル由来の降水などを返せるが、**観測レーダーの合成画像ではない**。「雨雲レーダー風 UI」より **予報レイヤ**として割り切るなら選択肢。

---

## 2. 本命のおすすめ（結論）

次の表は「何を第一候補にするか」の整理です。技術的な詳細は各節を参照してください。

| 優先 | 内容 |
|------|------|
| **技術・UX・日本向けの一致** | **案 A（防災気象 jmatile 系）** を `RadarProvider` で実装し、自前バックエンドでキャッシュ配信。メタは `targetTimes_*.json` 駆動。 |
| **コンプラ・契約の明確さ最優先** | **案 B（カタログ／支援センター）** に切り替え可能な抽象は維持する（既存設計どおり）。 |
| **避けるべき** | ブラウザから公式タイルを直接無限取得する（負荷・規約・CORS）。Rain Viewer を **規約未確認のまま**ライフライン公開で使う。 |

---

## 3. LINE Bot（別プロジェクト）から URL で繋ぐ実装

LINE は地図 SDK をホストしないため、**HTTPS の Web アプリ URL を開く**形が素直である。

### 推奨フロー

1. **rainmap Web（静的 UI）** を **GitHub Pages** で公開する（例: `https://<org>.github.io/<repo>/` または Pages のカスタムドメイン）。
2. LINE 側は **Messaging API** の [URI アクション](https://developers.line.biz/ja/reference/messaging-api/#uri-action) または Flex / テキスト内 URL で誘導する。**リンク先はフロントの URL** とする（API オリジンではない）。
3. URL に **緯度経度・初期ズーム**を載せる（自前契約の範囲で OK なら）:  
   `https://<org>.github.io/<repo>/?lat=35.681236&lon=139.767125&z=10`
4. Web アプリ起動時にクエリを読み、地図の `center` を設定する。**メタデータ API** はビルド時に注入した **Cloudflare Worker のベース URL** に対して fetch する（`09`, `05`）。

### LIFF（任意）

アプリ内ブラウザで LINE 内に閉じたい場合、[LIFF](https://developers.line.biz/ja/docs/liff/overview/) から **GitHub Pages上の同一 SPA** を開く。**オリジンは Pages のまま**のため、API 呼び出しは引き続き **Workers へのクロスオリジン**になり **CORS が必要**（`09`）。初期位置がユーザーに紐づく場合は **プライバシーポリシー**と最小データの原則を守る。

### deep link で bot と連携したい場合

- **LINE の仕様上**、Bot はユーザーの正確な緯度経度を勝手に取れない（送信してもらう／別途同意した位置情報メッセージを使う等）。  
- 「現在地で見る」は **Web 側で Geolocation API**（ユーザー許可）が現実的。

---

## 4. 実装スケッチ（案 A を選んだとき）

1. **ワーカー**: `targetTimes_N1.json`（と必要なら N2）を、プロバイダの宣言更新周期（例: 5 分）以上の間隔＋ジッターで取得 → `frames[]` 用の論理 ID（例: `{basetime}-{validtime}`）を生成。
2. **メタデータ API**: `tile_url_template` を **API オリジン上の絶対 URL** とする（例: `https://rainmap-api.example.com/tiles/nowc/{frame_id}/{z}/{x}/{y}.png`）。クライアントは気象庁 URL を知らない（`02`, `09`）。
3. **coverage**: 日本域など provider が保証する範囲を `coverage.bbox` としてメタデータに載せ、UI はオーバーレイ要求をその範囲に絞る。
4. **タイルハンドラ**: `frame_id` と z/x/y で upstream PNG を取得し、存在すれば Cache API / エッジキャッシュに載せて返す。欠損時は `404` としメタの `coverage`・`zoom_range` と整合させる（ズームは公式が返す範囲に合わせ、過剰 z はメタで抑制）。
5. **フロント**: MapLibre GL または Leaflet + OSM 等ベースマップ + PNG オーバーレイ。帰属表示に気象庁を含める。

---

## 5. 設計書との対応

- 上流抽象: `04` の `RadarProvider`
- 公開順序・キャッシュ: `03`
- メタデータ契約・帰属: `02`
- ホスト構成: `09-deployment-github-pages-and-cloudflare.md`（規範）、`06`, `08`

---

## 変更履歴

- rev.1: 気象庁 jmatile 系・カタログ・Rain Viewer・LINE URL/LIFF の具体化
- rev.2: **GitHub Pages + Cloudflare** を規範に合わせ、LINE のリンク先・`tile_url_template` 絶対 URL・LIFF／CORS を追記
- rev.3: `T_decl` 準拠のポーリング、`coverage`、Cache API 主体のタイルキャッシュへ整合
