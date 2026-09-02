import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { fetchReleaseDetail } from "@/lib/prtimes";
import { probeInstagramContainer } from "@/lib/instagram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * IG投稿の診断。コンテナ作成(step1)だけ試し、IG API の生レスポンスを返す。
 * publish しないので Instagram のTLには何も出ない＝実害なし。
 *
 *   GET /api/ig/selftest?key=<ADMIN_SECRET>&url=<記事URL>
 *   GET /api/ig/selftest?key=<ADMIN_SECRET>&image=<画像の直URL>
 *
 * ブラウザから叩けるよう key クエリ認証も許可（診断用途のみ）。
 */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const key = params.get("key") || "";
  const keyOk =
    (process.env.ADMIN_SECRET && key === process.env.ADMIN_SECRET) ||
    (process.env.CRON_SECRET && key === process.env.CRON_SECRET);
  if (!keyOk && !isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let image = params.get("image") || "";
  const url = params.get("url") || "";
  if (!image && url) {
    const detail = await fetchReleaseDetail(url);
    image = detail?.ogImage || "";
    if (!image) {
      return NextResponse.json(
        { error: "記事から og:image を取得できませんでした", url },
        { status: 502 }
      );
    }
  }
  if (!image) {
    return NextResponse.json(
      { error: "url= か image= を指定してください" },
      { status: 400 }
    );
  }

  const caption = "（IG診断・自動テスト。投稿はされません）";
  const result = await probeInstagramContainer(image, caption);
  return NextResponse.json({
    元画像: image,
    結果: result,
    注記:
      "これはコンテナ作成のみの診断です。ok:true かつ status:200 なら投稿できる状態、そうでなければ body にIGの理由が入っています。",
  });
}
