import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { verifyFinalText } from "@/lib/verify";
import { postTweet, uploadMedia, uploadMediaBuffer } from "@/lib/x";
import { postInstagram, optimizedImageUrl, storedImageUrl } from "@/lib/instagram";
import {
  claimForPost,
  dequeue,
  findSimilarPostedProduct,
  getQueued,
  jstDateString,
  markPosted,
  recordPost,
  recordFeedback,
  rememberStyleSample,
  reject,
  unreject,
  setIgUpload,
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

    // 却下の取り消し（承認待ちへ戻す）。review/ready のどちらでもない操作なので先に処理する。
    if (action === "restore") {
      const ok = await unreject(guid);
      return NextResponse.json(
        ok
          ? { ok: true, action: "承認待ちに戻しました" }
          : { error: "復元できませんでした（保存期限切れの可能性）" },
        { status: ok ? 200 : 404 }
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
      await reject(guid, item);
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

    // ここまで、承認経路の検査は「長さ」と「URL」だけだった。
    // そのため古いコードが作った文面や、承認画面で書き換えた文面が
    // 事実照合を一度も通らずに X へ出ていた。
    // 出す文そのものを、投稿の直前にもう一度突き合わせる。
    const finalCheck = verifyFinalText({
      text,
      sourceText: item.sourceExcerpt || "",
      today: jstDateString(),
    });

    if (finalCheck.blocking.length > 0) {
      return NextResponse.json(
        {
          error: `この文面は投稿できません: ${finalCheck.blocking.join(" / ")}`,
          投稿できない理由: finalCheck.blocking,
        },
        { status: 400 }
      );
    }

    // 原文に無い数字は、人が「それでも出す」と言うまで出さない。
    // 押した操作を機械が握り潰さないが、素通りもさせない。
    if (finalCheck.unverified.length > 0 && body.confirmUnverified !== true) {
      return NextResponse.json(
        {
          needsFactConfirm: true,
          unverified: finalCheck.unverified,
          error:
            "原文で確認できない内容があります:\n\n" +
            finalCheck.unverified.map((u) => `・${u}`).join("\n") +
            "\n\n原文を確認しましたか？ このまま投稿しますか？",
        },
        { status: 409 }
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

    // ---- 投稿先と画像 ----
    //   target:    "x" | "ig" | "both"（既定 x）
    //   imageMode: "none" | "pick" | "upload"
    //     pick   … 候補（プレス画像・記事内画像）から選んだURL。改ざん防止のため候補内に限る
    //     upload … 承認画面で差し替えた画像（dataURL）
    // X と IG は同じ画像を使う。IG は画像必須。
    // 旧クライアント（igMode / igPickUrl / igUploadData）からの要求も受ける。
    const legacyIgMode: string =
      typeof body.igMode === "string" ? body.igMode : "none";
    const target: "x" | "ig" | "both" =
      body.target === "ig" || body.target === "both" || body.target === "x"
        ? body.target
        : ["press", "pick", "upload"].includes(legacyIgMode)
          ? "both"
          : "x";
    const wantX = target === "x" || target === "both";
    const wantIg = target === "ig" || target === "both";

    let imageMode: "none" | "pick" | "upload";
    let pickUrl: string | undefined;
    let uploadData: string | undefined;
    if (body.imageMode === "none" || body.imageMode === "pick" || body.imageMode === "upload") {
      imageMode = body.imageMode;
      pickUrl = typeof body.imagePickUrl === "string" ? body.imagePickUrl : undefined;
      uploadData = typeof body.imageUploadData === "string" ? body.imageUploadData : undefined;
    } else if (legacyIgMode === "pick" || legacyIgMode === "upload") {
      imageMode = legacyIgMode;
      pickUrl = typeof body.igPickUrl === "string" ? body.igPickUrl : undefined;
      uploadData = typeof body.igUploadData === "string" ? body.igUploadData : undefined;
    } else {
      // 指定が無ければ従来どおりプレス画像を使う
      imageMode = item.imageUrl ? "pick" : "none";
      pickUrl = item.imageUrl;
    }

    const candidates = [item.imageUrl, ...(item.images || [])].filter(
      Boolean
    ) as string[];

    // 画像を、X 用（アップロード元）と IG 用（公開URL）の両方の形に解決する
    let xImageSource: { url?: string; data?: { buffer: Buffer; contentType: string } } = {};
    let igImageUrl: string | null = null;
    let imageNote = "画像なし";

    if (imageMode === "pick") {
      if (!pickUrl || !candidates.includes(pickUrl)) {
        await releaseClaim(guid);
        return NextResponse.json(
          { error: "選択された画像が候補に含まれていません" },
          { status: 400 }
        );
      }
      xImageSource = { url: pickUrl };
      igImageUrl = optimizedImageUrl(pickUrl);
    } else if (imageMode === "upload") {
      const m = (uploadData || "").match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) {
        await releaseClaim(guid);
        return NextResponse.json(
          { error: "アップロード画像が不正です" },
          { status: 400 }
        );
      }
      xImageSource = { data: { buffer: Buffer.from(m[2], "base64"), contentType: m[1] } };
      await setIgUpload(guid, m[2]).catch(() => undefined);
      igImageUrl = storedImageUrl(guid);
    }

    if (wantIg && !igImageUrl) {
      await releaseClaim(guid);
      return NextResponse.json(
        { error: "Instagram には画像が必要です。画像を選ぶかアップロードしてください" },
        { status: 400 }
      );
    }

    // ---- X ----
    let tweetId: string | undefined;
    let xNote = "";
    if (wantX) {
      let mediaIds: string[] | undefined;
      if (xImageSource.url || xImageSource.data) {
        const media = xImageSource.data
          ? await uploadMediaBuffer(xImageSource.data)
          : await uploadMedia(xImageSource.url as string);
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
      tweetId = result.tweetId;
      xNote = "Xに投稿";
    }

    // ---- Instagram ----
    // 両方のときは X の失敗で止まり、IG の失敗では X を巻き戻さない。
    // IG だけのときは IG の失敗がそのまま失敗。
    let igNote = "IGなし";
    let igStatus: string | undefined;
    if (wantIg && igImageUrl) {
      const ig = await postInstagram(igImageUrl, text);
      if (ig.success) {
        igNote = "IGに投稿";
        igStatus = "posted";
      } else if (ig.skipped) {
        igNote = `IGスキップ(${ig.reason})`;
        igStatus = "skipped";
      } else {
        igNote = `IG投稿失敗(${ig.error})`;
        igStatus = "failed";
        console.error("[IG] approve post failed:", ig.error);
      }
      if (!wantX && igStatus !== "posted") {
        await releaseClaim(guid);
        return NextResponse.json({ error: igNote }, { status: 502 });
      }
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

    // 実際に世に出した文を、次回以降の文体の見本にする。
    // 発売告知だけを対象にする。出店・イベントの告知は形式が違うので、
    // 混ぜると発売告知の文面が崩れる。
    // topicType が無いのは、この仕組みを入れる前に積まれた項目。
    // 商品名が入っていれば発売告知として扱ってよい。
    const isProductPost = item.topicType
      ? item.topicType === "new_product"
      : Boolean(item.productName);
    if (isProductPost) {
      await rememberStyleSample(text).catch(() => undefined);
    }

    await rememberPostedProduct(item.productName);

    await markPosted(guid, {
      title: item.title,
      link: item.link,
      text,
      tweetId,
      imageUrl: pickUrl || item.imageUrl,
      releaseDate: item.releaseDate,
      route: "approved",
      ig: igStatus,
    });
    // 1日の投稿数は X の枠なので、X に出したときだけ数える
    if (wantX) await recordPost();
    await dequeue(queue, guid);

    return NextResponse.json({
      ok: true,
      action: [xNote, igNote].filter((n) => n && n !== "IGなし").join(" / ") || "投稿しました",
      tweetId,
      imageNote,
      igNote,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
