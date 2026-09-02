import { Redis } from "@upstash/redis";
import {
  MAX_DAILY_POSTS,
  MIN_POST_GAP_MINUTES,
  RUN_LOG_KEEP,
  TTL_POSTED_DAYS,
  TTL_REVIEW_DAYS,
  TTL_SEEN_DAYS,
} from "./config";

/**
 * 状態管理。
 *
 * 旧実装は redis.keys('posted:*') で全キーを舐めてから1件ずつ GET していた。
 * Upstash は1コマンド1HTTPなので、投稿済み100件×記事N件で数千往復になり、
 * これがタイムアウトと課金増の主因だった。
 * ここでは ZSET のメンバー判定とパイプラインだけで済ませ、KEYS は一切使わない。
 */

/**
 * Upstash の接続情報。
 * Vercel の Marketplace 連携は、作成時期によって KV_REST_API_* と
 * UPSTASH_REDIS_REST_* のどちらの名前で環境変数を注入するかが異なる。
 * 片方しか見ていないと「繋がらない理由が分からない」事故になるので両方受ける。
 */
export const redisUrl =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
export const redisToken =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const redis = new Redis({ url: redisUrl, token: redisToken });

const K = {
  posted: "v2:posted",
  review: "v2:review",
  ready: "v2:ready",
  rejected: "v2:rejected",
  runs: "v2:runs",
  feedback: "v2:feedback",
  lastPost: "v2:lastpost",
  daily: (jstDate: string) => `v2:daily:${jstDate}`,
  postItem: (guid: string) => `v2:post:${guid}`,
  rejectedItem: (guid: string) => `v2:rejected-item:${guid}`,
};

const DAY = 24 * 60 * 60 * 1000;

export function jstDateString(at: Date = new Date()): string {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return null;
}

// ===== 既知判定 =====

/**
 * 処理済み記事の記録。
 *
 * ここは1日144回×150件の判定が走る場所なので、コマンド数を最小化する必要がある。
 * Upstash は「1コマンド＝1課金」なので、1件ずつ問い合わせると
 * 月間で数十万コマンドに達してしまう。
 * SET と SMISMEMBER を使い、150件の判定を **1コマンド** で済ませる。
 *
 * SET は期限で刈れないため月ごとにキーを分け、TTL で自然に消えるようにする。
 * 判定は「今月」と「先月」の2本だけ見れば足りる（記事の鮮度上限は数日）。
 */
const HANDLED_TTL_SECONDS = TTL_SEEN_DAYS * 86400;

function handledKey(monthsAgo = 0): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  // 先に1日へ寄せてから月を引く。31日に setUTCMonth(-1) すると
  // 「4月31日 → 5月1日」に正規化され、先月キーが今月キーと同じになる。
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return `v2:handled:${d.toISOString().slice(0, 7)}`;
}

/**
 * まだ手を付けていない記事だけを返す。
 * 消費コマンドは常に2（今月分・先月分の SMISMEMBER）。
 */
export async function filterUnhandled(guids: string[]): Promise<string[]> {
  if (guids.length === 0) return [];
  const [cur, prev] = (await redis
    .pipeline()
    .smismember(handledKey(0), guids)
    .smismember(handledKey(1), guids)
    .exec()) as [(0 | 1)[], (0 | 1)[]];

  return guids.filter((_, i) => !cur?.[i] && !prev?.[i]);
}

/**
 * 「もう触らない」印を付ける。
 * 対象外と判定した記事・投稿した記事・キューに入れた記事すべてに付ける。
 * 消費コマンドは2（SADD と EXPIRE）。
 */
export async function markHandled(guids: string[]): Promise<void> {
  if (guids.length === 0) return;
  const key = handledKey(0);
  const pipe = redis.pipeline();
  pipe.sadd(key, guids[0], ...guids.slice(1));
  pipe.expire(key, HANDLED_TTL_SECONDS);
  await pipe.exec();
}

