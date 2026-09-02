import { MAX_TWEET_WEIGHT } from "@/lib/config";
import { NextRequest, NextResponse } from "next/server";
import { fetchReleaseDetail, type Release } from "@/lib/prtimes";
import { prefilter } from "@/lib/filter";
import { classifyAndCompose } from "@/lib/classify";
import { verifyPost } from "@/lib/verify";
import { getStyleSamples, jstDateString } from "@/lib/store";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * 記事URLを1本指定して、判定から投稿文生成・事実照合までを試すだけの窓口。
 *
 * 本番の cron はアイスの新商品が実際に配信されるまで何も起きないため、
 * 「来たときにちゃんと動くのか」をその場で確かめる手段が要る。
 * X への投稿も状態の書き換えも一切行わない。フィルタ調整にも使える。
 *
 *   GET /api/try?url=https://prtimes.jp/main/html/rd/p/000000091.000068877.html
 *
 * 事前フィルタで落ちる記事でも、判定まで進めたい場合は &force=1 を付ける。
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const target = params.get("url");
  const force = params.get("force") === "1";

  if (!target || !/^https:\/\/prtimes\.jp\//.test(target)) {
    return NextResponse.json(
      { error: "PR TIMES の記事URLを url= で指定してください" },
      { status: 400 }
    );
  }

  const detail = await fetchReleaseDetail(target);
  if (!detail || !detail.bodyText) {
    return NextResponse.json(
      { error: "記事本文を取得できませんでした（URLを確認してください）" },
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
    source: "try",
  };

  const pf = prefilter(release);
  if (!pf.passed && !force) {
    return NextResponse.json({
      判定: "事前フィルタで除外",
      理由: pf.reason,
      補足: "この記事でも判定まで進めたい場合は &force=1 を付けてください",
      記事: { タイトル: release.title, 配信元: release.corp },
    });
  }

  // 本番と同じ見本で試せるようにする。ここが違うと試験の意味が薄れる。
  const styleSamples = await getStyleSamples();
  const extraction = await classifyAndCompose(
    release,
    detail.bodyText,
    styleSamples
  );

  if (!extraction.is_ice_cream_new_product) {
    return NextResponse.json({
      判定: "アイスの新商品ではない",
      理由: extraction.reason,
      事前フィルタ: pf.passed ? `通過（${pf.reason}）` : `本来は除外（${pf.reason}）`,
      記事: { タイトル: release.title, 配信元: release.corp },
    });
  }

  const sourceText = `${release.title}\n${release.corp}\n${detail.bodyText}`;
  const check = verifyPost({
    extraction,
    sourceText,
    today: jstDateString(),
  });

  return NextResponse.json({
    判定: check.autoPostable ? "自動投稿の対象" : "承認待ちに回る",
    事前フィルタ: pf.passed ? `通過（${pf.reason}）` : `本来は除外（${pf.reason}）`,
    投稿文: check.text,
    文字数: `${check.weight}/${MAX_TWEET_WEIGHT}`,
    抽出結果: {
      商品名: extraction.product_name,
      メーカー: extraction.maker,
      価格: extraction.price,
      発売日: extraction.release_date,
      発売日の原文表記: extraction.release_date_text || "(空)",
      販売エリア: extraction.region,
    },
    投稿不可の問題: check.blocking,
    承認待ちに回る理由: check.warnings,
    画像: release.imageUrl || "(取得できず)",
    配信元の取得結果: release.corp || "(取得できず)",
    注記: "この窓口はXへの投稿も状態の書き換えも行いません",
  });
}
