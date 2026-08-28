# 運用手引き

## 毎日やること

原則なし。承認待ちが溜まったときだけ `/admin` を開く。

## 何かおかしいと感じたら（順番に）

### 1. まず自己診断

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/selftest?media=1" | jq
```

`healthy: false` なら `checks` の中で `ok: false` になっている項目が原因。

| 落ちている項目 | 典型的な原因 |
|---|---|
| 環境変数 | Vercel の Environment Variables に未設定／Production に反映されていない |
| Upstash Redis | 接続情報の失効、Upstash 側の無料枠超過 |
| PR TIMES フィード | 先方のフォーマット変更、または一時的な障害 |
| Claude API | 残高切れ、モデル名の変更 |
| X 認証 | トークンの失効。**権限を Read and Write にしてから再生成し直す** |
| X 画像アップロード | v2 エンドポイントの権限不足。App permissions を確認 |

### 2. 挙動を投稿なしで見る

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/scan?dry=1" | jq '.log, .details'
```

`details` に1件ずつ「対象外」「承認待ちへ」「投稿予定」の理由が入る。

### 3. 実行ログを見る

`/admin` の「実行ログ」タブに直近60回分が残る。
`errors` に何も出ていないのに `posted` が 0 のままなら、
`candidates` が 0 か（＝フィルタが厳しすぎる）、
`queued` が増えているか（＝照合で弾かれ続けている）で切り分ける。

---

## よくある状況と判断

### 承認待ちばかりで自動投稿されない

`/admin` の警告文を10件ほど読み、同じ警告が繰り返し出ていないか見る。

- 「発売日が原文で確認できません」が多い
  → プレスリリースが画像内に発売日を書いているケース。機械照合では拾えないので承認運用が正しい。
- 「価格が原文に見当たりません」が多い
  → 税抜/税込の表記ゆれ。`verify.ts` の価格照合を緩める余地がある。
- 「商品名が原文と一致しません」が多い
  → Claude が商品名を整形している。`classify.ts` のプロンプトで「原文の表記のまま」を強調する。

### 投稿が多すぎる／少なすぎる

`MAX_DAILY_POSTS` と `MIN_POST_GAP_MINUTES` を Vercel の環境変数で調整する。
コード変更もデプロイも不要。

### 取りこぼしが疑われる

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/scan?dry=1&deep=1" | jq '.log'
```

企業別フィードまで含めて拾い直せる。
それでも出てこないなら、その記事は事前フィルタで落ちている可能性が高い。
`filter.ts` の `STRONG_ICE_TERMS` に語を足す。

---

## 触ってはいけないところ

- `verify.ts` の照合を「全部警告なし」にする改修。
  これをやると v2 はただの自動投稿Botに戻り、誤情報がそのまま世に出る。
- `store.ts` に `redis.keys()` を足すこと。
  v1 のタイムアウトはここが原因だった。一覧が要るときは ZSET を使う。
- 実行ロックの削除。Vercel の cron は同じ実行を二重配信しうる。

---

## 過去のコードを見たいとき

リニューアル前の実装は `backup/pre-renewal-20260828` ブランチに退避してある。

```bash
git show backup/pre-renewal-20260828:src/lib/x-client.ts
```
