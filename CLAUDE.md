# ice-cream-bot 作業メモ

このファイルは Claude Code / Cowork が最初に読む前提で書いている。
「どこまで終わっていて、次に何をすればよいか」だけを書く。仕様は README.md を見ること。

---

## いまの状態（2026-08-28 時点）

**コードは完成してテスト済み。本番切り替えの手前で止まっている。**

| ブランチ | 中身 | GitHub |
|---|---|---|
| `main` | 旧v1（承認制ワークフロー版）。動いていない | push済み |
| `renewal/v2` | **新v2。これが完成品** | push済み（一部未push） |
| `backup/pre-renewal-20260828` | リニューアル前の作業ツリー退避 | push済み |

`renewal/v2` にはローカルのみのコミットが残っている可能性がある。
`git log origin/renewal/v2..renewal/v2` で確認すること。

---

## 🔴 最重要：投稿されなかった本当の理由

コードのバグではなかった。**Upstash Redis のデータベースが消滅していた。**

Vercel の本番ログ（2026-08-28 調査）で、cron が24時間に8回動いて
8回とも 500 で落ちていた。エラーは毎回これ:

```
Cronジョブエラー: [TypeError: fetch failed]
  cause: Error: getaddrinfo ENOTFOUND direct-lemur-82033.upstash.io
```

`.env.local` の `KV_REST_API_URL` が指す `direct-lemur-82033.upstash.io` は
DNS で解決できない。Upstash 側で削除されたか、無料枠の非アクティブ回収で消えた。

毎回「PR TIMES から444件取得 → Redis に問い合わせ → 名前解決失敗 → 500」を
繰り返していただけ。承認制に切り替えても下書きが1件も出なかったのも同じ理由。

**Redis を作り直さない限り、v2 でも同じように動かない。**
（ただし v2 は `/api/selftest` が原因を名指しで報告する）

---

## 次にやること（この順番で）

### ① Upstash Redis を作り直す ← 必須

Vercel ダッシュボード → プロジェクト `ice-cream-bot` → **Storage** タブ
→ **Create Database** → **Upstash (Redis)** → 作成 → **Connect Project**

リージョンは Tokyo (ap-northeast-1) 推奨。
`KV_REST_API_URL` / `KV_REST_API_TOKEN` が自動注入される。
v2 は `UPSTASH_REDIS_REST_URL` / `_TOKEN` の名前でも動くようにしてある。

### ② 環境変数を追加（Vercel → Settings → Environment Variables → Production）

| 変数 | 値 | 理由 |
|---|---|---|
| `ADMIN_SECRET` | 任意のパスワード | /admin 用。CRON_SECRET と分ける |
| `MAX_DAILY_POSTS` | **`0`** | 初回は投稿ゼロで様子を見る安全弁 |

`MAX_DAILY_POSTS=0` の間、bot は収集・判定・照合まで全部やるが
X には一切投稿せず「投稿待ち」キューに溜める。
`/admin` で中身を確認し、納得してから `12` に変えて再デプロイすれば
溜まった分から自動で流れ始める。

### ③ 本番へ切り替え

```powershell
cd C:\Users\iceman\ice-cream-bot
git checkout main
git merge renewal/v2
git push origin main renewal/v2
```

### ④ 動作確認

```powershell
# CRON_SECRET は .env.local から取得
$s = (Select-String -Path .env.local -Pattern '^CRON_SECRET=' ).Line -replace '^CRON_SECRET="?|"$',''
curl.exe -s -H "Authorization: Bearer $s" "https://<本番URL>/api/selftest?media=1"
```

`healthy: true` になれば全依存先（RSS・Redis・Claude・X認証・画像アップロード）が生きている。
10分おきの cron が回り始めるので、Vercel のログか `/admin` の「実行ログ」タブで
取得件数・候補件数・判定結果を見る。

---

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
