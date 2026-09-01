import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { MAX_TWEET_WEIGHT } from "@/lib/config";
import { tweetWeight } from "@/lib/verify";
import { postTweet, uploadMedia } from "@/lib/x";
import {
  claimForPost,
  dequeue,
  findSimilarPostedProduct,
  getQueued,
  markPosted,
  recordPost,
  recordFeedback,
  reject,
  rememberPostedProduct,
  releaseClaim,
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
      // なぜ出さなかったのかを残す。ここを捨てると、フィルタもプロンプトも
      // 「なんとなく」でしか直せなくなる。
      await recordFeedback({
        guid,
        kind: "reject",
        title: item.title,
        link: item.link,
        corp: item.corp,
        topicType: item.topicType,
        productName: item.productName,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 40) : "",
        memo: typeof body.memo === "string" ? body.memo.slice(0, 500) : "",
        draftText: item.text,
      }).catch(() => undefined); // 記録の失敗で却下操作を止めない
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

    // 同じ商品を既に投稿していないか。
    // 承認待ちに入れた時点では未投稿でも、その後に別記事（コラボ相手の
    // リリースなど）が自動投稿されていることがある。人が押した操作を
    // 機械が握り潰さないよう、止めずに確認を求める形にする。
    if (body.confirmDuplicate !== true) {
      const twin = await findSimilarPostedProduct(item.productName);
      if (twin) {
        return NextResponse.json(
          {
            needsConfirm: true,
            error: `同じ商品を既に投稿している可能性があります（投稿済み: 「${twin}」）。それでも投稿しますか？`,
          },
          { status: 409 }
        );
      }
    }

    // 承認ボタンと cron の /api/scan が同じ記事を同時に掴みうる。
    // 投稿権を取ってから投稿しないと、人が押した瞬間に二重投稿になる。
    if (!(await claimForPost(guid))) {
      return NextResponse.json(
        {
          error:
            "この記事は別の処理が投稿中です。数分おいて一覧を再読み込みしてください。",
        },
        { status: 409 }
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
      // 投稿された可能性が残る失敗では権利を返さない（再押下での二重投稿を防ぐ）
      if (result.definitelyNotPosted) {
        await releaseClaim(guid);
        return NextResponse.json(
          { error: `X投稿に失敗しました: ${result.error}` },
          { status: 502 }
        );
      }
      return NextResponse.json(
        {
          error: `X投稿の結果が確認できませんでした（${result.error}）。Xのタイムラインを確認してください。投稿されていなければ数分後に再度お試しください。`,
        },
        { status: 502 }
      );
    }

    // 承認前に文面を書き換えていたら、その差分を残す。
    // Claude の下書きと実際に世に出した文の差そのもので、
    // 文体を直すときの材料として一番あてになる。
    if (text !== item.text) {
      await recordFeedback({
        guid,
        kind: "edit",
        title: item.title,
        link: item.link,
        corp: item.corp,
        topicType: item.topicType,
        productName: item.productName,
        draftText: item.text,
        finalText: text,
      }).catch(() => undefined);
    }

    await rememberPostedProduct(item.productName);
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
