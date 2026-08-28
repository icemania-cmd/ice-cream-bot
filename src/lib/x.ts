import crypto from "crypto";
import { BROWSER_UA } from "./config";

/**
 * X API クライアント（OAuth 1.0a ユーザーコンテキスト）
 *
 * 旧実装は画像を upload.twitter.com/1.1/media/upload.json に投げていたが、
 * X は v1.1 のメディアアップロードを廃止し api.x.com/2/media/upload へ移行した。
 * ここでは v2 を本線にし、v1.1 は保険としてのみ残す。
 */

const TWEET_URL = "https://api.x.com/2/tweets";
const MEDIA_V2_URL = "https://api.x.com/2/media/upload";
const MEDIA_V1_URL = "https://upload.twitter.com/1.1/media/upload.json";

/** X が画像1枚に許す上限 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

interface Credentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export function getCredentials(): Credentials {
  return {
    apiKey: process.env.X_API_KEY || "",
    apiSecret: process.env.X_API_SECRET || "",
    accessToken: process.env.X_ACCESS_TOKEN || "",
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || "",
  };
}

export function missingCredentials(): string[] {
  const c = getCredentials();
  return Object.entries(c)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * OAuth 1.0a の Authorization ヘッダを組み立てる。
 *
 * bodyParams を渡すのは Content-Type が application/x-www-form-urlencoded の
 * ときだけ。multipart や JSON のボディは仕様上、署名ベース文字列に含めない。
 * ここを取り違えると 401 が出続ける。
 */
function buildAuthHeader(
  method: string,
  url: string,
  credentials: Credentials,
  bodyParams?: Record<string, string>
): string {
  const u = new URL(url);
  const baseUrl = `${u.origin}${u.pathname}`;
  const queryParams: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    queryParams[k] = v;
  });

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...queryParams, ...oauthParams, ...(bodyParams || {}) };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(
    credentials.accessTokenSecret
  )}`;

  oauthParams.oauth_signature = crypto
    .createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(", ")
  );
}

// ===== 画像 =====

/**
 * PR TIMES の画像は Fastly 配信なので、リサイズパラメータを付けて
 * 5MB 制限に確実に収める。他ホストはそのまま取得する。
 */
export function normalizeImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("fastly.net") && !u.searchParams.has("width")) {
      u.searchParams.set("width", "1400");
      u.searchParams.set("format", "jpeg");
      u.searchParams.set("quality", "85");
    }
    return u.toString();
  } catch {
    return url;
  }
}

export interface DownloadedImage {
  buffer: Buffer;
  contentType: string;
}

export async function downloadImage(
  imageUrl: string
): Promise<{ image?: DownloadedImage; error?: string }> {
  const url = normalizeImageUrl(imageUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `画像取得失敗 HTTP ${res.status}` };

    const buffer = Buffer.from(await res.arrayBuffer());
    let contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
      // Content-Type が信用できない配信元があるのでマジックナンバーで判定
      if (buffer.subarray(0, 3).toString("hex") === "ffd8ff") contentType = "image/jpeg";
      else if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") contentType = "image/png";
      else if (buffer.subarray(0, 3).toString("ascii") === "GIF") contentType = "image/gif";
      else return { error: `未対応の画像形式: ${contentType || "不明"}` };
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      return { error: `画像が5MBを超過: ${buffer.length} bytes` };
    }
    if (buffer.length < 1024) {
      return { error: `画像が小さすぎます: ${buffer.length} bytes` };
    }
    return { image: { buffer, contentType } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function buildMultipart(
  image: DownloadedImage,
  fields: Record<string, string>
): { body: Buffer; contentType: string } {
  const boundary = `----IceCreamBot${crypto.randomBytes(12).toString("hex")}`;
  const ext = image.contentType.split("/")[1] || "jpg";
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="image.${ext}"\r\n` +
        `Content-Type: ${image.contentType}\r\n\r\n`
    )
  );
  chunks.push(image.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export interface MediaUploadResult {
  mediaId?: string;
  /** どのエンドポイントで成功したか。運用時の切り分け用に必ず残す。 */
  via?: "v2" | "v1.1";
  error?: string;
}

/** v2 のシンプルアップロード。multipart なのでボディは署名に含めない。 */
async function uploadV2(
  image: DownloadedImage,
  credentials: Credentials
): Promise<MediaUploadResult> {
  const { body, contentType } = buildMultipart(image, {
    media_category: "tweet_image",
  });
  const res = await fetch(MEDIA_V2_URL, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader("POST", MEDIA_V2_URL, credentials),
      "Content-Type": contentType,
    },
    body: new Uint8Array(body),
  });
  const textBody = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(textBody);
  } catch {
    /* HTML エラーページが返ることがある */
  }
  if (!res.ok) {
    return { error: `v2 ${res.status}: ${textBody.slice(0, 300)}` };
  }
  const data = (json.data as Record<string, unknown>) || json;
  const mediaId =
    (data.id as string) ||
    (data.media_id_string as string) ||
    (data.media_key as string);
  if (!mediaId) return { error: `v2 応答に media id なし: ${textBody.slice(0, 300)}` };
  return { mediaId, via: "v2" };
}

