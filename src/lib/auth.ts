import type { NextRequest } from "next/server";

/**
 * 管理画面の認証。
 *
 * ADMIN_SECRET と CRON_SECRET のどちらでも通す。
 *
 * 権限の広さで言えば CRON_SECRET のほうが強い。CRON_SECRET は /api/scan を
 * 叩けて、その結果 X への投稿まで起こせるためだ。したがって管理画面を
 * CRON_SECRET でも開けるようにすることは、セキュリティ上の後退にならない。
 *
 * 逆に ADMIN_SECRET だけを唯一の鍵にしていると、Vercel で Sensitive 指定した
 * 値を忘れた時点で管理画面に入れなくなる（Sensitive は書き込み専用で、
 * ダッシュボードからも vercel env pull からも再取得できない）。
 * 実際にそれが起きたので、締め出されない作りに変えた。
 */
export function adminSecrets(): string[] {
  return [process.env.ADMIN_SECRET, process.env.CRON_SECRET].filter(
    (v): v is string => !!v
  );
}

export function isAdmin(request: NextRequest): boolean {
  const secrets = adminSecrets();
  if (secrets.length === 0) return false; // どちらも未設定なら常に拒否

  const header = request.headers.get("authorization");
  const direct = request.headers.get("x-admin-secret");

  return secrets.some((s) => header === `Bearer ${s}` || direct === s);
}
