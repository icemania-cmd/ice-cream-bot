import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { fetchReleaseDetail, type Release } from "@/lib/prtimes";
import { classifyAndCompose, NOTICE_TOPICS } from "@/lib/classify";
import { containsWatchTerms } from "@/lib/filter";
import { isAutoPostPublisher } from "@/lib/trust";
import { verifyPost } from "@/lib/verify";
import {
  enqueue,
  findSimilarPostedProduct,
  getStyleSamples,
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
 *   POST { url: "https://www.atpress.ne.jp/news/..." }
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const target: string = body.url;
    const allowed = /^https:\/\/(prtimes\.jp|www\.atpress\.ne\.jp)\//.test(
      target || ""
    );
    if (!target || !allowed) {
      return NextResponse.json(
        { error: "PR TIMES または @Press の記事URLを url で指定してください" },
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

    // 本番のスキャンと同じ見本で判定する。入口ごとに文面が変わると
    // 「どちらが本物か」が分からなくなる。
    const styleSamples = await getStyleSamples();
    const extraction = await classifyAndCompose(
      release,
      detail.bodyText,
      styleSamples
    );

    const sourceText = `${release.title}\n${release.corp}\n${detail.bodyText}`;
    const noticeLabel = NOTICE_TOPICS[extraction.topic_type];
    // あいぱく関連は、発売告知として成立していても自動投稿しない。
    // 事前フィルタを通さない入口なので、ここで単体の判定を呼ぶ。
    const isWatch = containsWatchTerms(sourceText);

    if (!extraction.is_ice_cream_new_product) {
      // 出店・イベント・コラボは、発売告知でなくても承認待ちに積む。
      // scan と同じ扱いにしないと、拾い直したときだけ消える。
      if (!noticeLabel && !isWatch) {
        await markHandled([target]);
        return NextResponse.json({
          ok: false,
          判定: "アイスの新商品ではないと判定されました",
          理由: extraction.reason,
        });
      }
      const notice: QueuedItem = {
        guid: target,
        title: release.title,
        link: target,
        corp: release.corp,
        publishedAt: release.publishedAt,
        imageUrl: release.imageUrl,
        releaseDate: "",
        productName: "",
        maker: release.corp,
        price: "",
        region: "",
        text: `${release.title}\n${target}`,
        blocking: [],
        warnings: [
          isWatch
            ? "あいぱく関連の記事です（新商品の告知ではありません）。文面は書き足してください。"
            : `${noticeLabel}の記事です（新商品の告知ではありません）。文面は書き足してください。`,
          extraction.reason,
        ].filter(Boolean),
        sourceExcerpt: sourceText.slice(0, 4000),
        createdAt: new Date().toISOString(),
        topicType: extraction.topic_type,
      };
      await enqueue("review", notice);
      return NextResponse.json({
        ok: true,
        入れた先: "承認待ち",
        種類: isWatch ? "あいぱく関連" : noticeLabel,
        理由: extraction.reason,
      });
    }

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

    if (check.autoPostable && isWatch) {
      check.warnings.push("あいぱく関連の記事のため確認が必要です");
      check.autoPostable = false;
    }

    // 自動投稿の門は scan と同じものを通す。
    // ここを素通りさせると、拾い直した記事だけが大手限定の制限を抜ける。
    if (check.autoPostable && !isAutoPostPublisher(release.corp)) {
      check.warnings.push(
        `自動投稿の対象外の配信元のため確認が必要です（配信元: ${release.corp || "不明"}）`
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
      topicType: extraction.topic_type,
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
