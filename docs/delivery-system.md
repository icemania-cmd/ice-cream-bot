# アイスクリームBot 配信システム設計書

**最終更新:** 2026-04-20  
**対象ブランチ:** main  
**デプロイ先:** Vercel (Serverless Functions + Cron)

---

## 概要

PR TIMES のプレスリリースをスキャンし、アイスクリーム新商品情報を X (Twitter) に自動投稿するシステム。発売直前・当日まで複数回リマインドし、鮮度の高い情報を提供する。

---

## アーキテクチャ全体図

```
PR TIMES RSS
     │
     ▼ 毎時0分
┌─────────────┐       ┌──────────────┐
│  /api/cron  │──────▶│  X (Twitter) │
│  スキャン＋ │       │   API v2     │
│  即時投稿   │       └──────────────┘
└─────────────┘
     │ リマインド予約
     ▼
┌─────────────┐       ┌──────────────┐
│  Upstash    │       │  /api/       │
│  Redis KV   │◀─────▶│  reminder    │──▶ X (Twitter)
│             │       │  7/12/20時台 │
└─────────────┘       └──────────────┘
     ▲
     │ CVS商品キュー
┌─────────────┐       ┌──────────────┐
│ /api/       │       │  /api/       │
│ cvs-scan    │──────▶│  cvs-post    │──▶ X (Twitter)
│ 2時間おき   │       │  12/18時台   │
└─────────────┘       └──────────────┘
```

---

## Cron スケジュール

| エンドポイント | スケジュール (UTC) | JST 換算 | 目的 |
|---|---|---|---|
| `/api/cron` | `0 * * * *` | 毎時0分（24時間） | PR Times スキャン＋即時投稿 |
| `/api/reminder` | `*/10 22 * * *` | 7時台・10分おき | リマインド投稿（朝枠） |
| `/api/reminder` | `*/10 3 * * *` | 12時台・10分おき | リマインド投稿（昼枠） |
| `/api/reminder` | `*/10 11 * * *` | 20時台・10分おき | リマインド投稿（夜枠） |
| `/api/cvs-scan` | `0 */2 * * *` | 2時間おき | コンビニ商品スキャン |
| `/api/cvs-post` | `*/30 3-4 * * *` | 12〜13時台・30分おき | コンビニ商品投稿 |
| `/api/cvs-post` | `*/30 9-10 * * *` | 18〜19時台・30分おき | コンビニ商品投稿 |

---

## 投稿フロー（/api/cron）

### 1. PR Times スキャン

- 15社のRSSフィードから最新記事を取得
- `isAlreadyPosted(guid)` で投稿済みをスキップ
- Claude Haiku で発売日を抽出（`getCachedReleaseDate` でキャッシュ優先）

### 2. 発売日に応じた投稿分岐

```
発売日チェック
│
├─ 過去の発売日 (days < 0)
│   → スキップ、posted マーク
│
├─ 発売日不明
│   → 3日以内の記事: 再試行待ち（posted マークしない）
│   → 3日超の記事: 諦めてスキップ
│
├─ 本日発売 (days = 0)
│   → 【本日発売！】で即時投稿
│
├─ 翌日発売 (days = 1)
│   → 【リマインド】(day_before扱い) で即時投稿
│   → release_day リマインドのみ予約
│
└─ 2日以上先 (days >= 2)
    → 【新商品】で即時投稿
    → リマインドを複数予約（下記参照）
```

### 3. リマインド予約ルール

| 発売まで | 予約されるリマインドタイプ |
|---|---|
| 8日以上先 | week_before・three_days_before・day_before・release_day |
| 4〜7日先 | three_days_before・day_before・release_day |
| 2〜3日先 | day_before・release_day |
| 1日先（翌日） | release_day のみ（本体がday_before投稿を兼ねるため） |

同日に複数リマインドが重なる場合、時間枠（7/12/20時台）が被らないよう自動割り当て。

---

## 投稿タイプと先頭タグ

