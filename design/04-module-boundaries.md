# モジュール境界と責務

## このドキュメントで分かること

- **ヘキサゴナル（ポート＆アダプター）／クリーンアーキテクチャ**に近い考え方で、Rainmap を **domain（ルール）・application（ユースケース）・adapters（外部接続）** にどう分けるか
- 論理モジュール（`radar-domain` など）の**責務**と、**依存してはならないもの**
- **`radar-catalog` と `radar-api` の線引き**、パススルー時の `TileStore`、失敗時の観測、`coverage` の責務

---

## はじめに：用語のイメージ（初心者向け）

- **domain（ドメイン）**  
  「**ビジネスルールだけ**」の層です。時刻の比較、座標やタイル番号の計算、値の妥当性など、**外部サービスや HTTP に依存しない純粋なロジック**を置きます。テストも書きやすいです。

- **application（アプリケーション）**  
  「**ユースケースを組み立てる**」層です。たとえば「フレームを取り込んで正規化する」「公開済みとして索引に載せる」といった**手順**を domain 型とポート（インターフェース）でつなぎます。

- **adapters（アダプター）**  
  「**外部との接続**」です。HTTP クライアント、KV/R2、プロバイダごとのフォーマット解釈など、**入出力の差し替え可能な実装**をここに閉じます。プロバイダを差し替えても、domain の式は変えない、という狙いです。

このドキュメントの「依存は内向き」は、**外側（HTTP・DB）が内側（ルール）に依存し、ルールが HTTP の詳細に依存しない**という意味です。

---

## 原則

- **依存方向は内向き**: `domain（降水・時刻・BBox）` ← `application（ユースケース）` ← `adapters（HTTP・ストレージ・プロバイダ）`
- **フレームワークにドメインを引きずらない**: Web 層は入出力の変換のみ
- **プロバイダごとの差分は adapter に閉じる**: 正規化後は共通型のみを渡す

---

## モジュール一覧（論理）

| モジュール | 責務 | 依存してはならないもの |
|------------|------|------------------------|
| `radar-domain` | 時刻、座標系、値域、タイル座標の純粋関数 | IO、HTTP、DB ドライバ |
| `radar-ingest` | フェッチ、検証、正規化オーケストレーション | UI、地図 SDK |
| `radar-render` | ラスタ→PNG/WebP タイル | プロバイダ固有フォーマット |
| `radar-catalog` | 利用可能時刻索引、メタデータ組み立て | クライアント |
| `radar-api` | REST ルート、認可（将来）、HTTP バリデーション・ステータスコード対応 | プロバイダ SDK 詳細 |
| `radar-worker` | スケジュール、再試行、ジョブ状態 | ルーティング詳細 |

**つまり**: 左ほど「ルールとデータの形」、右ほど「HTTP やクラウドの都合」。真ん中の ingest / render / catalog / worker が手順と索引をつなぐイメージ。

MVP では **単一リポジトリ**としても、上記は**ディレクトリまたはクレート／パッケージ**で分離可能な粒度とする。

**本プロジェクトの配置（informative）**: フロントはリポジトリ内の `docs/` または `web/` 等を **GitHub Pages 用にビルド**し、API は `worker/` 等を **Wrangler で Cloudflare にデプロイ**する構成を想定（規範は `09`）。

---

## `radar-catalog` と `radar-api` の境界（規範）

| 担当 | してよいこと | してはならないこと |
|------|----------------|---------------------|
| `radar-catalog` | `stale` の判定、`coverage`・`frames`・`zoom_range` の組み立て、索引の読み取り、ドメイン型での出力 | HTTP ステータスやヘッダの選択、`Accept` による内容切替 |
| `radar-api` | リクエスト検証、**catalog が返したドメインオブジェクトを JSON に変換**、404/503 のマッピング | プロバイダ固有の生レスポンスの解釈、`stale` の業務ルールの再実装 |

**つまり**: 「**何が古いか・メタの中身は何か**」は catalog が唯一の真実（single source of truth）。API は「HTTP としてどう返すか」に専念する。

**ETag / Cache-Control**: **API 層**が HTTP セマンティクスを付与してよいが、**メタデータの意味的内容**は catalog の出力のみを真実とする。

---

## パススルータイル時の `TileStore` 書き込み（規範）