/** 旧 v1.1。廃止済みだがアカウントによってはまだ通るため保険として残す。 */
async function uploadV1(
  image: DownloadedImage,
  credentials: Credentials
): Promise<MediaUploadResult> {
  const base64 = image.buffer.toString("base64");
  const res = await fetch(MEDIA_V1_URL, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader("POST", MEDIA_V1_URL, credentials, {
        media_data: base64,
      }),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `media_data=${percentEncode(base64)}`,
  });
  const textBody = await res.text();
  if (!res.ok) return { error: `v1.1 ${res.status}: ${textBody.slice(0, 300)}` };
  try {
    const json = JSON.parse(textBody);
    if (json.media_id_string) {
      return { mediaId: json.media_id_string as string, via: "v1.1" };
    }
  } catch {
    /* noop */
  }
  return { error: `v1.1 応答に media id なし: ${textBody.slice(0, 200)}` };
}

export async function uploadMedia(
  imageUrl: string
): Promise<MediaUploadResult> {
  const credentials = getCredentials();
  const { image, error } = await downloadImage(imageUrl);
  if (!image) return { error };

  try {
    const v2 = await uploadV2(image, credentials);
    if (v2.mediaId) return v2;
    const v1 = await uploadV1(image, credentials);
    if (v1.mediaId) return v1;
    return { error: `${v2.error} / ${v1.error}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ===== 投稿 =====

export interface PostResult {
  success: boolean;
  tweetId?: string;
  error?: string;
  /** レート制限で弾かれた場合 true（呼び出し側でその日の投稿を止める） */
  rateLimited?: boolean;
}

export async function postTweet(
  text: string,
  mediaIds?: string[]
): Promise<PostResult> {
  const credentials = getCredentials();
  const body: Record<string, unknown> = { text };
  if (mediaIds && mediaIds.length > 0) body.media = { media_ids: mediaIds };

  try {
    const res = await fetch(TWEET_URL, {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader("POST", TWEET_URL, credentials),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const textBody = await res.text();
    if (!res.ok) {
      return {
        success: false,
        error: `${res.status} ${textBody.slice(0, 400)}`,
        rateLimited: res.status === 429,
      };
    }
    const json = JSON.parse(textBody);
    return { success: true, tweetId: json?.data?.id };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 認証情報が生きているかだけを確認する（投稿はしない） */
export async function verifyCredentials(): Promise<{
  ok: boolean;
  username?: string;
  error?: string;
}> {
  const credentials = getCredentials();
  const url = "https://api.x.com/2/users/me";
  try {
    const res = await fetch(url, {
      headers: { Authorization: buildAuthHeader("GET", url, credentials) },
    });
    const textBody = await res.text();
    if (!res.ok) return { ok: false, error: `${res.status} ${textBody.slice(0, 200)}` };
    const json = JSON.parse(textBody);
    return { ok: true, username: json?.data?.username };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
