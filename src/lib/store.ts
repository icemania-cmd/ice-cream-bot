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

export async function isDuplicateWithCvs(articleTitle: string): Promise<boolean> {
  const postedKeys = await redis.keys(`${CVS_POSTED_PREFIX}*`);
  for (const key of postedKeys) {
    const productId = key.slice(CVS_POSTED_PREFIX.length);
    const productData = await redis.get<string>(`${CVS_PRODUCT_PREFIX}${productId}`);
    if (!productData) continue;
    try {
      const product = (typeof productData === "string" ? JSON.parse(productData) : productData) as CvsProductData;
      if (product.name && product.name.length >= 4 && articleTitle.includes(product.name)) return true;
    } catch { continue; }
  }
  const queueKeys = await redis.keys(`${CVS_QUEUE_PREFIX}*`);
  for (const key of queueKeys) {
    const productData = await redis.get<string>(key);
    if (!productData) continue;
    try {
      const product = (typeof productData === "string" ? JSON.parse(productData) : productData) as CvsProductData;
      if (product.name && product.name.length >= 4 && articleTitle.includes(product.name)) return true;
    } catch { continue; }
  }
  return false;
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
