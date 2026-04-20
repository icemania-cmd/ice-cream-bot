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
export async function markAsPosted(guid: string, title?: string, imageUrl?: string): Promise<void> {
  // title + imageUrl がある場合は JSON で保存（CVSスキャン時の画像参照に使用）
  const value = title && imageUrl
    ? JSON.stringify({ t: title, i: imageUrl })
    : title || "1";
  await redis.set(`${KEY_PREFIX}${guid}`, value, { ex: EXPIRY_SECONDS });
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
  link?: string;
  imageUrl?: string;
  guid: string;
  releaseDate: string; // YYYY-MM-DD
  chosenHour?: number; // リマインド投稿時間（JST）: 7 / 12 / 20
  type?: "prtimes" | "cvs"; // リマインド種別
  store?: string; // CVSリマインド用: コンビニ名
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
  detectedAt: string; // ISO 8601
}

/**
 * CVS商品が既知かどうかを確認する（重複検出）
 */
export async function isCvsProductKnown(productId: string): Promise<boolean> {
  const exists = await redis.exists(`${CVS_PRODUCT_PREFIX}${productId}`);
  return exists === 1;
}

/**
 * PR TIMES記事がCVSで既に投稿済み・または投稿待ちかチェックする
 * 記事タイトルに CVS商品名が含まれていれば重複とみなす
 */
export async function isDuplicateWithCvs(articleTitle: string): Promise<boolean> {
  // 投稿済みチェック
  const postedKeys = await redis.keys(`${CVS_POSTED_PREFIX}*`);
  for (const key of postedKeys) {
    const productId = key.slice(CVS_POSTED_PREFIX.length);
    const productData = await redis.get<string>(`${CVS_PRODUCT_PREFIX}${productId}`);
    if (!productData) continue;
    try {
      const product = (typeof productData === "string" ? JSON.parse(productData) : productData) as CvsProductData;
      if (product.name && product.name.length >= 4 && articleTitle.includes(product.name)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  // 投稿キュー（投稿待ち）チェック — スキャン後・投稿前の窓でも二重投稿を防ぐ
  const queueKeys = await redis.keys(`${CVS_QUEUE_PREFIX}*`);
  for (const key of queueKeys) {
    const productData = await redis.get<string>(key);
    if (!productData) continue;
    try {
      const product = (typeof productData === "string" ? JSON.parse(productData) : productData) as CvsProductData;
      if (product.name && product.name.length >= 4 && articleTitle.includes(product.name)) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

/**
 * CVS商品名がPR TIMESで既に投稿済みかチェックする
 * 商品名の部分一致で重複を防止
 */
export async function isDuplicateWithPrTimes(productName: string): Promise<boolean> {
  const postedKeys = await redis.keys(`${KEY_PREFIX}*`);
  for (const key of postedKeys) {
    const value = await redis.get<string>(key);
    if (!value || typeof value !== "string") continue;
    // JSON形式（{t: title, i: imageUrl}）またはプレーン文字列を解析
    let title = value;
    try {
      const parsed = JSON.parse(value);
      if (parsed.t) title = parsed.t;
    } catch {
      // プレーン文字列そのまま使用
    }
    if (title.includes(productName)) return true;
  }
  return false;
}

/**
 * CVS商品名に対応するPR Times記事の画像URLを返す
 * 商品名またはその構成キーワードとタイトルを部分一致で検索
 * 見つからない場合はnullを返す
 */
export async function findPrTimesImage(productName: string): Promise<string | null> {
  const postedKeys = await redis.keys(`${KEY_PREFIX}*`);
  // 商品名 + 区切り文字で分割した3文字以上のキーワードで検索
  const keywords = [
    productName,
    ...productName.split(/[\s　・「」、。！？〜\/＆&]+/).filter(k => k.length >= 3),
  ];
  for (const key of postedKeys) {
    const value = await redis.get<string>(key);
    if (!value || typeof value !== "string") continue;
    let title = "";
    let imageUrl = "";
    try {
      const parsed = JSON.parse(value);
      title = parsed.t || "";
      imageUrl = parsed.i || "";
    } catch {
      continue; // JSON形式でなければ imageUrl は保存されていない
    }
    if (!imageUrl || !title) continue;
    if (keywords.some(kw => title.includes(kw))) return imageUrl;
  }
  return null;
}

/**
 * CVS商品を保存し、投稿キューに追加する
 */
export async function saveCvsProduct(product: CvsProductData): Promise<void> {
  const productKey = `${CVS_PRODUCT_PREFIX}${product.productId}`;
  const queueKey = `${CVS_QUEUE_PREFIX}${product.productId}`;

  // 商品情報を保存（30日間保持）
  await redis.set(productKey, JSON.stringify(product), { ex: EXPIRY_SECONDS });

  // 投稿キューに追加（投稿されるまで保持、最大7日）
  await redis.set(queueKey, JSON.stringify(product), {
    ex: 60 * 60 * 24 * 7,
  });

  console.log(`CVS商品保存: ${product.store} - ${product.name}`);
}

/**
 * 投稿キューからCVS商品を取得する（未投稿のもの）
 * 最大limit件返す
 */
export async function getCvsProductsToPost(
  limit: number = 1
): Promise<CvsProductData[]> {
  const queueKeys = await redis.keys(`${CVS_QUEUE_PREFIX}*`);
  const products: CvsProductData[] = [];

  for (const key of queueKeys) {
    if (products.length >= limit) break;

    const data = await redis.get<string>(key);
    if (data) {
      try {
        const parsed = typeof data === "string" ? JSON.parse(data) : data;
        const product = parsed as CvsProductData;

        // 既に投稿済みでないかチェック
        const posted = await redis.exists(
          `${CVS_POSTED_PREFIX}${product.productId}`
        );
        if (posted === 0) {
          products.push(product);
        }
      } catch {
        console.error(`CVSキューデータ解析エラー: ${key}`);
      }
    }
  }

  return products;
}

/**
 * CVS商品を投稿済みとしてマークし、キューから削除する
 */
export async function markCvsProductPosted(productId: string): Promise<void> {
  // 投稿済みフラグ（30日保持）
  await redis.set(`${CVS_POSTED_PREFIX}${productId}`, "1", {
    ex: EXPIRY_SECONDS,
  });
  // キューから削除
  await redis.del(`${CVS_QUEUE_PREFIX}${productId}`);
}