| タイプ | 先頭タグ | 生成関数 | トーン |
|---|---|---|---|
| 新商品告知 | `【新商品】` | `generatePost()` | 発売情報＋ひと言 |
| 翌日リマインド | `【リマインド】` | `generateReminderPost("day_before")` | 明日発売の高揚感 |
| 1週間前リマインド | `【リマインド】` | `generateReminderPost("week_before")` | 発売まで1週間 |
| 3日前リマインド | `【リマインド】` | `generateReminderPost("three_days_before")` | 発売まで3日 |
| 前日リマインド | `【リマインド】` | `generateReminderPost("day_before")` | 明日発売 |
| 発売当日 | `【本日発売！】` | `generateReleaseDayPost()` | 本日発売の喜び |
| コンビニ新商品 | `【コンビニ】` | `generateCvsPost()` | コンビニ情報 |
| メーカー直販 | `【新商品】` | `generateCvsPost()` | メーカー情報 |

---

## レート制限

### グローバル15分ギャップ

全投稿種別（PR Times・リマインド・CVS）共通で適用。

```
Redis キー: last_post_time（Unixタイムスタンプ）
チェック: 現在時刻 - last_post_time >= 15分 → 投稿OK
更新: 投稿成功後に現在時刻で上書き
TTL: 24時間
```

### 1日20件上限

```
Redis キー: daily_post_count:YYYY-MM-DD（JST基準）
チェック: count < 20 → 投稿OK
更新: 投稿成功後に INCR
TTL: 48時間
```

---

## リマインドデータモデル

### Redis キー形式

```
reminder:{scheduledDate}:{reminderType}:{guid}

例:
reminder:2026-04-28:week_before:https://prtimes.jp/main/html/rd/p/000000423.000012760.html
reminder:2026-05-01:day_before:https://prtimes.jp/main/html/rd/p/000000423.000012760.html
reminder:2026-05-02:release_day:https://prtimes.jp/main/html/rd/p/000000423.000012760.html
```

### データ構造（ReminderData）

```typescript
interface ReminderData {
  title: string;           // 記事タイトル
  description: string;     // 記事本文
  link: string;            // PR Times URL
  imageUrl?: string;       // OGP画像URL
  guid: string;            // 記事の一意識別子（URLと同値）
  releaseDate: string;     // 発売日 YYYY-MM-DD
  reminderType: ReminderType;   // week_before / three_days_before / day_before / release_day
  scheduledDate: string;   // 投稿予定日 YYYY-MM-DD
  scheduledHour: number;   // 投稿予定時 JST: 7 / 12 / 20
  scheduledMinute: number; // 投稿予定分 0-59（ランダム）
}
```

### リマインド投稿済み管理

```
Redis キー: reminder_posted:{reminderType}:{guid}
値: "1"
TTL: 30日
```

---

## リマインド投稿フロー（/api/reminder）

1. 現在のJST時刻（時・分）を取得
2. `getRemindersForTimeSlot(today, hour, minute)` で当該10分窓のリマインドを取得
3. 各リマインドについて:
   - `isReminderTypePosted(type, guid)` で投稿済みチェック
   - `canPostToday()` で1日上限チェック
   - `canPostNow()` で15分ギャップチェック
   - reminderType に応じた投稿文を生成・投稿
4. 成功後: `recordPostTime()` + `incrementDailyCount()` + `markReminderTypeAsPosted()`

### 10分ウィンドウの仕組み

```
cron が :00 に実行 → windowStart=0,  windowEnd=10  → scheduledMinute 0〜9 が対象
cron が :10 に実行 → windowStart=10, windowEnd=20  → scheduledMinute 10〜19 が対象
...
cron が :50 に実行 → windowStart=50, windowEnd=60  → scheduledMinute 50〜59 が対象
```

---

## コンビニスキャンフロー（/api/cvs-scan）

1. ファミリーマート・セブン-イレブン・ローソン・ミニストップ・竹下製菓のHTMLを取得
2. Claude Haiku でアイスクリーム商品を抽出（JSON配列）
3. PR Times投稿済みと重複チェック（`isDuplicateWithPrTimes()`）
4. 発売日が当日以降の商品のみキューに追加

