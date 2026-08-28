# 🍦 Ice Cream Bot

PR TIMESのアイスクリーム関連プレスリリースとコンビニ各社サイトを自動取得し、
新商品情報をXに投稿するBot。**リマインドなし・1商品1投稿のシンプル構成。**

## アーキテクチャ

```
PR TIMES RSS ─┐
              ├─ フィルタリング → Claude API（投稿文生成） → X API（投稿）
コンビニサイト ┘                            ↕
                                    Upstash Redis（重複防止・レート制限）

スケジュール実行: cron-job.org（外部cron・無料）
※ Vercel Hobbyのcronは1日1回制限のため使用しない
```

## 月額ランニングコスト（見積もり）

| サービス | プラン | 費用 |
|---------|--------|------|
| Vercel | Hobby（無料） | $0 |
| Upstash Redis | 無料枠 | $0 |
| cron-job.org | 無料 | $0 |
| X API | Free | $0 |
| Claude API (Haiku) | 従量課金 | ~$0.5〜2/月 |
| **合計** | | **~$0.5〜2/月** |

## セットアップ手順

### 1. X Developer Account の申請

1. https://developer.x.com/en/portal/petition/essential/basic-info にアクセス
2. 開発者アカウントを申請（利用目的は「Bot / Automated posting」を選択）
3. 承認後、ダッシュボードで新しいAppを作成
4. **User authentication settings** で以下を設定:
   - App permissions: **Read and Write**
   - Type of App: **Web App**
   - Callback URL: `https://your-app.vercel.app/api/callback`（仮でOK）
5. **Keys and Tokens** タブから以下を取得:
   - API Key / API Key Secret
   - Access Token / Access Token Secret（**Read and Write権限で再生成**すること）

### 2. Anthropic API Key の取得

1. https://console.anthropic.com/ にアクセス
2. API Keyを新規作成

### 3. Vercelへのデプロイ

```bash
git add .
git commit -m "update"
git push        # Vercel連携済みなら自動デプロイ
# または: npx vercel --prod
```

### 4. 環境変数の設定

Vercelダッシュボード → Settings → Environment Variables に以下を追加:

```
X_API_KEY=（手順1で取得）
X_API_SECRET=（手順1で取得）
X_ACCESS_TOKEN=（手順1で取得）
X_ACCESS_TOKEN_SECRET=（手順1で取得）
ANTHROPIC_API_KEY=（手順2で取得）
CRON_SECRET=（任意のランダム文字列。openssl rand -hex 32 で生成可）
KV_REST_API_URL=（Upstash Redis）
KV_REST_API_TOKEN=（Upstash Redis）
```

### 5. 外部cronの設定（重要）

**これを設定しないとBotは一切動きません。**
`docs/setup-external-cron.md` の手順に従い、cron-job.org で
以下の3ジョブを登録する（すべて `Authorization: Bearer CRON_SECRET` ヘッダー付き）:

| URL | スケジュール（JST） |
|---|---|
| `/api/cron` | 毎時0分 |
| `/api/cvs-scan` | 2時間おき |
| `/api/cvs-post` | 12:00 / 12:30 / 18:00 / 18:30 |

### 6. 動作確認

```bash
# 手動実行（実際に投稿される）
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/cron

# dry-run（投稿せず判定結果のみ確認）
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/test-filters
```

## ファイル構成

```
src/
├── app/api/
│   ├── cron/route.ts        # PR TIMESスキャン＋投稿
│   ├── cvs-scan/route.ts    # コンビニ商品スキャン
│   ├── cvs-post/route.ts    # コンビニ商品投稿
│   └── test-filters/route.ts # dry-run確認用
└── lib/
    ├── rss.ts               # PR TIMES RSS取得・パース
    ├── comment.ts           # Claude APIで投稿文生成
    ├── cvs-scraper.ts       # コンビニサイトスクレイピング
    ├── x-client.ts          # X API投稿（OAuth 1.0a自前実装）
    └── store.ts             # Redisで重複防止・レート制限
```

## カスタマイズ

- **検索キーワード**: `src/lib/rss.ts` の `KEYWORDS` 配列を編集
- **対象企業**: `src/lib/rss.ts` の `COMPANY_FEEDS` 配列を編集
- **投稿スタイル**: `src/lib/comment.ts` のプロンプトを編集
- **1回あたりの投稿上限**: `src/app/api/cron/route.ts` の `MAX_POSTS_PER_RUN`
- **1日の投稿上限**: `src/lib/store.ts` の `MAX_DAILY_POSTS`（現在20件）
