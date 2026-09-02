import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { refreshIgToken, seedIgTokenFromEnv } from "@/lib/instagram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * IG 長期トークンの延命。週次 cron（Vercel）と手動の両方から叩ける。
 * Vercel cron は CRON_SECRET を Bearer で送るので、それを受ける。
 * 管理画面の鍵（x-admin-secret / ADMIN_SECRET）でも叩ける。
 *
 *   GET /api/ig/refresh            … 延命
 *   GET /api/ig/refresh?seed=1     … env の初期トークンを Redis へ流し込んでから延命
 *                                     （トークンを手動で再発行したときの復旧用）
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret && auth === `Bearer ${cronSecret}`);
  if (!viaCron && !isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const seed = new URL(request.url).searchParams.get("seed") === "1";
  if (seed) {
    const ok = await seedIgTokenFromEnv();
    if (!ok) {
      return NextResponse.json(
        { error: "IG_ACCESS_TOKEN が未設定のため seed できません" },
        { status: 400 }
      );
    }
  }

  const result = await refreshIgToken();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    seeded: seed,
    残り有効日数: result.expiresInDays ?? "(不明)",
  });
}
