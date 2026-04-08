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

// ===== リマインド予約機能 =====

const REMINDER_PREFIX = "reminder:";

export interface ReminderData {
  title: string;
  description: string;
  link: string;
  imageUrl?: string;
  guid: string;
  releaseDate: string; // YYYY-MM-DD
  chosenHour?: number; // リマインド投稿時間（JST）: 7 / 12 / 20
}

/**
 * リマインド予約を保存する
 * キー: reminder:YYYY-MM-DD:{guid}
 * 発売日+2日後に自動削除
 */
export async function saveReminder(data: ReminderData): Promise<void> {
  const key = `${REMINDER_PREFIX}${data.releaseDate}:${data.guid}`;
  // 発売日の2日後に自動削除
  const releaseTime = new Date(data.releaseDate + "T00:00:00+09:00").getTime();
  const ttlSeconds = Math.max(
    Math.floor((releaseTime + 2 * 24 * 60 * 60 * 1000 - Date.now()) / 1000),
    60 * 60 * 24 // 最低1日は保持
  );

  await redis.set(key, JSON.stringify(data), { ex: ttlSeconds });
  console.log(`リマインド予約保存: ${data.releaseDate} - ${data.title}`);
}

/**
 * 指定日付のリマインド予約を取得する
 * date: YYYY-MM-DD（発売日）
 */
export async function getRemindersForDate(
  date: string
): Promise<ReminderData[]> {
  const pattern = `${REMINDER_PREFIX}${date}:*`;
  const keys = await redis.keys(pattern);
  console.log(`リマインド検索: ${pattern} → ${keys.length}件`);

  const reminders: ReminderData[] = [];
  for (const key of keys) {
    const data = await redis.get<string>(key);
    if (data) {
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        reminders.push(parsed as ReminderData);
      } catch {
        console.error(`リマインドデータ解析エラー: ${key}`);
      }
    }
  }
  return reminders;
}

/**
 * リマインド投稿済みとしてマークする
 */
export async function isReminderPosted(guid: string): Promise<boolean> {
  const exists = await redis.exists(`reminder_posted:${guid}`);
  return exists === 1;
}

export async function markReminderAsPosted(guid: string): Promise<void> {
  await redis.set(`reminder_posted:${guid}`, "1", { ex: EXPIRY_SECONDS });
}
