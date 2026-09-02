import crypto from "crypto";
import { redis } from "./store";
import { normalizeImageUrl } from "./x";

/**
 * Instagram への投稿（Instagram API with Instagram Login / graph.instagram.com）。
 *
 * X とちがって IG は「画像必須・テキストのみ不可」。投稿は2段階：
 *   1) メディアコンテナ作成（image_url + caption）
 *   2) コンテナを公開（media_publish）
 * どちらも application/x-www-form-urlencoded で叩く。
 *
 * トークンは60日で失効するが、`refresh_access_token` で延命できる。
 * env の IG_ACCESS_TOKEN を初期値とし、延命後の値は Redis に持つ
 * （env は書き換えられないため）。読み取りは Redis 優先・env フォールバック。
 */

const GRAPH = "https://graph.instagram.com";
const VERSION = process.env.IG_GRAPH_VERSION || "v21.0";
const IG_TIMEOUT_MS = 25000;
/** 延命後トークンの置き場所。env は書けないので実運用値はここに持つ。 */
const IG_TOKEN_KEY = "v2:ig:token";
/** IG のキャプション上限。X 本文はこれより短いので通常は切られない。 */
const CAPTION_MAX = 2200;

/** env に IG_USER_ID と初期トークンが揃っていれば「設定済み」。 */
export function instagramConfigured(): boolean {
  return Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN);
}

/** 実運用トークンを取る。Redis（延命後）優先、無ければ env の初期値。 */
async function getIgToken(): Promise<string> {
  try {
    const stored = await redis.get(IG_TOKEN_KEY);
    if (typeof stored === "string" && stored) return stored;
  } catch {
    /* Redis 不通なら env にフォールバック */
  }
  return process.env.IG_ACCESS_TOKEN || "";
}

async function igFetch(
  url: string,
  body?: URLSearchParams
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IG_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : undefined,
      body: body ? body.toString() : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export interface IgResult {
  /** 投稿できた */
  success?: boolean;
  /** 投稿しなかった（未設定・画像なしなど。失敗とは区別する） */
  skipped?: boolean;
  reason?: string;
  /** 公開されたメディアID */
  mediaId?: string;
  error?: string;
}

/**
 * 画像1枚＋キャプションをIGへ投稿する。
 * X 投稿とは独立した best-effort。呼び出し側は失敗しても X 投稿を止めない。
 */
export async function postInstagram(
  imageUrl: string | undefined,
  caption: string
): Promise<IgResult> {
  if (!instagramConfigured()) return { skipped: true, reason: "IG未設定" };
  if (!imageUrl) return { skipped: true, reason: "画像なし（IGは画像必須）" };

  const igUserId = process.env.IG_USER_ID as string;
  const token = await getIgToken();
  if (!token) return { skipped: true, reason: "IGトークンなし" };

  // IGには最適化プロキシURLを渡す。前提が欠ける場合のみ生URLにフォールバック。
  const image = optimizedImageUrl(imageUrl) || normalizeImageUrl(imageUrl);
  const cap = caption.length > CAPTION_MAX ? caption.slice(0, CAPTION_MAX) : caption;

  try {
    // 1) コンテナ作成
    const create = await igFetch(
      `${GRAPH}/${VERSION}/${igUserId}/media`,
      new URLSearchParams({ image_url: image, caption: cap, access_token: token })
    );
    if (!create.ok) {
      return { success: false, error: `container ${create.status}: ${create.text.slice(0, 300)}` };
    }
    const creationId = safeId(create.text);
    if (!creationId) {
      return { success: false, error: `container応答にidなし: ${create.text.slice(0, 200)}` };
    }

    // 2) 公開
    const publish = await igFetch(
      `${GRAPH}/${VERSION}/${igUserId}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: token })
    );
    if (!publish.ok) {
      return { success: false, error: `publish ${publish.status}: ${publish.text.slice(0, 300)}` };
    }
    return { success: true, mediaId: safeId(publish.text) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function safeId(text: string): string | undefined {
  try {
    const j = JSON.parse(text);
    return (j?.id as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 長期トークンを延命し、新しい値を Redis に保存する。
 * IG の長期トークンは有効期間が24時間以上のものだけ延命できる。
 * 週次 cron（/api/ig/refresh）から呼ぶ想定。
 */
export async function refreshIgToken(): Promise<{
  ok: boolean;
  expiresInDays?: number;
  error?: string;
}> {
  if (!instagramConfigured()) return { ok: false, error: "IG未設定" };
  const token = await getIgToken();
  if (!token) return { ok: false, error: "トークンなし" };
  try {
    const res = await igFetch(
      `${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) return { ok: false, error: `${res.status}: ${res.text.slice(0, 300)}` };
    const json = JSON.parse(res.text);
    if (json?.access_token) {
      await redis.set(IG_TOKEN_KEY, json.access_token as string);
      return {
        ok: true,
        expiresInDays: json.expires_in ? Math.round(json.expires_in / 86400) : undefined,
      };
    }
    return { ok: false, error: `応答にaccess_tokenなし: ${res.text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * env の初期トークンを Redis に流し込む（手動でトークンを再発行したときの復旧用）。
 * /api/ig/refresh?seed=1 から呼ぶ。
 */
export async function seedIgTokenFromEnv(): Promise<boolean> {
  if (!process.env.IG_ACCESS_TOKEN) return false;
  await redis.set(IG_TOKEN_KEY, process.env.IG_ACCESS_TOKEN);
  return true;
}


// ===== IG最適化画像の受け渡し =====
//
// IG は image_url を「公開URL」から取得する仕様。かつ縦横比(4:5〜1.91:1)と
// JPEG形式の制約がある。そこで、元画像URLを bot 自身の署名付きエンドポイント
// /api/ig/image に包んで渡し、IGがそこを取得した瞬間に sharp で最適化JPEGを返す。
// 外部ストレージ不要。署名(HMAC)により、鍵を持つ bot だけが変換URLを作れる
// （不特定の画像を取得させられる踏み台化を防ぐ）。

/** 自分の公開ベースURL（Vercel本番ドメイン）。作れなければ空。 */
function appBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;
  return "";
}

/** 画像プロキシURLの署名に使う秘密。CRON_SECRET を流用（無ければADMIN_SECRET）。 */
function imageSignSecret(): string {
  return process.env.CRON_SECRET || process.env.ADMIN_SECRET || "";
}

function signImage(u: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(u).digest("hex").slice(0, 32);
}

/** IGに渡す最適化画像の公開URL（署名付き）。前提が欠ければ null。 */
export function optimizedImageUrl(src: string): string | null {
  const base = appBaseUrl();
  const secret = imageSignSecret();
  if (!base || !secret) return null;
  const u = Buffer.from(src, "utf8").toString("base64url");
  return `${base}/api/ig/image?u=${u}&sig=${signImage(u, secret)}`;
}

/** /api/ig/image 側の署名検証。 */
export function verifyImageSig(u: string, sig: string): boolean {
  const secret = imageSignSecret();
  if (!secret) return false;
  const expected = signImage(u, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
