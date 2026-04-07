import { kv } from "@vercel/kv";

const KEY_PREFIX = "posted:";
const EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30日間保持

/**
 * 投稿済みかどうかを確認する
 */
export async function isAlreadyPosted(guid: string): Promise<boolean> {
  const exists = await kv.exists(`${KEY_PREFIX}${guid}`);
  return exists === 1;
}

/**
 * 投稿済みとしてマークする
 */
export async function markAsPosted(guid: string): Promise<void> {
  await kv.set(`${KEY_PREFIX}${guid}`, "1", { ex: EXPIRY_SECONDS });
}

/**
 * 投稿済み件数を取得（デバッグ用）
 */
export async function getPostedCount(): Promise<number> {
  const keys = await kv.keys(`${KEY_PREFIX}*`);
  return keys.length;
}
