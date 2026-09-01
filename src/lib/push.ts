import webpush from "web-push";
import { redis } from "./store";

/**
 * 承認待ちが増えたことをスマホへ通知する（Web Push）。
 *
 * 管理画面を常に見に行くのは現実的でないので、通知が来たら見に行く形にする。
 * 通知の送信は投稿の可否に関係しないため、ここでの失敗は
 * スキャン全体を止めない（呼び出し側で握りつぶす）。
 */

const SUBS_KEY = "v2:push:subs";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  addedAt: string;
  label?: string;
}

/** 公開鍵はブラウザに配るものなので秘密ではない */
export const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:noreply@example.com";

export function pushConfigured(): boolean {
  return Boolean(vapidPublicKey && vapidPrivateKey);
}

function applyVapid() {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

export async function saveSubscription(
  sub: PushSubscriptionRecord
): Promise<void> {
  // endpoint をフィールド名にすることで、同じ端末の再登録が重複しない
  await redis.hset(SUBS_KEY, { [sub.endpoint]: JSON.stringify(sub) });
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await redis.hdel(SUBS_KEY, endpoint);
}

export async function listSubscriptions(): Promise<PushSubscriptionRecord[]> {
  const all = await redis.hgetall<Record<string, unknown>>(SUBS_KEY);
  if (!all) return [];
  const out: PushSubscriptionRecord[] = [];
  for (const raw of Object.values(all)) {
    try {
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (v && typeof v === "object" && (v as any).endpoint) {
        out.push(v as PushSubscriptionRecord);
      }
    } catch {
      // 壊れた項目は無視する。通知のために全体を止めない。
    }
  }
  return out;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushResult {
  sent: number;
  expired: number;
  errors: string[];
  skipped?: string;
}

/**
 * 登録済みの全端末に送る。
 * 404/410 は購読が失効した合図なので、その場で削除する。
 * 放置すると毎回失敗して、そのうち何も届かなくなったと勘違いする。
 */
export async function sendPush(payload: PushPayload): Promise<PushResult> {
  if (!pushConfigured()) {
    return { sent: 0, expired: 0, errors: [], skipped: "VAPID鍵が未設定" };
  }
  const subs = await listSubscriptions();
  if (subs.length === 0) {
    return { sent: 0, expired: 0, errors: [], skipped: "通知先の端末が未登録" };
  }

  applyVapid();
  const body = JSON.stringify(payload);
  let sent = 0;
  let expired = 0;
  const errors: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          body,
          { TTL: 3600 }
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          await removeSubscription(s.endpoint).catch(() => undefined);
          expired++;
        } else {
          errors.push(
            `${code ?? "?"}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    })
  );

  return { sent, expired, errors };
}

/** 承認待ち・投稿待ちが増えたことを知らせる */
export async function notifyQueued(input: {
  review: number;
  ready: number;
  sampleTitle: string;
}): Promise<PushResult> {
  const parts: string[] = [];
  if (input.review > 0) parts.push(`承認待ち${input.review}件`);
  if (input.ready > 0) parts.push(`投稿待ち${input.ready}件`);
  const head = parts.join("・") + "が増えました";
  const title = input.sampleTitle
    ? input.sampleTitle.slice(0, 60)
    : "アイス速報Bot";
  return sendPush({
    title: `🍦 ${head}`,
    body: title,
    url: "/admin",
    tag: "ice-review",
  });
}
