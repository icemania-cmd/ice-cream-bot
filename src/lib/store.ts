import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const KEY_PREFIX = "posted:";
const EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30日間保持

// ===== 投稿済み管理 =====

export async function isAlreadyPosted(guid: string): Promise<boolean> {
  const exists = await redis.exists(`${KEY_PREFIX}${guid}`);
  return exists === 1;
}

export async function markAsPosted(guid: string, title?: string, imageUrl?: string): Promise<void> {
  const value = title && imageUrl
    ? JSON.stringify({ t: title, i: imageUrl })
    : title || "1";
  await redis.set(`${KEY_PREFIX}${guid}`, value, { ex: EXPIRY_SECONDS });
}

export async function getPostedCount(): Promise<number> {
  const keys = await redis.keys(`${KEY_PREFIX}*`);
  return keys.length;
}

// ===== グローバル投稿レート制限 =====

const LAST_POST_TIME_KEY = "last_post_time";
const POST_GAP_MS = 15 * 60 * 1000; // 15分

/** 直前の投稿から15分以上経過しているか確認する */
export async function canPostNow(): Promise<boolean> {
  const lastPostTime = await redis.get<string>(LAST_POST_TIME_KEY);
  if (!lastPostTime) return true;
  return Date.now() - parseInt(lastPostTime as string) >= POST_GAP_MS;
}

/** 投稿時刻を記録する */
export async function recordPostTime(): Promise<void> {
  await redis.set(LAST_POST_TIME_KEY, Date.now().toString(), { ex: 60 * 60 * 24 });
}

// ===== 1日の投稿上限（20件）=====

const DAILY_COUNT_PREFIX = "daily_post_count:";
const MAX_DAILY_POSTS = 20;