export async function markPosted(
  guid: string,
  data: {
    title: string;
    link: string;
    text: string;
    tweetId?: string;
    imageUrl?: string;
    releaseDate?: string;
    route: "auto" | "approved";
    /** IG同時投稿の結果。"posted" | "skipped" | "failed" */
    ig?: string;
  }
): Promise<void> {
  const now = Date.now();
  const pipe = redis.pipeline();
  pipe.zadd(K.posted, { score: now, member: guid });
  pipe.set(
    K.postItem(guid),
    JSON.stringify({ ...data, postedAt: new Date().toISOString() }),
    { ex: TTL_POSTED_DAYS * 86400 }
  );
  pipe.zrem(K.review, guid);
  pipe.zrem(K.ready, guid);
  pipe.del(`v2:review:${guid}`);
  pipe.del(`v2:ready:${guid}`);
  pipe.sadd(handledKey(0), guid);
  pipe.expire(handledKey(0), HANDLED_TTL_SECONDS);
  await pipe.exec();
}

// ===== キュー（承認待ち／投稿待ち）=====

/**
 * 2本のキューを同じ構造で扱う。
 *  - ready : 機械照合を全部通過し、投稿枠が空くのを待っているもの（自動投稿対象）
 *  - review: 1つでも照合に引っかかり、人間の確認が要るもの
 * ready を設けているのは、連投防止で見送った記事を次回また Claude に
 * 投げ直すという無駄（＝旧実装の課金増の一因）を無くすため。
 */
export type QueueName = "ready" | "review";

const queueKey = (q: QueueName) => `v2:${q}`;
const queueItemKey = (q: QueueName, guid: string) => `v2:${q}:${guid}`;

export interface QueuedItem {
  guid: string;
  title: string;
  link: string;
  corp: string;
  publishedAt: string;
  imageUrl?: string;
  releaseDate: string;
  productName: string;
  maker: string;
  price: string;
  region: string;
  text: string;
  blocking: string[];
  warnings: string[];
  /** 照合に使った原文の抜粋。管理画面で目視突き合わせできるようにする。 */
  sourceExcerpt: string;
  createdAt: string;
  /** 記事の種類（new_product / store / event / collab）。見送りの集計に使う */
  topicType?: string;
}

/**
 * 人の判断の記録。
 *
 * これまで却下は guid を捨てるだけで、なぜ却下したのかが残っていなかった。
 * 「なぜ出さなかったか」は、フィルタとプロンプトを直すための一次資料になる。
 * 承認前に文面を書き換えたときの「元の文 → 直した文」も同じ理由で残す。
 * これは Claude の出力と、実際に世に出す文の差そのもので、
 * 手に入る改善材料としては最も質が高い。
 */
export interface FeedbackRecord {
  id: string;
  guid: string;
  kind: "reject" | "edit";
  at: string;
  title: string;
  link: string;
  corp: string;
  topicType?: string;
  productName?: string;
  /** 却下のとき。定型の理由コード */
  reason?: string;
  /** 却下のとき。自由記述 */
  memo?: string;
  /** Claude が書いた文面 */
  draftText?: string;
  /** 実際に投稿した文面（編集したとき） */
  finalText?: string;
}

/**
 * 文体の見本。
 *
 * Claude が書いた下書きではなく「実際に世に出した文」だけを保持する。
 * 下書きを混ぜると、直す前の癖ごと学ばせることになる。
 *
 * LIST に LPUSH + LTRIM で保持数を書き込み時に固定する。
 * 読むときは LRANGE 1回で済み、スキャンごとのコマンドが増えない。
 */
const STYLE_KEY = "v2:style";
export const STYLE_KEEP = 3;

export async function rememberStyleSample(text: string): Promise<void> {
  const t = (text || "").trim();
  if (!t) return;
  const pipe = redis.pipeline();
  pipe.lpush(STYLE_KEY, t);
  // 感覚は変わっていくので、古い文に引きずられないよう新しい順に3本だけ残す
  pipe.ltrim(STYLE_KEY, 0, STYLE_KEEP - 1);
  await pipe.exec();
}

export async function getStyleSamples(): Promise<string[]> {
  try {
    const v = await redis.lrange<string>(STYLE_KEY, 0, STYLE_KEEP - 1);
    if (!Array.isArray(v)) return [];
    return v.filter((t) => typeof t === "string" && t.trim().length > 0);
  } catch {
    // 見本が取れなくても判定は続ける。固定の見本で動く。
    return [];
  }
}

const TTL_FEEDBACK_DAYS = 180;
const feedbackKey = (id: string) => `v2:fb:${id}`;

