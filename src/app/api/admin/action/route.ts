import { NextRequest, NextResponse } from "next/server";
import { getDraft, deleteDraft, markRejected } from "@/lib/drafts";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import { markAsPosted, recordPostTime, incrementDailyCount } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: NextRequest): boolean {
  // ADMIN_SECRET が未設定の間は CRON_SECRET を管理パスワードとして使う
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
  if (!secret) return false; // どちらも未設定なら常に拒否
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

const MAX_TWEET_WEIGHT = 280;

/** X の文字数カウント近似: 全角2・半角1（URLなし前提） */
function tweetWeight(text: string): number {
  let weight = 0;
  for (const ch of text) {
    weight += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return weight;
}

/**
 * 下書きへのアクション
 * POST { guid, action: "approve" | "reject", text? }
 * - approve: (編集済み)本文をその場で X に投稿し、下書きを削除
 * - reject: 下書きを削除し、同じ記事が再生成されないよう記録
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const guid: string = body.guid;
    const action: string = body.action;

    if (!guid || !action) {
      return NextResponse.json({ error: "guid と action は必須です" }, { status: 400 });
    }

    const draft = await getDraft(guid);
    if (!draft) {
      return NextResponse.json({ error: "下書きが見つかりません（期限切れか処理済み）" }, { status: 404 });
    }

    if (action === "reject") {
      await markRejected(guid);
      console.log(`🗑️ 却下: ${draft.title}`);
      return NextResponse.json({ ok: true, action: "rejected" });
    }

    if (action === "approve") {
      const text: string = (typeof body.text === "string" && body.text.trim())
        ? body.text.trim()
        : draft.text;

      const weight = tweetWeight(text);
      if (weight > MAX_TWEET_WEIGHT) {
        return NextResponse.json(
          { error: `本文が長すぎます（${weight}/${MAX_TWEET_WEIGHT}）。短くしてから投稿してください。` },
          { status: 400 }
        );
      }

      // 画像アップロード（失敗してもテキストのみで投稿続行）
      let mediaIds: string[] | undefined;
      if (draft.imageUrl) {
        const mediaId = await uploadImageToX(draft.imageUrl);
        if (mediaId) mediaIds = [mediaId];
      }

      const result = await postTweet(text, mediaIds);
      if (!result.success) {
        console.error(`❌ 投稿失敗: ${result.error}`);
        return NextResponse.json({ error: `X投稿に失敗しました: ${result.error}` }, { status: 502 });
      }

      await markAsPosted(guid, draft.title, draft.imageUrl);
      await recordPostTime();
      await incrementDailyCount();
      await deleteDraft(guid);

      console.log(`✅ 承認投稿成功: ${draft.title} (tweet ${result.tweetId})`);
      return NextResponse.json({ ok: true, action: "posted", tweetId: result.tweetId });
    }

    return NextResponse.json({ error: `不明なアクション: ${action}` }, { status: 400 });
  } catch (error) {
    console.error("承認アクションエラー:", error);
    return NextResponse.json({ error: "処理中にエラーが発生しました" }, { status: 500 });
  }
}