function getJstDateStr(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

/** 本日の投稿件数が上限未満か確認する */
export async function canPostToday(): Promise<boolean> {
  const key = `${DAILY_COUNT_PREFIX}${getJstDateStr()}`;
  const count = await redis.get<string>(key);
  return !count || parseInt(count as string) < MAX_DAILY_POSTS;
}

/** 本日の投稿件数をインクリメントして現在値を返す */
export async function incrementDailyCount(): Promise<number> {
  const key = `${DAILY_COUNT_PREFIX}${getJstDateStr()}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 48 * 3600);
  return count;
}

// ===== リマインド予約機能 =====

const REMINDER_PREFIX = "reminder:";

export type ReminderType = "week_before" | "three_days_before" | "day_before" | "release_day";

export interface ReminderData {
  title: string;
  description: string;
  link: string;
  imageUrl?: string;
  guid: string;
  releaseDate: string;      // 発売日 YYYY-MM-DD
  reminderType: ReminderType;
  scheduledDate: string;    // 投稿予定日 YYYY-MM-DD
  scheduledHour: number;    // JST: 7 / 12 / 20
  scheduledMinute: number;  // 0-59 ランダム
  // 旧形式との互換用（読み込み時のみ）
  chosenHour?: number;
}

/**
 * リマインド予約を保存する
 * キー: reminder:{scheduledDate}:{reminderType}:{guid}
 */
export async function saveReminder(data: ReminderData): Promise<void> {
  const key = `${REMINDER_PREFIX}${data.scheduledDate}:${data.reminderType}:${data.guid}`;
  // 発売日+2日後に自動削除
  const releaseTime = new Date(data.releaseDate + "T00:00:00+09:00").getTime();
  const ttlSeconds = Math.max(
    Math.floor((releaseTime + 2 * 24 * 60 * 60 * 1000 - Date.now()) / 1000),
    60 * 60 * 24
  );
  await redis.set(key, JSON.stringify(data), { ex: ttlSeconds });
  console.log(`リマインド予約保存: ${data.scheduledDate} ${data.scheduledHour}:${String(data.scheduledMinute).padStart(2, "0")} [${data.reminderType}] - ${data.title}`);
}

/**
 * 複数のリマインドをまとめて予約する
 * daysUntilRelease に応じてスケジュールするタイプを決定する
 */
export async function scheduleReminders(
  article: {
    title: string;
    description: string;
    link: string;
    imageUrl?: string;
    guid: string;
    releaseDate: string;
  },
  daysUntilRelease: number
): Promise<void> {
  const HOUR_SLOTS = [7, 12, 20];

  // スケジュールするタイプと投稿予定日を決定
  const entries: { type: ReminderType; scheduledDate: string }[] = [];

  const addDays = (base: string, days: number): string => {
    const d = new Date(base + "T00:00:00+09:00");
    d.setDate(d.getDate() + days);
    return d.toISOString().split("T")[0];
  };

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];

  if (daysUntilRelease >= 8) {
    const d = addDays(article.releaseDate, -7);
    if (d > today) entries.push({ type: "week_before", scheduledDate: d });
  }
  if (daysUntilRelease >= 4) {
    const d = addDays(article.releaseDate, -3);
    if (d > today) entries.push({ type: "three_days_before", scheduledDate: d });
  }
  if (daysUntilRelease >= 2) {
    const d = addDays(article.releaseDate, -1);
    if (d > today) entries.push({ type: "day_before", scheduledDate: d });
  }
  // release_day は常に追加（当日は7時台固定）
  entries.push({ type: "release_day", scheduledDate: article.releaseDate });

  // 同日に複数ある場合は時間枠が被らないよう割り当て
  const usedHours: Record<string, number[]> = {};
  for (const { type, scheduledDate } of entries) {
    usedHours[scheduledDate] = usedHours[scheduledDate] ?? [];
    let hour: number;
    if (type === "release_day") {
      hour = 7; // 発売当日は朝固定
    } else {
      const available = HOUR_SLOTS.filter(h => !usedHours[scheduledDate].includes(h));
      const pool = available.length > 0 ? available : HOUR_SLOTS;
      hour = pool[Math.floor(Math.random() * pool.length)];
    }
    usedHours[scheduledDate].push(hour);
    const minute = Math.floor(Math.random() * 60);

    await saveReminder({
      ...article,
      reminderType: type,
      scheduledDate,
      scheduledHour: hour,
      scheduledMinute: minute,
    });
  }
}

/**
 * 指定日・時・分のリマインドを取得する（10分窓）
 * 旧形式（chosenHour あり）にも対応
 */
export async function getRemindersForTimeSlot(
  date: string,
  jstHour: number,
  jstMinute: number
): Promise<ReminderData[]> {
  const pattern = `${REMINDER_PREFIX}${date}:*`;
  const keys = await redis.keys(pattern);
  console.log(`リマインド検索: ${pattern} → ${keys.length}件`);

  const windowStart = Math.floor(jstMinute / 10) * 10;
  const windowEnd = windowStart + 10;

  const reminders: ReminderData[] = [];
  for (const key of keys) {
    const raw = await redis.get<string>(key);
    if (!raw) continue;
    try {
      const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ReminderData> & { chosenHour?: number };

      // 旧形式の正規化（reminderType なし → day_before 扱い）
      if (!parsed.reminderType) {
        const chosenHour = parsed.chosenHour ?? 20;
        if (chosenHour !== jstHour) continue;
        reminders.push({
          ...parsed,
          reminderType: "day_before",
          scheduledDate: date,
          scheduledHour: chosenHour,
          scheduledMinute: 0, // 旧形式は分の概念なし、常にマッチ
        } as ReminderData);
        continue;
      }

      // 新形式: 時刻ウィンドウチェック
      if (parsed.scheduledHour !== jstHour) continue;
      const min = parsed.scheduledMinute ?? 0;
      if (min < windowStart || min >= windowEnd) continue;

      reminders.push(parsed as ReminderData);
    } catch {
      console.error(`リマインドデータ解析エラー: ${key}`);
    }
  }
  return reminders;
}

/** 旧形式との互換用: 発売日でリマインドを取得 */
export async function getRemindersForDate(date: string): Promise<ReminderData[]> {
  return getRemindersForTimeSlot(date, 20, 0);
}

// ===== リマインド投稿済み管理 =====

export async function isReminderTypePosted(reminderType: ReminderType, guid: string): Promise<boolean> {
  // 新形式キー
  const newKey = `reminder_posted:${reminderType}:${guid}`;
  if (await redis.exists(newKey) === 1) return true;
  // 旧形式キー（day_before の後方互換）
  if (reminderType === "day_before") {
    const oldKey = `reminder_posted:${guid}`;
    if (await redis.exists(oldKey) === 1) return true;
  }
  return false;
}

export async function markReminderTypeAsPosted(reminderType: ReminderType, guid: string): Promise<void> {
  await redis.set(`reminder_posted:${reminderType}:${guid}`, "1", { ex: EXPIRY_SECONDS });
}

/** 旧形式との互換用 */
export async function isReminderPosted(guid: string): Promise<boolean> {
  return isReminderTypePosted("day_before", guid);
}

export async function markReminderAsPosted(guid: string): Promise<void> {
  await redis.set(`reminder_posted:${guid}`, "1", { ex: EXPIRY_SECONDS });
}

// ===== 発売日キャッシュ（Claude API節約用）=====

const RELEASE_DATE_PREFIX = "release_date:";

export async function getCachedReleaseDate(
  guid: string
): Promise<string | null | undefined> {
  const v = await redis.get<string>(`${RELEASE_DATE_PREFIX}${guid}`);
  if (v === null || v === undefined) return undefined;
  if (v === "NONE") return null;
  return typeof v === "string" ? v : String(v);
}

export async function setCachedReleaseDate(
  guid: string,
  date: string | null
): Promise<void> {
  const ttl = date ? EXPIRY_SECONDS : 60 * 60;
  await redis.set(`${RELEASE_DATE_PREFIX}${guid}`, date ?? "NONE", { ex: ttl });
}

// ===== CVSコンビニ商品スクレイピング機能 =====

const CVS_PRODUCT_PREFIX = "cvs_product:";
const CVS_QUEUE_PREFIX = "cvs_queue:";
const CVS_POSTED_PREFIX = "cvs_posted:";

export interface CvsProductData {
  store: string;
  name: string;
  maker: string;
  price: string;
  releaseDate: string;
  region: string;
  description: string;
  imageUrl: string;
  productId: string;
  detectedAt: string;
}

export async function isCvsProductKnown(productId: string): Promise<boolean> {
  const exists = await redis.exists(`${CVS_PRODUCT_PREFIX}${productId}`);
  return exists === 1;
}

export async function isDuplicateWithPrTimes(productName: string): Promise<boolean> {
  const postedKeys = await redis.keys(`${KEY_PREFIX}*`);
  for (const key of postedKeys) {
    const value = await redis.get(key);
    if (!value) continue;
    let title = "";
    if (typeof value === "object" && value !== null) {
      title = (value as Record<string, string>).t || "";
    } else if (typeof value === "string") {
      title = value;
    } else {
      continue;
    }
    if (title && title.includes(productName)) return true;
  }
  return false;
}

export async function findPrTimesImage(productName: string): Promise<string | null> {
  const postedKeys = await redis.keys(`${KEY_PREFIX}*`);
  const keywords = [
    productName,
    ...productName.split(/[\s　・「」、。！？〜\/＆&]+/).filter(k => k.length >= 3),
  ];
  for (const key of postedKeys) {
    const value = await redis.get(key);
    if (!value) continue;
    let title = "";
    let imageUrl = "";
    if (typeof value === "object" && value !== null) {
      const obj = value as Record<string, string>;
      title = obj.t || "";
      imageUrl = obj.i || "";
    } else { continue; }
    if (!imageUrl || !title) continue;
    if (keywords.some(kw => title.includes(kw))) return imageUrl;
  }
  return null;
}

export async function saveCvsProduct(product: CvsProductData): Promise<void> {
  const productKey = `${CVS_PRODUCT_PREFIX}${product.productId}`;
  const queueKey = `${CVS_QUEUE_PREFIX}${product.productId}`;
  await redis.set(productKey, JSON.stringify(product), { ex: EXPIRY_SECONDS });
  await redis.set(queueKey, JSON.stringify(product), { ex: 60 * 60 * 24 * 7 });
  console.log(`CVS商品保存: ${product.store} - ${product.name}`);
}

export async function getCvsProductsToPost(limit: number = 1): Promise<CvsProductData[]> {
  const queueKeys = await redis.keys(`${CVS_QUEUE_PREFIX}*`);
  const products: CvsProductData[] = [];
  for (const key of queueKeys) {
    if (products.length >= limit) break;
    const data = await redis.get<string>(key);
    if (data) {
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        const product = parsed as CvsProductData;
        const posted = await redis.exists(`${CVS_POSTED_PREFIX}${product.productId}`);
        if (posted === 0) products.push(product);
      } catch {
        console.error(`CVSキューデータ解析エラー: ${key}`);
      }
    }
  }
  return products;
}

export async function markCvsProductPosted(productId: string): Promise<void> {
  await redis.set(`${CVS_POSTED_PREFIX}${productId}`, "1", { ex: EXPIRY_SECONDS });
  await redis.del(`${CVS_QUEUE_PREFIX}${productId}`);
}
