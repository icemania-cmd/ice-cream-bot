# 外部Cron（cron-job.org）設定手順

Vercel Hobbyプランのcronは「1日1回まで」の制限があるため、
スケジュール実行は **cron-job.org（無料）** から行う。

## 前提

- デプロイ先URL: `https://ice-cream-bot.vercel.app`
- 認証: 全エンドポイントで `Authorization: Bearer <CRON_SECRET>` ヘッダーが必須
- `CRON_SECRET` はVercelの環境変数に設定済みの値を使う

## 手順

1. https://cron-job.org/ でアカウント作成（無料）
2. ダッシュボード → **CREATE CRONJOB** で以下の3ジョブを作成する

### ジョブ1: PR TIMESスキャン＋投稿（毎時）

| 項目 | 設定値 |
|---|---|
| URL | `https://ice-cream-bot.vercel.app/api/cron` |
| スケジュール | Every hour（毎時0分） / タイムゾーン: Asia/Tokyo |
| リクエストメソッド | GET |
| ヘッダー | `Authorization: Bearer <CRON_SECRET>` |

※ ヘッダーは「ADVANCED」タブ → Headers で追加する。

### ジョブ2: コンビニサイトスキャン（2時間おき）

| 項目 | 設定値 |
|---|---|
| URL | `https://ice-cream-bot.vercel.app/api/cvs-scan` |
| スケジュール | Every 2 hours（0分） / Asia/Tokyo |
| メソッド / ヘッダー | ジョブ1と同じ |

### ジョブ3: コンビニ商品投稿（昼・夕方）

| 項目 | 設定値 |
|---|---|
| URL | `https://ice-cream-bot.vercel.app/api/cvs-post` |
| スケジュール | カスタム: 12:00 / 12:30 / 18:00 / 18:30（Asia/Tokyo） |
| メソッド / ヘッダー | ジョブ1と同じ |

※ 1回の実行で最大1件投稿。4回/日 = 最大4件/日のコンビニ投稿。

## 注意点

- **cron-job.orgのタイムアウトは30秒**。投稿処理が重い回は接続が
  切られて「Failed (timeout)」と表示されることがあるが、Vercel側の
  処理は基本的に継続される（関数のmaxDurationは300秒）。
  タイムアウト表示が続いても、Xに投稿されていれば正常動作。
- 二重投稿防止はRedis（投稿済みguid管理＋15分ギャップ＋1日20件上限）で
  行っているため、cronが多少重複して発火しても問題ない。
- 動作確認は手動で可能:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://ice-cream-bot.vercel.app/api/cron
```

- 投稿せずに判定結果だけ見たい場合（dry-run）:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://ice-cream-bot.vercel.app/api/test-filters
```
