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

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || "",
  token: process.env.KV_REST_API_TOKEN || "",
});

const K = {
  posted: "v2:posted",
  review: "v2:review",
  ready: "v2:ready",
  rejected: "v2:rejected",
  runs: "v2:runs",
  lastPost: "v2:lastpost",
  daily: (jstDate: string) => `v2:daily:${jstDate}`,
  postItem: (guid: string) => `v2:post:${guid}`,
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

export async function reject(guid: string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.zadd(K.rejected, { score: Date.now(), member: guid });
  pipe.zrem(queueKey("review"), guid);
  pipe.zrem(queueKey("ready"), guid);
  pipe.del(queueItemKey("review", guid));
  pipe.del(queueItemKey("ready", guid));
  pipe.sadd(handledKey(0), guid);
  await pipe.exec();
}

// ===== レート制限 =====

export interface RateStatus {
  canPost: boolean;
  reason?: string;
  todayCount: number;
  limit: number;
  minutesUntilNextSlot: number;
}

export async function getRateStatus(): Promise<RateStatus> {
  const day = jstDateString();
  const [countRaw, lastRaw] = (await redis
    .pipeline()
    .get(K.daily(day))
    .get(K.lastPost)
    .exec()) as [unknown, unknown];

  const todayCount = Number(countRaw ?? 0);
  const last = Number(lastRaw ?? 0);
  const elapsedMin = last ? (Date.now() - last) / 60000 : Infinity;
  const minutesUntilNextSlot = Math.max(
    0,
    Math.ceil(MIN_POST_GAP_MINUTES - elapsedMin)
  );

  if (todayCount >= MAX_DAILY_POSTS) {
    return {
      canPost: false,
      reason: `本日の投稿上限に到達（${todayCount}/${MAX_DAILY_POSTS}）`,
      todayCount,
      limit: MAX_DAILY_POSTS,
      minutesUntilNextSlot,
    };
  }
  if (minutesUntilNextSlot > 0) {
    return {
      canPost: false,
      reason: `連投防止のため待機中（あと約${minutesUntilNextSlot}分）`,
      todayCount,
      limit: MAX_DAILY_POSTS,
      minutesUntilNextSlot,
    };
  }
  return {
    canPost: true,
    todayCount,
    limit: MAX_DAILY_POSTS,
    minutesUntilNextSlot: 0,
  };
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
  pipe.zremrangebyscore(K.review, 0, now - TTL_REVIEW_DAYS * DAY);
  pipe.zremrangebyscore(K.ready, 0, now - 3 * DAY);
  await pipe.exec();
}

export async function storeHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await redis.set("v2:health", Date.now().toString(), { ex: 120 });
    const v = await redis.get("v2:health");
    return { ok: v != null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
