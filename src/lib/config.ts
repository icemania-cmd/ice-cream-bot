/**
 * 全チューニング項目をここに集約する。
 * 挙動を変えたくなったら基本このファイルだけ触ればよい状態を保つこと。
 */

/** PR TIMES 全社ファイアホース。約150件（＝直近2時間前後）が入る。 */
export const FIREHOSE_URL = "https://prtimes.jp/index.rdf";

/**
 * 保険用の企業別フィード。
 * ファイアホースは約2時間分しか遡れないため、デプロイ停止や障害で
 * 取りこぼしたときにここが拾い直す。10分おきスキャンなら通常は不要。
 */
export const COMPANY_FEEDS: { name: string; id: number }[] = [
  { name: "赤城乳業", id: 515 },
  { name: "ハーゲンダッツ ジャパン", id: 12760 },
  { name: "井村屋", id: 38645 },
  { name: "森永乳業", id: 21580 },
  { name: "森永製菓", id: 19896 },
  { name: "協同乳業", id: 10851 },
  { name: "明治", id: 155982 },
  { name: "オハヨー乳業", id: 27905 },
  { name: "ロッテ", id: 2360 },
  { name: "ロッテアイス", id: 4964 },
  { name: "江崎グリコ", id: 1124 },
  { name: "シャトレーゼ", id: 4553 },
  { name: "セブン‐イレブン・ジャパン", id: 155396 },
  { name: "ローソン", id: 2136 },
  { name: "ファミリーマート", id: 46210 },
];

export const companyFeedUrl = (id: number) =>
  `https://prtimes.jp/companyrdf.php?company_id=${id}`;

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Claude のモデル。環境変数で差し替え可能にしておく。 */
export const CLAUDE_MODEL =
  process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

// ===== 1回のスキャンでの上限（タイムアウト防止）=====

/** Claude に投げる候補の上限。事前フィルタ通過分がこれを超えたら次回に回す。 */
export const MAX_CLASSIFY_PER_RUN = 8;
/** 1回のスキャンで実際にXへ投稿する上限。 */
export const MAX_POSTS_PER_RUN = 3;

// ===== レート制限 =====

/**
 * 1日の投稿上限。X の Free プランは書き込みが月500件・24時間で17件程度。
 * 既定は安全側に倒して 12 件。プランを上げたら環境変数で引き上げる。
 */
export const MAX_DAILY_POSTS = Number(process.env.MAX_DAILY_POSTS || 12);
/** 連投防止の最小間隔（分）。同一スキャン内では待たず、次回スキャンに回す。 */
export const MIN_POST_GAP_MINUTES = Number(
  process.env.MIN_POST_GAP_MINUTES || 5
);

// ===== 鮮度 =====

/** 配信からこの時間を超えた記事は「速報」ではないので扱わない。 */
export const MAX_ARTICLE_AGE_HOURS = Number(
  process.env.MAX_ARTICLE_AGE_HOURS || 72
);
/** 発売日がこの日数より前（＝発売済み）なら投稿しない。0 = 当日はOK。 */
export const ALLOW_DAYS_AFTER_RELEASE = 0;

// ===== 投稿の体裁 =====

export const POST_PREFIX = "【新商品】";
/** X の重み付き文字数上限（全角2・半角1）。280 が Free/Basic の上限。 */
export const MAX_TWEET_WEIGHT = 280;
/**
 * 生成時に狙う長さ。上限ぎりぎりを狙わせると超過して投稿不可になるため、
 * 余裕を持たせる。日本語で概ね100〜110文字。
 */
export const TARGET_TWEET_WEIGHT = 220;

/** X の文字数カウント近似（全角2・半角1）。URLは含めない前提。 */
export function tweetWeight(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  return w;
}

// ===== 保持期間 =====

export const TTL_SEEN_DAYS = 45;
export const TTL_POSTED_DAYS = 120;
export const TTL_REVIEW_DAYS = 14;
export const RUN_LOG_KEEP = 60;
