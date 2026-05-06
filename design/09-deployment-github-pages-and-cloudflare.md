# デプロイ方針 — GitHub Pages ＋ Cloudflare（規範）

## このドキュメントで分かること

- **MVP の「実際の置き場所」**を固定する：フロントは GitHub Pages、API・タイル・定期処理は Cloudflare Workers
- **オリジン分割**（ページのドメインと API のドメインを分ける）の意味と、**`tile_url_template` を絶対 URL にする理由**（初心者向けの小例つき）
- **CORS** を API 側でどう扱うか（規範）
- キャッシュ・シークレット・LINE から開くときの注意の要点

---

本プロジェクトの **MVP における物理配置**を固定する。論理アーキテクチャ（`02`〜`04`）は変えず、**フロントと API を別オリジンに分割**して運用する。

### オリジン分割とは何か（やさしい説明）

**オリジン**は、ざっくり「**プロトコル（https）＋ホスト名＋ポート**」のくくりです。例えば次のふたつは **別オリジン** です。

- フロント: `https://my-org.github.io`（GitHub Pages）
- API: `https://rainmap-api.example.com`（Cloudflare Workers にカスタムドメイン）

ページはフロントから配信されますが、地図用の JSON やタイル画像は **API のドメイン**から取りに行きます。こう分けると、静的ファイルだけを Pages に載せ、**重い処理・キャッシュ・気象庁への取得**は Worker に集約できます。

### `tile_url_template` を「絶対 URL」にする理由（小さな例）

メタデータに **`tile_url_template`** と書いてあるとき、そこに入る文字列は **地図ライブラリがそのまま fetch する URL の型**です。

- **ダメな例（紛らわしい）**: `/tiles/nowc/{frame_id}/{z}/{x}/{y}.png` のような **ルート相対**だけだと、ブラウザは「今いる GitHub Pages のドメイン」に対してパスを足してしまい、**タイルは Pages には存在しない**ため動きません。
- **よい例**: API のドメインから始める **絶対 HTTPS URL** にする。

```text
https://rainmap-api.example.com/tiles/nowc/{frame_id}/{z}/{x}/{y}.png
```

`{frame_id}` などはプレースホルダで、実装が実際の値に置き換えます。こうしておけば、**フロントがどの Pages URL から開かれても**、タイルは常に **API オリジン**を指します（`02` と整合）。

### CORS（この構成で一度だけ整理）

フロント（例: `https://my-org.github.io`）の JavaScript から、別オリジン（例: `https://rainmap-api.example.com`）へ `fetch` すると、ブラウザは **API の応答に CORS 用のヘッダがあるか**を確認します。**Workers（API）が、フロントのオリジンを許可する**設定になっていないと、ブラウザは結果を JS に渡せません。下記の「## 3. CORS（MUST）」がその規範です。

---

## 1. 役割分担（MUST）

次の表は **必ず守る** 役割分担です。フロントにサーバー処理を載せたり、Pages だけで API を代替したりしないでください。

| コンポーネント | ホスト | 役割 |
|----------------|--------|------|
| **クライアント（SPA）** | **GitHub Pages** | 静的ファイル（HTML / JS / CSS / アセット）の配信のみ。サーバサイド処理は行わない。 |
| **API 面**（メタデータ JSON・タイルプロキシ・ヘルス等） | **Cloudflare Workers**（および必要に応じ **Workers KV**・**Cron Triggers**・**Cache API**） | 上流（例: 気象庁）へのフェッチ、レスポンス組み立て、エッジキャッシュ、定期ジョブ。 |

**禁止（MUST NOT）**: GitHub Pages のみでメタ・タイルを提供すること（静的ホストの制約により不可能）。ブラウザから上流データソースを直接無制限フェッチすること（`07`）。

---

## 2. オリジン・URL の約束（MUST）

- **フロントオリジン**（例）: `https://<org>.github.io/<repo>/` または GitHub Pages 用 **カスタムドメイン**。
- **API オリジン**（例）: `https://rainmap-api.example.com`（Workers にカスタムドメインを付与）または開発時は `https://*.workers.dev`。

