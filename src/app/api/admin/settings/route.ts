import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { getSettings, setSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * 自動投稿のON/OFFと1日の上限を、管理画面から切り替えるための窓口。
 *
 * 環境変数だけで持っていると、切り替えのたびに Vercel の設定変更と
 * Redeploy が必要になる。「承認運用で様子を見て、良ければONにする」という
 * 運用判断のために毎回デプロイするのは筋が悪いので、ここで変えられるようにする。
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await getSettings());
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (typeof body.autoPost !== "boolean") {
      return NextResponse.json(
        { error: "autoPost は true / false で指定してください" },
        { status: 400 }
      );
    }
    const current = await getSettings();
    const dailyLimit =
      typeof body.dailyLimit === "number" ? body.dailyLimit : current.dailyLimit;

    const saved = await setSettings({ autoPost: body.autoPost, dailyLimit });
    return NextResponse.json({
      ok: true,
      settings: saved,
      message: saved.autoPost
        ? `自動投稿をONにしました（1日あたり最大${saved.dailyLimit}件）。投稿待ちに溜まっているものから順に出ます`
        : "自動投稿をOFFにしました。判定と投稿文の生成は続き、投稿待ちに溜まります",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