export async function recordFeedback(
  rec: Omit<FeedbackRecord, "id" | "at">
): Promise<void> {
  const now = Date.now();
  const id = `${rec.kind}:${now}:${Math.random().toString(36).slice(2, 8)}`;
  const full: FeedbackRecord = { ...rec, id, at: new Date().toISOString() };
  const pipe = redis.pipeline();
  pipe.zadd(K.feedback, { score: now, member: id });
  pipe.set(feedbackKey(id), JSON.stringify(full), {
    ex: TTL_FEEDBACK_DAYS * 86400,
  });
  await pipe.exec();
}

/** 新しい順に取り出す */
export async function listFeedback(limit = 200): Promise<FeedbackRecord[]> {
  const ids = await redis.zrange<string[]>(K.feedback, 0, limit - 1, {
    rev: true,
  });
  if (!ids || ids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const id of ids) pipe.get(feedbackKey(id));
  const raws = (await pipe.exec()) as unknown[];
  const out: FeedbackRecord[] = [];
  for (const raw of raws) {
    const v = parse<FeedbackRecord>(raw);
    if (v) out.push(v);
  }
  return out;
}

export async function enqueue(q: QueueName, item: QueuedItem): Promise<void> {
  const ttl = (q === "ready" ? 3 : TTL_REVIEW_DAYS) * 86400;
  const pipe = redis.pipeline();
  pipe.zadd(queueKey(q), { score: Date.now(), member: item.guid });
  pipe.set(queueItemKey(q, item.guid), JSON.stringify(item), { ex: ttl });
  pipe.sadd(handledKey(0), item.guid);
  pipe.expire(handledKey(0), HANDLED_TTL_SECONDS);
  await pipe.exec();
}

export async function getQueued(
  q: QueueName,
  guid: string
): Promise<QueuedItem | null> {
  return parse<QueuedItem>(await redis.get(queueItemKey(q, guid)));
}

/** 古い順に返す。速報は先に入ったものから出したいので rev は使わない。 */
export async function listQueue(
  q: QueueName,
  limit = 50
): Promise<QueuedItem[]> {
  const guids = (await redis.zrange(queueKey(q), 0, limit - 1)) as string[];
  if (guids.length === 0) return [];

  const pipe = redis.pipeline();
  for (const g of guids) pipe.get(queueItemKey(q, g));
  const raws = await pipe.exec();

  const items: QueuedItem[] = [];
  const stale: string[] = [];
  raws.forEach((raw, i) => {
    const item = parse<QueuedItem>(raw);
    if (item) items.push(item);
    else stale.push(guids[i]); // TTL切れの残骸
  });
  if (stale.length > 0) {
    // await しない Promise を投げっぱなしにすると unhandled rejection で
    // 関数ごと落ちうる。まとめて1コマンドで掃除し、失敗は握り潰す。
    await redis.zrem(queueKey(q), ...stale).catch(() => undefined);
  }
  return items;
}

export async function dequeue(q: QueueName, guid: string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.zrem(queueKey(q), guid);
  pipe.del(queueItemKey(q, guid));
  await pipe.exec();
}

export async function queueSize(q: QueueName): Promise<number> {
  return (await redis.zcard(queueKey(q))) as number;
}

export async function reject(guid: string, item?: QueuedItem): Promise<void> {
  const pipe = redis.pipeline();
  pipe.zadd(K.rejected, { score: Date.now(), member: guid });
  pipe.zrem(queueKey("review"), guid);
  pipe.zrem(queueKey("ready"), guid);
  pipe.del(queueItemKey("review", guid));
  pipe.del(queueItemKey("ready", guid));
  // 復元できるよう、却下した項目の本体を保存しておく（TTLは投稿済みと同じ）。
  if (item) {
    pipe.set(K.rejectedItem(guid), JSON.stringify(item), {
      ex: TTL_POSTED_DAYS * 86400,
    });
  }
  pipe.sadd(handledKey(0), guid);
  await pipe.exec();
}

