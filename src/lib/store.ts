import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const KEY_PREFIX = "posted:";
const EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30日間保持

/**
 * 投稿済みかどうかを確認する
 */
export async function isAlreadyPosted(guid: string): Promise<boolean> {
  const exists = await redis.exists(`${KEY_PREFIX}${guid}`);
  return exists === 1;
}

/**
 * 投稿済みとしてマークする
 */
export async function markAsPosted(guid: string): Promise<void> {
  await redis.set(`${KEY_PREFIX}${guid}`, "1", { ex: EXPIRY_SECONDS });
}

/**
 * 投稿済み件数を取得（デバッグ用）
 */
export async function getPostedCount(): Promise<number> {
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  return keys.length;
}