メタデータの **`tile_url_template`** は、フロントと API が別オリジンであるため、**ルート相対パスではなく API オリジン上の絶対 HTTPS URL** とする（`02` と整合）。

例（論理）:

```text
https://rainmap-api.example.com/tiles/nowc/{frame_id}/{z}/{x}/{y}.png
```

---

## 3. CORS（MUST）

- **Workers（API）** は、**フロントのオリジン**に対してのみ `Access-Control-Allow-Origin` を返す（できれば **許可オリジンの明示リスト**）。資格情報付きリクエストを使わない前提なら `*` は避け、**GitHub Pages の確定 URL** を列挙する。
- **プリフライト**（`OPTIONS`）が必要なメソッド・ヘッダを増やさない（GET 中心で設計済みなら通常は最小）。

---

## 4. Cloudflare 側の論理対応

| 設計上の要素（`03`/`04`） | Cloudflare 上の実装イメージ |
|---------------------------|---------------------------|
| `radar-worker` / スケジューラ | **Cron Triggers** で定期実行（例: `targetTimes_*.json` 取得。宣言更新周期 `T_decl` 以上の間隔＋ジッター） |
| メタ索引・短文フラグ | **Workers KV**（小さく低頻度更新の状態に限定） |
| `TileStore`（キャッシュ） | **Cache API** / **エッジキャッシュ** を主とする。大量タイルバイト列の永続化が必要になった段階で **R2** を検討 |
| `radar-api` | Worker の HTTP ルート（`fetch` ハンドラ） |
| CDN | Worker 応答の `Cache-Control` により **Cloudflare エッジ**がキャッシュ |

**単一プロセス**ではないが、**単一 Worker プロジェクト**（モジュール分割）に論理モジュールをマップする想定とする。

### キャッシュ方針（MUST）

次の各項目は **キャッシュの振る舞い**に関する必須の方針です。

- メタデータ API は短い `max-age` と必要に応じ `stale-while-revalidate` を使い、フレーム追加の反映遅延を小さくする。
- タイル API は `frame_id` を含むパスで内容を不変にし、長めの `max-age` / `immutable` 相当のキャッシュを許容する。
- `coverage` 外や上流欠損の `404` は短い TTL にし、公開直後の一時欠損を長時間固定化しない。
- KV にはメタ索引・最終成功時刻・連続失敗などの小さな状態を置き、高頻度タイルバイト列の恒常保存先にしない。

---

## 5. GitHub Pages 側

- **ビルド**: リポジトリ内の SPA を GitHub Actions でビルドし、`gh-pages` ブランチまたは **GitHub Actions Pages** で公開してよい。
- **設定**: API のベース URL は **ビルド時環境変数**（例: `VITE_API_BASE_URL`）で注入し、**リポジトリに秘密値をコミットしない**。上流プロバイダ向けの秘密は **Cloudflare にのみ**置く（下記）。

---

## 6. シークレットと環境分離（MUST）

- **上流 API キー**（将来必要になった場合）・**本番フラグ**は **Wrangler `secret` / Cloudflare ダッシュボード**で管理する。
- **本番でフェイクプロバイダを有効にしてはならない**（`01`）。Worker の環境名に応じたガードを実装すること。

---

## 7. LINE Bot 連携（参考）

- LINE から開く URL は **フロント（GitHub Pages）の HTTPS URL** でよい（例: `https://<pages>/rainmap/?lat=...&lon=...`）。読み込み後、ブラウザが **API オリジン**へメタ・タイルを取得する。
- 詳細は `07-concrete-sources-and-line-bot-integration.md`。

---

## 8. 代替構成（informative）

- **Cloudflare Pages にフロントも寄せる**構成は、同一ゾーンで CORS が減るが、本プロジェクトの **規範は GitHub Pages 優先**とする。
- **VPS 常時プロセス**は、無料枠や運用方針に応じて将来の代替としてよい。

---

## 変更履歴

- rev.1: GitHub Pages ＋ Cloudflare を規範デプロイとして追加
- rev.2: Cache API/KV/R2 の役割分担、`coverage` 外欠損の短期キャッシュ、`T_decl` 準拠の Cron 方針を追記
