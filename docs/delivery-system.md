# アイスクリームBot 配信システム設計書

**最終更新:** 2026-07-30
**対象ブランチ:** main
**デプロイ先:** Vercel (Serverless Functions) ＋ 外部cron（cron-job.org）

---

## 概要

PR TIMESのプレスリリースとコンビニ各社サイトをスキャンし、
アイスクリーム新商品情報をX (Twitter) に**1回だけ**自動投稿するシステム。

**リマインド機能は廃止済み。** 純粋に「取得 → フィルタ → 投稿」のみ。

---

## アーキテクチャ全体図

```
PR TIMES RSS (15社)
     │
     ▼ 毎時（外部cron）
┌─────────────┐       ┌──────────────┐
│  /api/cron  │──────▶│  X (Twitter) │
│  スキャン＋ │       │   API v2     │
│  即時投稿   │       └──────────────┘
└─────────────┘              ▲
     │ 重複防止               │
     ▼                       │
┌─────────────┐       ┌──────────────┐
│  Upstash    │       │  /api/       │
│  Redis      │◀─────▶│  cvs-post    │
└─────────────┘       │ 12/18時台    │
     ▲                └──────────────┘
     │ CVS商品キュー          ▲
┌─────────────┐              │
│ /api/       │──────────────┘
│ cvs-scan    │
│ 2時間おき   │
└─────────────┘
```

---

## スケジュール（cron-job.org / Asia/Tokyo）

Vercel Hobbyのcron制限（1日1回まで）を回避するため、外部cronから
`Authorization: Bearer CRON_SECRET` 付きで各APIを呼び出す。
詳細手順は `docs/setup-external-cron.md` を参照。

| エンドポイント | スケジュール | 目的 |
|---|---|---|
| `/api/cron` | 毎時0分 | PR TIMESスキャン＋即時投稿（最大3件/回） |
| `/api/cvs-scan` | 2時間おき | コンビニ商品スキャン→キュー保存 |
| `/api/cvs-post` | 12:00 / 12:30 / 18:00 / 18:30 | コンビニ商品投稿（最大1件/回） |

---

## 投稿フロー（/api/cron）

1. 15社のRSSフィードから最新記事を取得
2. `isAlreadyPosted(guid)` で投稿済みをスキップ
3. Claude Haikuで発売日を抽出（Redisキャッシュ優先）
4. フィルタ:
   - CVS側で投稿済みの商品と重複 → スキップ
   - 記事が30日超で古い → スキップ
   - 発売日不明 → 3日間は再試行、その後スキップ
   - 発売日が過去 → スキップ（古い情報の誤投稿防止）
5. 発売日が近い順に最大3件、`generatePost()` で【新商品】投稿文を生成
   （新商品告知でない記事はClaudeが `SKIP` を返して除外）
6. og:image → X画像アップロード → 投稿 → `markAsPosted()`

## 投稿フロー（/api/cvs-scan → /api/cvs-post）

1. `cvs-scan`: コンビニ4社＋竹下製菓のHTMLをClaude Haikuで解析し、
   発売日が明日以降の新商品だけをRedisキューに保存
2. `cvs-post`: キューから1件取り出し、PR TIMES重複・発売日・
   投稿文バリデーションをチェックして【コンビニ】/【新商品】投稿

---

## レート制限（全投稿共通）

| 制限 | 内容 |
|---|---|
| 15分ギャップ | `last_post_time` キー。全投稿種別共通で15分空ける |
| 1日20件上限 | `daily_post_count:YYYY-MM-DD` キー（JST基準） |

---

## Redisキー一覧

| キープレフィックス | 用途 | TTL |
|---|---|---|
| `posted:{guid}` | PR TIMES投稿済み | 30日 |
| `release_date:{guid}` | 発売日キャッシュ | 30日（不明時1時間） |
| `last_post_time` | グローバル最終投稿時刻 | 24時間 |
| `daily_post_count:{date}` | 当日投稿件数 | 48時間 |
| `cvs_product:{productId}` | CVS商品情報 | 30日 |
| `cvs_queue:{productId}` | CVS投稿キュー | 7日 |
| `cvs_posted:{productId}` | CVS投稿済み | 30日 |

※ `reminder:*` / `reminder_posted:*` は廃止（残っていてもTTLで自然消滅）

---

## 環境変数

| 変数名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Haiku API |
| `X_API_KEY` / `X_API_SECRET` | X API (OAuth 1.0a) |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | X API (OAuth 1.0a) |
| `CRON_SECRET` | Cron呼び出し認証トークン |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis |

---

## ファイル構成

```
src/
├── app/api/
│   ├── cron/route.ts        PR TIMESスキャン＋即時投稿
│   ├── cvs-scan/route.ts    コンビニ商品スキャン
│   ├── cvs-post/route.ts    コンビニ商品投稿
│   ├── test-filters/route.ts 投稿判定のdry-run確認用
│   ├── test-cvs/route.ts    コンビニHTML取得テスト用
│   └── debug-html/route.ts  HTMLデバッグ用
└── lib/
    ├── store.ts             Redis操作・重複防止・レート制限
    ├── comment.ts           Claude投稿文生成（新商品/CVS/発売日抽出）
    ├── rss.ts               PR TIMES RSSフェッチ
    ├── cvs-scraper.ts       コンビニサイトスクレイピング
    └── x-client.ts          X API投稿・画像アップロード
vercel.json                  Function設定（maxDuration）
```
