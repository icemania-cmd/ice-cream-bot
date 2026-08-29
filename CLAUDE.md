# ice-cream-bot 作業メモ

このファイルは Claude Code / Cowork が最初に読む前提で書いている。
「どこまで終わっていて、次に何をすればよいか」だけを書く。仕様は README.md を見ること。

---

## いまの状態（2026-08-29 時点）

**v2 が本番で稼働中。ただし投稿は止めてある。**

- `main` = v2。Vercel 本番にデプロイ済み。10分おきの cron が正常動作
- `MAX_DAILY_POSTS=0` を設定しているため、**判定・照合まで実行してキューに溜めるだけ**。X には1件も投稿しない
- 旧 v1 は `backup/pre-renewal-20260828` ブランチに退避済み

### 解決済み（旧botが動かなかった原因）

**Upstash Redis のデータベースが消滅していた。** cron が24時間で8回とも
`getaddrinfo ENOTFOUND direct-lemur-82033.upstash.io` で500終了していた。
コードの問題ではなかった。新しい Upstash（`upstash-kv-charcoal-ladder`）を
作成して接続済み。

### 実機で検証済みの項目

| 項目 | 状態 |
|---|---|
| Upstash Redis 読み書き | ✅ |
| PR TIMES 全社フィード取得・重複排除 | ✅ 200件取得→新規5件を0.4秒 |
| Claude 判定・投稿文生成 | ✅ 実記事4本で確認 |
| 事実照合（自動投稿の可否） | ✅ 正しい記事は通し、捏造は弾く |
| X 認証 | ✅ @icemania |
| X 画像アップロード（v2 エンドポイント） | ✅ 実際に media_id 取得 |

X Premium でも **API 経由では280文字（重み）の制限が残る**ため、
`MAX_TWEET_WEIGHT` は 280 のまま（環境変数で変更可）。

## 次にやること

### ① 溜まった投稿待ちを確認する

https://ice-cream-bot.vercel.app/admin を開き（パスワードは `ADMIN_SECRET`）、
「投稿待ち」タブに実際のアイス記事が2〜3件溜まっているか見る。
文章と事実が問題なければ次へ。

### ② 投稿をONにする

Vercel → ice-cream-bot → Settings → Environment Variables で
`MAX_DAILY_POSTS` を `0` → `12` に変更し、**Redeploy する**
（環境変数はデプロイ時に取り込まれるため、変更だけでは反映されない）。

溜まっていた分から順に自動投稿が始まる。

### ③ 最初の数件を見る

`/admin` の「投稿済み」タブか、Vercel のログで
`[scan:live] 取得… 投稿1 …` の行を確認する。

## 未検証で残っているもの

コードは合成データで10ケース検証済みだが、以下は**まだ実物で動かしていない**。
本番投入後の最初の数回で必ず確認すること。

1. **X の v2 画像アップロード**（`/2/media/upload`）
   旧実装は廃止済みの v1.1 を叩いていた。v2 は一度も実際に成功させていない。
   `/api/selftest?media=1` で単体確認できる。失敗したらアプリの権限が
   Read and Write になっているか、トークンが権限変更後に再生成されたかを疑う。
2. **PR TIMES 全社フィード（index.rdf）の実パース**
   合成XMLでは通っている。実物で 0 件になったらフォーマット変更を疑う。
3. **自動投稿の通過率**
   照合が厳しすぎて全部承認待ちに回る可能性がある。
   `/admin` の警告文を10件ほど読み、同じ警告が繰り返すなら
   `docs/operations.md` の「よくある状況と判断」に従って調整する。

---

## 触ってはいけないところ

- `src/lib/verify.ts` の照合を緩めて「全部自動投稿」にすること。
  これをやると誤情報がそのまま公開アカウントに出る。
- `src/lib/store.ts` に `redis.keys()` を足すこと。v1 のタイムアウト要因。
- 実行ロック（`acquireRunLock`）の削除。Vercel の cron は二重配信しうる。
- `.env.check` などをコミットすること。`vercel env pull` の出力は秘密情報を含む。
  `.gitignore` で `.env.*` を除外済み。

---

## この環境特有の注意

このフォルダは以前、**git がファイルを削除できずブランチ切替やコミットが
途中で壊れる**状態だった（`_to_delete/git-lock-cleanup/` や `.git/HEAD.lock` の
残骸がその痕跡）。ローカルと GitHub/Vercel の中身がズレる原因になっていた。
同じ症状が出たら `.git/HEAD.lock` を消して `git reset --hard <ブランチ>` で復旧する。