/** 却下した項目の一覧（新しい順）。本体が残っている（＝復元可能な）ものだけ返す。 */
export async function listRejected(limit = 30): Promise<QueuedItem[]> {
  const guids = (await redis.zrange(K.rejected, 0, limit - 1, {
    rev: true,
  })) as string[];
  if (guids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const g of guids) pipe.get(K.rejectedItem(g));
  const raws = await pipe.exec();
  const items: QueuedItem[] = [];
  raws.forEach((raw) => {
    const item = parse<QueuedItem>(raw);
    if (item) items.push(item);
  });
  return items;
}

/** 却下を取り消して承認待ちへ戻す。本体が残っていれば true。 */
export async function unreject(guid: string): Promise<boolean> {
  const item = parse<QueuedItem>(await redis.get(K.rejectedItem(guid)));
  if (!item) return false;
  await enqueue("review", item);
  const pipe = redis.pipeline();
  pipe.zrem(K.rejected, guid);
  pipe.del(K.rejectedItem(guid));
  await pipe.exec();
  return true;
}

// ===== 運用設定（管理画面から変更できる）=====

/**
 * 自動投稿のON/OFFと1日の上限。
 *
 * 環境変数だけで持つと、切り替えのたびに Vercel の設定変更と Redeploy が要る。
 * 「承認運用でしばらく様子を見て、良さそうならONにする」という判断を
 * 下すたびに開発作業が発生するのは運用としておかしいので、
 * Redis に置いて管理画面から切り替えられるようにする。
 *
 * Redis に値が無ければ環境変数を既定値として使う（従来どおりの挙動）。
 */
const SETTINGS_KEY = "v2:settings";

export interface BotSettings {
  /** 自動投稿を行うか。false なら判定・照合まで実行してキューに溜めるだけ */
  autoPost: boolean;
  /** 1日の投稿上限 */
  dailyLimit: number;
  updatedAt: string;
  /** 設定がRedisにあるか（無ければ環境変数の既定値） */
  fromRedis: boolean;
}

function settingsFrom(raw: unknown): BotSettings {
  const parsed = parse<Partial<BotSettings>>(raw);
  if (!parsed || typeof parsed.autoPost !== "boolean") {
    // 未設定。環境変数を既定値にする（MAX_DAILY_POSTS=0 なら自動投稿OFF）
    return {
      autoPost: MAX_DAILY_POSTS > 0,
      dailyLimit: MAX_DAILY_POSTS > 0 ? MAX_DAILY_POSTS : 12,
      updatedAt: "",
      fromRedis: false,
    };
  }
  return {
    autoPost: parsed.autoPost,
    dailyLimit:
      typeof parsed.dailyLimit === "number" && parsed.dailyLimit >= 0
        ? parsed.dailyLimit
        : MAX_DAILY_POSTS,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    fromRedis: true,
  };
}

export async function getSettings(): Promise<BotSettings> {
  return settingsFrom(await redis.get(SETTINGS_KEY));
}

export async function setSettings(next: {
  autoPost: boolean;
  dailyLimit: number;
}): Promise<BotSettings> {
  const value: BotSettings = {
    autoPost: next.autoPost,
    dailyLimit: Math.max(0, Math.min(100, Math.floor(next.dailyLimit))),
    updatedAt: new Date().toISOString(),
    fromRedis: true,
  };
  await redis.set(SETTINGS_KEY, JSON.stringify(value));
  return value;
}

// ===== レート制限 =====

export interface RateStatus {
  canPost: boolean;
  reason?: string;
  todayCount: number;
  limit: number;
  minutesUntilNextSlot: number;
  /** 自動投稿がONか */
  autoPost: boolean;
}

export async function getRateStatus(): Promise<RateStatus> {
  const day = jstDateString();
  const [countRaw, lastRaw, settingsRaw] = (await redis
    .pipeline()
    .get(K.daily(day))
    .get(K.lastPost)
    .get(SETTINGS_KEY)
    .exec()) as [unknown, unknown, unknown];

  const settings = settingsFrom(settingsRaw);
  const limit = settings.autoPost ? settings.dailyLimit : 0;
  const todayCount = Number(countRaw ?? 0);
  const last = Number(lastRaw ?? 0);
  const elapsedMin = last ? (Date.now() - last) / 60000 : Infinity;
  const minutesUntilNextSlot = Math.max(
    0,
    Math.ceil(MIN_POST_GAP_MINUTES - elapsedMin)
  );

  const base = {
    todayCount,
    limit,
    minutesUntilNextSlot,
    autoPost: settings.autoPost,
  };

  if (!settings.autoPost) {
    return {
      ...base,
      canPost: false,
      reason: "自動投稿はOFF（管理画面で切り替えられます）",
    };
  }
  if (todayCount >= limit) {
    return {
      ...base,
      canPost: false,
      reason: `本日の投稿上限に到達（${todayCount}/${limit}）`,
    };
  }
  if (minutesUntilNextSlot > 0) {
    return {
      ...base,
      canPost: false,
      reason: `連投防止のため待機中（あと約${minutesUntilNextSlot}分）`,
    };
  }
  return { ...base, canPost: true };
}

