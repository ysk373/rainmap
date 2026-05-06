# rainmap — 雨雲レーダー（設計＋MVP 実装）

自作の雨雲レーダー向け領域です。**設計書**（`design/`）に沿い、MVP として次を同梱しています。

| パス | 内容 |
|------|------|
| [design/00-index.md](design/00-index.md) | 設計書索引 |
| `worker/` | **Cloudflare Workers** — メタデータ API・タイルプロキシ・Cron・KV |
| `web/` | **静的フロント（Vite + Leaflet）** — GitHub Pages 向けビルド |

## 規範スタックとの対応（要約）

- **フロント**: GitHub Pages 用に `web/` を `npm run build` → `dist/` を公開
- **API**: `worker/` を Wrangler で Cloudflare にデプロイ
- **契約**: `GET /api/v1/radar/meta` が [design/02-system-architecture.md](design/02-system-architecture.md) の v1 メタデータを返す
- **タイル**: `tile_url_template` は **API オリジン上の絶対 URL**（`API_PUBLIC_ORIGIN` 推奨）
- **上流**: 気象庁防災気象 `targetTimes_N1.json` と HRPNs タイル（利用条件は公式で確認）
- **本番でフェイク禁止**: `ENVIRONMENT=production` かつ `FAKE_PROVIDER=true` のとき **503**（[design/01-requirements-and-scope.md](design/01-requirements-and-scope.md)）

## ローカル開発

### 1) Worker

```bash
cd worker
npm install
# wrangler.toml の [[kv_namespaces]] id を実 KV に差し替え（下記「初回セットアップ」）
npx wrangler dev
```

- メタ: `http://127.0.0.1:8787/api/v1/radar/meta`
- ヘルス: `http://127.0.0.1:8787/healthz`

**開発環境**（`ENVIRONMENT` が `production` 以外）では、KV が空のとき **初回のメタ取得で JMA を直接フェッチ**してスナップショットを埋めます（ローカル体験用）。

**本番**（`ENVIRONMENT=production`）では、KV が空のときメタは **`503 warming_up` + `Retry-After`** を返します。初回は **Cron（最大 5 分）**で KV が埋まるまで待つか、手動で `wrangler dev` / 一時的に非本番でウォームアップしてください。

**フェイクプロバイダ**（上流に繋がないテスト）:

```bash
FAKE_PROVIDER=true npx wrangler dev
```

### 2) Web

```bash
cd web
cp .env.example .env
# .env の VITE_API_BASE_URL を Worker のオリジンに合わせる
npm install
npm run dev
```

- LINE 連携用クエリ例: `http://localhost:5173/?lat=35.68&lon=139.76&z=6`（[design/07](design/07-concrete-sources-and-line-bot-integration.md)）

### 3) GitHub Pages 用ビルド

リポジトリが `https://<org>.github.io/<repo>/` のとき、`VITE_BASE_PATH` は通常 `/<repo>/` です。

```bash
cd web
VITE_API_BASE_URL=https://<your-worker-host> VITE_BASE_PATH=/<repo>/ npm run build
```

`dist/` を Pages の公開ルートにアップロードします（Actions 例は `.github/workflows/deploy-pages.yml`）。

## 初回セットアップ（Cloudflare）

1. `cd worker && npx wrangler kv namespace create RADAR_KV`
2. 表示された **id** を `wrangler.toml` の `[[kv_namespaces]].id` に貼る（`preview_id` はローカル用に別作成可）
3. **本番**では `wrangler.toml` の `[vars]` を上書きするか、ダッシュボードで設定:
   - `ENVIRONMENT=production`
   - `ALLOWED_ORIGINS=https://<org>.github.io`（必要なら `https://<org>.github.io/<repo>` も）
   - `FAKE_PROVIDER=false`
   - `API_PUBLIC_ORIGIN=https://<worker の公開オリジン>`（カスタムドメイン推奨）
4. `npx wrangler deploy`

**本番チェックリスト（重要）**

- `API_PUBLIC_ORIGIN` に **HTTPS の公開オリジン**を必ず設定（`tile_url_template` の契約 MUST）
- `ALLOWED_ORIGINS` に **GitHub Pages の実 URL**（`https://<org>.github.io` および必要なら `/<repo>` 付きオリジン）を列挙
- `FAKE_PROVIDER=false` と `ENVIRONMENT=production` をセットし、フェイクを誤って有効化しない

**GitHub Actions**: CI は `.github/workflows/rainmap-ci.yml` を参照。Worker の自動デプロイを行う場合は `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 等のシークレットと KV バインディングを環境に合わせて設定してください。

## 設計ドキュメント

| パス | 内容 |
|------|------|
| [design/00-index.md](design/00-index.md) | 索引・用語・読み順 |
| [design/09-deployment-github-pages-and-cloudflare.md](design/09-deployment-github-pages-and-cloudflare.md) | **規範デプロイ** |
| その他 `design/01`〜`08` | 要件・パイプライン・モジュール・リスク等 |

---

## 変更履歴（実装）

- **0.1.1**: レビュー反映（KV 単一キー、本番のメタウォームアップ方針、タイル 404 JSON、coverage 判定、フェッチ上限・タイムアウト、フロントのメタ再取得・`setUrl`・現地時刻表示など）
- **0.1.0**: MVP 実装（JMA nowc / メタ v1 / タイルプロキシ / Cron+KV / Leaflet UI）