### 竹下製菓の特別ルール

- アイスクリーム本体のみ（ブランド名を冠したお菓子・チョコレートは除外）
- 販売エリアが明記されていない場合はスキップ（`unknown_region`）

---

## コメントバリエーション（33種）

投稿末尾のひと言をClaudeがランダムに選択。連続投稿で同じ表現が続かないよう指示。

```
楽しみ！ / 気になる〜 / いよいよ！ / これは絶対買う / 見かけたら即買い /
推しの一本になりそう / 早速チェックします / 発売日にチェックを /
これは試したい / 情報入りました / どんな味なんだろう / 好きなやつです /
たまりませんね / 買うしかない / コンビニ寄らなきゃ / チェック推奨 /
気になりすぎる / これは期待大 / いいですね / ぜひチェックを /
発売が待ち遠しい / 要チェックです / 見逃せない / これは嬉しい / さすがですね /
ちょっと待って、これすごくない？ / 個人的に好きなシリーズ /
まずは一本試してみます / これはうれしい新フレーバー / ファンには堪らないですね /
毎年この季節が来ると思い出す一本 / 外せない一本 / ひそかに待ってたやつ
```

---

## Redis キー一覧

| キープレフィックス | 用途 | TTL |
|---|---|---|
| `posted:{guid}` | PR Times投稿済み | 30日 |
| `reminder:{date}:{type}:{guid}` | リマインド予約 | 発売日+2日 |
| `reminder_posted:{type}:{guid}` | リマインド投稿済み | 30日 |
| `release_date:{guid}` | 発売日キャッシュ | 30日（不明時1時間） |
| `last_post_time` | グローバル最終投稿時刻 | 24時間 |
| `daily_post_count:{date}` | 当日投稿件数 | 48時間 |
| `cvs_product:{productId}` | CVS商品情報 | 30日 |
| `cvs_queue:{productId}` | CVS投稿キュー | 7日 |
| `cvs_posted:{productId}` | CVS投稿済み | 30日 |

---

## 環境変数

| 変数名 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude Haiku API |
| `X_API_KEY` | X API v2 (OAuth 1.0a) |
| `X_API_SECRET` | X API v2 (OAuth 1.0a) |
| `X_ACCESS_TOKEN` | X API v2 (OAuth 1.0a) |
| `X_ACCESS_TOKEN_SECRET` | X API v2 (OAuth 1.0a) |
| `CRON_SECRET` | Vercel Cron 認証トークン |
| `KV_REST_API_URL` | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Upstash Redis REST トークン |

---

## ファイル構成

```
src/
├── app/api/
│   ├── cron/route.ts        PR Times スキャン＋即時投稿
│   ├── reminder/route.ts    リマインド投稿（時間枠照合）
│   ├── cvs-scan/route.ts    コンビニ商品スキャン
│   └── cvs-post/route.ts    コンビニ商品投稿
└── lib/
    ├── store.ts             Redis操作・レート制限・リマインド管理
    ├── comment.ts           Claude投稿文生成（全タイプ）
    ├── rss.ts               PR Times RSSフェッチ
    ├── cvs-scraper.ts       コンビニサイトスクレイピング
    └── x-client.ts          X API投稿・画像アップロード
vercel.json                  Cron設定・Function設定
```

---

## 設計上の判断メモ

- **翌日発売は【リマインド】のみ**: 新商品投稿と前日リマインドが同日に重複するのを避けるため
- **発売当日は7時台固定**: 発売日の朝に確実に告知するため（release_day は scheduledHour=7 固定）
- **10分ウィンドウ方式**: Vercel cron の最小間隔を活用しつつ、分単位のランダム性でBot判定を回避
- **グローバル15分ギャップ**: PR Times・リマインド・CVSをまたいだ連投防止
- **発売日不明は3日間再試行**: Claude API一時障害やページ未生成による取りこぼし防止