export async function recordPost(): Promise<void> {
  const day = jstDateString();
  const pipe = redis.pipeline();
  pipe.incr(K.daily(day));
  pipe.expire(K.daily(day), 3 * 86400);
  pipe.set(K.lastPost, Date.now().toString(), { ex: 3 * 86400 });
  await pipe.exec();
}

// ===== 実行ログ =====

export interface RunLog {
  at: string;
  mode: string;
  fetched: number;
  newCount: number;
  candidates: number;
  classified: number;
  posted: number;
  queued: number;
  skipped: number;
  errors: string[];
  durationMs: number;
  notes: string[];
}

export async function appendRunLog(log: RunLog): Promise<void> {
  const pipe = redis.pipeline();
  pipe.lpush(K.runs, JSON.stringify(log));
  pipe.ltrim(K.runs, 0, RUN_LOG_KEEP - 1);
  await pipe.exec();
}

export async function listRunLogs(limit = 20): Promise<RunLog[]> {
  const raws = (await redis.lrange(K.runs, 0, limit - 1)) as unknown[];
  return raws.map((r) => parse<RunLog>(r)).filter((r): r is RunLog => !!r);
}

export interface PostedSummary {
  guid: string;
  title: string;
  link: string;
  text: string;
  tweetId?: string;
  postedAt: string;
  route: string;
  /** IG同時投稿の結果。"posted" | "skipped" | "failed" | undefined(未対応時) */
  ig?: string;
}

export async function listPosted(limit = 20): Promise<PostedSummary[]> {
  const guids = (await redis.zrange(K.posted, 0, limit - 1, {
    rev: true,
  })) as string[];
  if (guids.length === 0) return [];
  const pipe = redis.pipeline();
  for (const g of guids) pipe.get(K.postItem(g));
  const raws = await pipe.exec();
  const out: PostedSummary[] = [];
  raws.forEach((raw, i) => {
    const item = parse<Omit<PostedSummary, "guid">>(raw);
    if (item) out.push({ guid: guids[i], ...item });
  });
  return out;
}

/** 古いメンバーを刈る。ZSET が無限に育つのを防ぐ。 */
export async function pruneOldEntries(): Promise<void> {
  const now = Date.now();
  const pipe = redis.pipeline();
  pipe.zremrangebyscore(K.posted, 0, now - TTL_POSTED_DAYS * DAY);
  pipe.zremrangebyscore(K.rejected, 0, now - TTL_POSTED_DAYS * DAY);
  pipe.zremrangebyscore(K.feedback, 0, now - TTL_FEEDBACK_DAYS * DAY);
  pipe.zremrangebyscore(K.review, 0, now - TTL_REVIEW_DAYS * DAY);
  pipe.zremrangebyscore(K.ready, 0, now - 3 * DAY);
  await pipe.exec();
}

