import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { listPosted, listQueue, listRunLogs, queueSize } from "@/lib/store";

export const dynamic = "force-dynamic";

/** 管理画面が読む一覧。承認待ち・投稿待ち・直近の投稿・実行ログをまとめて返す。 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [review, ready, posted, runs, readyCount, reviewCount] =
      await Promise.all([
        listQueue("review", 50),
        listQueue("ready", 20),
        listPosted(20),
        listRunLogs(10),
        queueSize("ready"),
        queueSize("review"),
      ]);
    return NextResponse.json({
      review,
      ready,
      posted,
      runs,
      counts: { ready: readyCount, review: reviewCount },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
