import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { MAX_TWEET_WEIGHT } from "@/lib/config";
import { tweetWeight } from "@/lib/verify";
import { postTweet, uploadMedia } from "@/lib/x";
import {
  dequeue,
  getQueued,
  markPosted,
  recordPost,
  reject,
  type QueueName,
} from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 承認待ちに対する操作。
 * POST { guid, queue: "review" | "ready", action: "approve" | "reject", text? }
 *
 * approve は編集後の本文をその場でXへ投稿する。
 * ここではレート制限を掛けない（人間が明示的に押した操作を機械が握り潰さないため）。
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const guid: string = body.guid;
    const action: string = body.action;
    const queue: QueueName = body.queue === "ready" ? "ready" : "review";

    if (!guid || !action) {
      return NextResponse.json(
        { error: "guid と action は必須です" },
        { status: 400 }
      );
    }

    const item = await getQueued(queue, guid);
    if (!item) {
      return NextResponse.json(
        { error: "対象が見つかりません（期限切れか処理済み）" },
        { status: 404 }
      );
    }

    if (action === "reject") {
      await reject(guid);
      return NextResponse.json({ ok: true, action: "却下しました" });
    }

    if (action !== "approve") {
      return NextResponse.json(
        { error: `不明なアクション: ${action}` },
        { status: 400 }
      );
    }

    const text =
      typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : item.text;

    const weight = tweetWeight(text);
    if (weight > MAX_TWEET_WEIGHT) {
      return NextResponse.json(
        { error: `本文が長すぎます（${weight}/${MAX_TWEET_WEIGHT}）` },
        { status: 400 }
      );
    }
    if (/(https?:\/\/|www\.)/i.test(text)) {
      return NextResponse.json(
        { error: "本文にURLが含まれています" },
        { status: 400 }
      );
    }

    let mediaIds: string[] | undefined;
    let imageNote = "画像なし";
    if (item.imageUrl) {
      const media = await uploadMedia(item.imageUrl);
      if (media.mediaId) {
        mediaIds = [media.mediaId];
        imageNote = `画像あり(${media.via})`;
      } else {
        imageNote = `画像アップロード失敗: ${media.error}`;
      }
    }

    const result = await postTweet(text, mediaIds);
    if (!result.success) {
      return NextResponse.json(
        { error: `X投稿に失敗しました: ${result.error}` },
        { status: 502 }
      );
    }

    await markPosted(guid, {
      title: item.title,
      link: item.link,
      text,
      tweetId: result.tweetId,
      imageUrl: item.imageUrl,
      releaseDate: item.releaseDate,
      route: "approved",
    });
    await recordPost();
    await dequeue(queue, guid);

    return NextResponse.json({
      ok: true,
      action: "投稿しました",
      tweetId: result.tweetId,
      imageNote,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