export async function storeHealth(): Promise<{ ok: boolean; error?: string }> {
  if (!redisUrl || !redisToken) {
    return {
      ok: false,
      error:
        "接続情報が未設定です（KV_REST_API_URL / KV_REST_API_TOKEN もしくは UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）",
    };
  }
  try {
    await redis.set("v2:health", Date.now().toString(), { ex: 120 });
    const v = await redis.get("v2:health");
    return { ok: v != null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const host = redisUrl.replace(/^https?:\/\//, "").split("/")[0];
    return {
      ok: false,
      error: /ENOTFOUND|fetch failed/i.test(msg)
        ? `${host} に接続できません。Upstash のデータベースが削除・休止されている可能性があります（${msg}）`
        : msg,
    };
  }
}

// ===== 同時実行ロック =====

/**
 * Vercel の cron は「同じ実行が二重に届くことがある」と明記されている。
 * ロックを取らないと同じ記事を2回投稿しうるので、実行全体を排他にする。
 */
export async function acquireRunLock(ttlSeconds = 280): Promise<boolean> {
  const res = await redis.set("v2:lock:run", Date.now().toString(), {
    nx: true,
    ex: ttlSeconds,
  });
  return res === "OK";
}

export async function releaseRunLock(): Promise<void> {
  await redis.del("v2:lock:run");
}

/**
 * 記事単位の投稿権を取る。ロックをすり抜けた場合の最後の砦。
 * 一度取れたら TTL 中は同じ記事を誰も投稿できない。
 */
export async function claimForPost(guid: string): Promise<boolean> {
  // cron 間隔（10分）より十分長くしないと、次の実行が始まる瞬間に
  // ロックが切れて二重投稿の窓が開く。
  const res = await redis.set(`v2:claim:${guid}`, "1", {
    nx: true,
    ex: 3600,
  });
  return res === "OK";
}

export async function releaseClaim(guid: string): Promise<void> {
  await redis.del(`v2:claim:${guid}`);
}

// ===== 同一商品の二重投稿の防止 =====

/**
 * 記事ID単位の重複防止だけでは、同じ商品を2回投稿してしまう。
 * コラボ商品はメーカー双方がリリースを出すため、別々の記事IDで
 * 同じ商品が流れてくる（例: サーティワン自身のリリースと、
 * コラボ相手のリリースに同じ新フレーバーが載る）。
 * 投稿済みの商品名を保持し、名前が十分に重なるものは承認待ちに回す。
 */
const POSTED_PRODUCTS_KEY = "v2:products";
const PRODUCT_MEMORY_DAYS = 45;

/** 比較用に商品名を均す。verify.ts の正規化と目的は同じだが独立に持つ */
function productKey(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]\s*$/, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/[＆]/g, "&")
    .replace(/[「」『』“”‘’"'【】・･\s　]/g, "")
    .toLowerCase();
}

function significantTokens(name: string): string[] {
  return name
    .split(/[\s　・･/／、,＆&＋+\-ー―「」『』()（）]+/)
    .map((t) => productKey(t))
    .filter((t) => t.length >= 2);
}

/**
 * 2つの商品名が同一商品を指していそうか。
 *
 * 判定は厳しめにする。同じシリーズの別フレーバー
 * （ANY1 ICE CREAM あずき / ANY1 ICE CREAM 抹茶）は別商品なので、
 * 共通語が多いだけで同一扱いにしてはいけない。
 */
export function looksSameProduct(a: string, b: string): boolean {
  const ka = productKey(a);
  const kb = productKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // 一方が他方を含む（「ミルキーショートケーキ」と「31 ミルキーショートケーキ」）
  if (ka.length >= 5 && kb.includes(ka)) return true;
  if (kb.length >= 5 && ka.includes(kb)) return true;
  // 構成語の重なりで見る
  const ta = new Set(significantTokens(a));
  const tb = new Set(significantTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  // 和集合に対する重なり（Jaccard）で見る。
  // 少ない方を分母にすると、フレーバー違いを取り違える。
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= 0.8;
}

/**
 * 直近に投稿した商品の中に、同じ商品と思われるものがあれば
 * その名前を返す。無ければ null。消費コマンドは1。
 */
export async function findSimilarPostedProduct(
  productName: string
): Promise<string | null> {
  if (!productName) return null;
  const recent = (await redis.zrange(
    POSTED_PRODUCTS_KEY,
    Date.now() - PRODUCT_MEMORY_DAYS * DAY,
    Date.now(),
    { byScore: true }
  )) as string[];
  for (const name of recent) {
    if (looksSameProduct(productName, name)) return name;
  }
  return null;
}

export async function rememberPostedProduct(
  productName: string
): Promise<void> {
  if (!productName) return;
  const pipe = redis.pipeline();
  pipe.zadd(POSTED_PRODUCTS_KEY, { score: Date.now(), member: productName });
  pipe.zremrangebyscore(
    POSTED_PRODUCTS_KEY,
    0,
    Date.now() - PRODUCT_MEMORY_DAYS * DAY
  );
  await pipe.exec();
}
