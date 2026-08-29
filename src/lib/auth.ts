import type { NextRequest } from "next/server";

/**
 * 管理画面の認証。
 * ADMIN_SECRET があればそれを、無ければ CRON_SECRET を使う。
 * どちらも無い場合は必ず拒否する（未設定で全開放にしない）。
 */
export function adminSecret(): string | null {
  return process.env.ADMIN_SECRET || process.env.CRON_SECRET || null;
}

export function isAdmin(request: NextRequest): boolean {
  const secret = adminSecret();
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  // 画面側から fetch する際に使うヘッダも許可する
  return request.headers.get("x-admin-secret") === secret;
}
