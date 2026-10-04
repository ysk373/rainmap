# n8n + Slack による「もうすぐ雨」通知（拡張設計）

## このドキュメントで分かること

- 既存の雨雲レーダー資産（JMA HRPNs・Worker タイル／メタ）を使って、**地点に雨が近づいたら Slack へ通知**する流れ
- Worker の **`GET /api/v1/alerts/precip`** 契約
- **n8n** ワークフローのインポートと運用上の注意（重複通知・負荷）

本書は **拡張（informative + 実装済み契約）** です。地図 UI の MVP 契約（`02`）を壊さず、オーケストレーションは n8n に寄せます。

---

## 1. なぜこの形か

| 役割 | 担当 |
|------|------|
| ナウキャスト取得・タイルキャッシュ・地点の降水判定 | **Cloudflare Workers**（既存 rainmap API） |
| 定期実行・条件分岐・Slack 投稿・重複抑制 | **n8n** |
| 地図で状況確認 | **GitHub Pages** の雨雲 UI（`map_url`） |

n8n だけで気象庁タイルを直接連打すると、負荷・CORS・色判定の再実装が必要になる。**判定は Worker に集約**し、n8n は「JSON を見て Slack する」だけにする。

```
  Cron (n8n, 5〜10 分ごと)
           │
           ▼
  GET /api/v1/alerts/precip?lat=&lon=...
           │  （Worker が予報コマのタイルを画素サンプリング）
           ▼
  notify_recommended == true ?
           │ yes
           ▼
       Slack 投稿 ＋ 地図リンク
```

---

## 2. API 契約: `GET /api/v1/alerts/precip`

### クエリ

| パラメータ | 必須 | 既定 | 説明 |
|------------|------|------|------|
| `lat` | MUST | — | 緯度（WGS84） |
| `lon` | MUST | — | 経度（WGS84） |
| `horizon_minutes` | MAY | `60` | 先読み分（5〜60）。N2 短期予報の範囲に合わせる |
| `min_mmh` | MAY | `1` | 「雨あり」とみなす下限（mm/h 代表値） |
| `z` | MAY | `8` | サンプリングズーム（**偶数**に丸め。4/6/8/10） |
| `radius_px` | MAY | `2` | 画素近傍の最大強度を見る半径 |

coverage 外は **400 `out_of_coverage`**。KV 未準備の本番はメタと同様 **503 `warming_up`**。

### 応答（抜粋）

| フィールド | 意味 |
|------------|------|
| `currently_raining` | **いま時刻以前で最新のコマ**が閾値以上 |
| `raining_soon` | いま降っている、または horizon 内の**未来コマ**で閾値以上 |
| `notify_recommended` | **いまは降っていないが、未来コマで降り始める**（onset）。n8n の IF 条件に推奨 |
| `eta_minutes` | 降り始めまでのおおよそ分数（既に降っていれば 0、未来 onset 基準） |
| `onset` / `peak` | **現在より後**で最初に閾値を超えるコマ／評価コマ中の最大強度 |
| `samples[]` | 評価した各コマの強度 |
| `map_url` | `WEB_PUBLIC_BASE` から組み立てた地図ディープリンク（未設定なら null） |

強度は HRPNs PNG のパレット（透明＝無降水、薄い青〜紫＝強度帯）を代表 mm/h に写像した**近似**である。公式の数値格子そのものではない。

### 環境変数

| 変数 | 用途 |
|------|------|
| `WEB_PUBLIC_BASE` | 例: `https://ysk373.github.io/rainmap/`。`map_url` 生成 |

---

## 3. n8n セットアップ

1. ysk373/n8n の **[`workflows/upcoming-rain-slack.json`](https://github.com/ysk373/n8n/blob/main/workflows/upcoming-rain-slack.json)** を n8n に Import
2. 監視地点の **緯度経度**・API オリジン・Slack チャンネルは、ysk373/n8n の `.env` の `RAIN_ALERT_LAT` / `RAIN_ALERT_LON` / `RAINMAP_API_BASE` / `SLACK_CHANNEL_RAIN` で設定する（ほかの env と詳しい手順は ysk373/n8n の README）
3. Slack 資格情報を設定（Bot Token または Incoming Webhook に差し替え）
4. 重複抑制ノード（Data Store / 静的データ）のキーを地点ごとに分ける
5. Active にする

**推奨ポーリング**: 5〜10 分（JMA 更新と Worker Cron `*/5` に近い間隔）。それより細かくしても予報の時間分解能は約 5 分である。

**通知文の例**

> もうすぐ雨が降りそうです（約 15 分後・弱い雨）  
> 地図: https://ysk373.github.io/rainmap/?lat=…&lon=…&z=8

---

## 4. 重複通知（MUST に近い運用）

`notify_recommended` は「いま降っていないが今後降る」とき true になるが、同じ onset が続く間は毎回 true になりうる。n8n 側で次のいずれかを行う:

- **前回通知した `onset.frame_id`（または `onset.time`）と同じなら送らない**
- または **地点キーで 45〜60 分のクールダウン**

Worker に状態を持たせないことで、複数 n8n・複数地点を素直に増やせる。

---

## 5. 負荷とマナー

- 1 回のアラート評価は、地点×ズームで **最大おおよそ十数枚**のタイルを上流（またはエッジキャッシュ）から読む
- 監視地点は必要最小限にし、n8n の並列を抑えすぎないこと
- ブラウザや n8n から **気象庁 URL を直接連打しない**（既存設計どおり Worker 経由）

---

## 6. 動作確認

```bash
# 本番 API の例（地点は東京駅付近）
curl -sS 'https://rainmap-api.ysk373.workers.dev/api/v1/alerts/precip?lat=35.681236&lon=139.767125&horizon_minutes=60&min_mmh=1' | jq .
```

`notify_recommended` が true のときだけ Slack に流せば、晴天時は静かなままになる。

---

## 変更履歴

- rev.1: 地点降水アラート API と n8n / Slack 連携手順を追加
- rev.2: n8n のワークフローを ysk373/n8n に移した（RAINMAP-1）
