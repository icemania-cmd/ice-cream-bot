import { NextRequest, NextResponse } from "next/server";
import { listDrafts } from "@/lib/drafts";

export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  // ADMIN_SECRET が未設定の間は CRON_SECRET を管理パスワードとして使う
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
  if (!secret) return false; // どちらも未設定なら常に拒否
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/** 承認待ち下書きの一覧を返す */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const drafts = await listDrafts();
    return NextResponse.json({ drafts });
  } catch (error) {
    console.error("下書き一覧取得エラー:", error);
    return NextResponse.json({ error: "下書き一覧の取得に失敗しました" }, { status: 500 });
  }
}
