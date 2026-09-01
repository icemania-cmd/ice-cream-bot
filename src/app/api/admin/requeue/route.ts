import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { fetchReleaseDetail, type Release } from "@/lib/prtimes";
import { classifyAndCompose } from "@/lib/classify";
import { verifyPost } from "@/lib/verify";
import {
  enqueue,
  findSimilarPostedProduct,
  jstDateString,
  markHandled,
  type QueuedItem,
} from "@/lib/store";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * 記事URLを指定して、キューに入れ直す。
 *
 * フィルタの取りこぼしは「処理済み」として記録されるため、
 * フィルタを直しても過去の記事は自動では拾い直されない。
 * 直した直後に「あの記事を拾って」と言える窓口が要る。
 *
 * 事前フィルタは通さない（人が「これはアイスだ」と判断して渡すため）。
 * Claudeの判定と事実照合は通常どおり行う。
 *
 *   POST { url: "https://prtimes.jp/main/html/rd/p/..." }
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const target: string = body.url;
    if (!target || !/^https:\/\/prtimes\.jp\//.test(target)) {
      return NextResponse.json(
        { error: "PR TIMES の記事URLを url で指定してください" },
        { status: 400 }
      );
    }

    const detail = await fetchReleaseDetail(target);
    if (!detail?.bodyText) {
      return NextResponse.json(
        { error: "記事本文を取得できませんでした" },
        { status: 502 }
      );
    }

    const release: Release = {
      guid: target,
      title: detail.ogTitle || "",
      link: target,
      summary: detail.bodyText.slice(0, 1500),
      corp: detail.ogSiteName || "",
      publishedAt: new Date().toISOString(),
      imageUrl: detail.ogImage,
      source: "requeue",
    };

    const extraction = await classifyAndCompose(release, detail.bodyText);
    if (!extraction.is_ice_cream_new_product) {
      await markHandled([target]);
      return NextResponse.json({
        ok: false,
        判定: "アイスの新商品ではないと判定されました",
        理由: extraction.reason,
      });
    }

    const sourceText = `${release.title}\n${release.corp}\n${detail.bodyText}`;
    const check = verifyPost({
      extraction,
      sourceText,
      today: jstDateString(),
    });

    const twin = await findSimilarPostedProduct(extraction.product_name);
    if (twin) {
      check.warnings.push(
        `同じ商品を既に投稿している可能性があります（投稿済み: 「${twin}」）`
      );
      check.autoPostable = false;
    }

    const queue = check.autoPostable ? "ready" : "review";
    const item: QueuedItem = {
      guid: target,
      title: release.title,
      link: target,
      corp: release.corp,
      publishedAt: release.publishedAt,
      imageUrl: release.imageUrl,
      releaseDate: extraction.release_date,
      productName: extraction.product_name,
      maker: extraction.maker,
      price: extraction.price,
      region: extraction.region,
      text: check.text,
      blocking: check.blocking,
      warnings: check.warnings,
      sourceExcerpt: sourceText.slice(0, 4000),
      createdAt: new Date().toISOString(),
    };
    await enqueue(queue, item);

    return NextResponse.json({
      ok: true,
      入れた先: queue === "ready" ? "投稿待ち" : "承認待ち",
      投稿文: check.text,
      文字数: `${check.weight}/280`,
      承認待ちに回る理由: check.warnings,
      投稿不可の問題: check.blocking,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