- **プロバイダがタイル URL を返すタイプ**（パススルー）: `RadarProvider` の adapter がバイト列を取得し、**`radar-ingest` が `TileStore.put` を呼ぶ**。adapter は **ストレージを直接触ってはならない（MUST NOT）**（テストダブルを差しやすくする）。
- **プロバイダがラスタを返すタイプ**: `radar-ingest` が正規化後ラスタを `radar-render` に渡し、生成されたタイルを **`radar-render` が `TileStore.put`** する。ingest はタイルバイト列を知らない。

**つまり**: 「ディスク／オブジェクトストアに書く」責務は **ingest か render のどちらか**に固定し、adapter は取得・変換に集中する。

---

## 失敗時の観測（規範）

- `radar-worker` はジョブ失敗を **構造化ログ**に出す（相関 ID 付き）。catalog がログを直接読んではならない（MUST NOT）。
- **フレーム索引（公開済み `frames` の元データ）**の永続化は、パイプライン成功時にワーカーが **`radar-catalog` のユースケース**（例: `record_published_frame`）を呼び出し、**catalog 配下のリポジトリ adapter** が書き込む（`03` の「メタデータ更新」と整合）。
- **鮮度・デグレード用の短文フラグ**（例: `pipeline_degraded`、連続失敗カウンタ）は、ワーカーまたは ingest が **状態ストア**へ書き込み、catalog はメタデータ組み立て時に **そのストアだけを読んで** `stale` に反映してよい（SHOULD）。

---

## coverage の責務（規範）

- `RadarProvider.capabilities()` は、サポートする `zoom_range` と **coverage 候補**（bbox または provider 固有のタイル範囲）を返す。
- `radar-domain` は provider 固有表現を **EPSG:4326 の `coverage.bbox` と XYZ タイル範囲**へ変換する純粋関数を持つ。
- `radar-catalog` は provider の coverage と公開済みフレーム索引を合成し、メタデータの `coverage` を出力する。API 層が coverage を独自計算してはならない（MUST NOT）。

**つまり**: 地図の「どの範囲を約束するか」の最終形は **catalog が組み立て**、API はそれを JSON に載せるだけ。

---

## 置換可能性

- `RadarProvider` インターフェース: `list_frames()`, `fetch_frame(id)`, `capabilities()`（zoom と coverage を含む）
- `TileStore` インターフェース: `get`, `put`, `delete_prefix`
- `Clock` / `Scheduler` を注入し、テストで決定性を確保

---

## MVP 実装での物理配置（informative）

論理モジュール（上表）は **単一 Cloudflare Worker プロセス**（`worker/src/index.ts` を中心に `catalog.ts`・`domain.ts`・`provider.ts`）に集約されている。別パッケージやマイクロサービス分割は行っていない。

- **「公開記録」用の二次索引**や **`TileStore.put` 前提のパイプライン**は未実装。代わりに **KV 単一キー**（スナップショット JSON）＋ **タイル GET 時の上流プロキシ**。
- **`stale`**: 専用カウンタストアではなく **スナップショット `fetchedAtMs` とエントリ有無**から算出（詳細は `02` / `03` MVP 差分）。

---

以下は設計の**変更履歴**です。

**要約**: モジュール間の禁止知識を表で固定し、TileStore の呼び出し分担・catalog の coverage 責務・ワーカー失敗から stale への経路を明確化した記録です。

## レビュー反映（rev.2）

- `radar-worker` が `radar-ingest` と循環しやすいため、**ジョブペイロード（DTO）を `radar-domain` に置く**ことで循環依存を禁止する。
- `radar-render` は **「投影変換が必要な場合のみ」**起動するパスを明文化（ソースが既に WebMercator タイルならパススルー adapter）。

## レビュー反映（rev.3）

- catalog / api の **禁止知識**を表で固定。
- パススルー vs レンダーで **`TileStore.put` の呼び出し主人**を分割。
- ワーカー失敗から **stale** への経路を、ログ直読みなしで記述。

## デプロイ反映（rev.7）

- `radar-worker` は **Cloudflare Cron + Worker 内のオーケストレーション**にマップしてよい（論理境界は維持、`09`）。

## 最適化反映（rev.8）

- メタデータの `coverage` を catalog の責務に加え、provider 差分を API 層へ漏らさない境界を明確化した。

## 実装同期反映（rev.9）

- **単一 Worker** への集約・**KV スナップショット＋タイルプロキシ**の現状を informative に追記。
