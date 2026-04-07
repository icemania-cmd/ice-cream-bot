# 🍦 Ice Cream Bot

PR TIMESのアイスクリーム関連プレスリリースを自動取得し、Xに投稿するBot。

## アーキテクチャ

```
PR TIMES RSS → フィルタリング → Claude API（投稿文生成） → X API（投稿）
                                                    ↕
                                              Vercel KV（重複防止）
```

## 月額ランニングコスト（見積もり）

| サービス | プラン | 費用 |
|---------|--------|------|
| Vercel | Hobby（無料） | $0 |
| Vercel KV | 無料枠 | $0 |
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
# リポジトリをGitHubにプッシュ
git init
git add .
git commit -m "initial commit"
gh repo create ice-cream-bot --private --push

# Vercelにデプロイ
npx vercel

# Vercel KVを追加（ダッシュボードから）
# Storage → KV → Create → ice-cream-bot-kv
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
```

### 5. 動作確認

```bash
# ローカルで動作確認する場合
cp .env.example .env.local
# .env.local に実際のキーを記入
npm install
npm run dev

# Cronエンドポイントをテスト
curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron
```

## ファイル構成

```
src/
├── app/
│   ├── api/cron/route.ts   # Cronジョブのエントリポイント
│   ├── layout.tsx           # レイアウト
│   └── page.tsx             # トップページ（ステータス表示）
└── lib/
    ├── rss.ts               # PR TIMES RSS取得・パース
    ├── comment.ts           # Claude APIで投稿文生成
    ├── x-client.ts          # X API投稿（OAuth 1.0a自前実装）
    └── store.ts             # Vercel KVで重複管理
```

## カスタマイズ

- **検索キーワード**: `src/lib/rss.ts` の `KEYWORDS` 配列を編集
- **投稿スタイル**: `src/lib/comment.ts` のプロンプトを編集
- **Cron間隔**: `vercel.json` の `schedule` を変更（現在は3時間ごと）
- **1回あたりの投稿上限**: `src/app/api/cron/route.ts` の `MAX_POSTS_PER_RUN` を変更
