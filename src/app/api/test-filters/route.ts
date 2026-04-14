import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews } from "@/lib/rss";
import { extractReleaseDate } from "@/lib/comment";
import { isAlreadyPosted, getCvsProductsToPost } from "@/lib/store";

/**
 * 発売日文字列を YYYY-MM-DD にパースする（cvs-post/route.ts と同じロジック）
 */
function parseReleaseDate(releaseDate: string): string | null {
  if (!releaseDate || releaseDate === "不明") return null;

  const isoMatch = releaseDate.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  const jpFullMatch = releaseDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jpFullMatch) {
    return `${jpFullMatch[1]}-${jpFullMatch[2].padStart(2, "0")}-${jpFullMatch[3].padStart(2, "0")}`;
  }

  const jpMatch = releaseDate.match(/(\d{1,2})月(\d{1,2})日/);
  if (jpMatch) {
    const year = new Date(Date.now() + 9 * 60 * 60 * 1000).getFullYear();
    return `${year}-${jpMatch[1].padStart(2, "0")}-${jpMatch[2].padStart(2, "0")}`;
  }

  return null;
}

/**
 * フィルター動作確認 API（dry-run）
 *
 * PRTimes RSS 全記事と CVS キュー全商品について、
 * 実際の投稿ロジックと同じ判定を行い結果を JSON で返す。
 * 実際の投稿・Redis書き込みは一切行わない。
 *
 * NOTE: 未投稿・期限内の PRTimes 記事については
 *       発売日抽出のために Claude API を呼ぶため、
 *       該当件数が多い場合はレスポンスに数十秒かかることがある。
 */
export async function GET(request: NextRequest) {
  // 認証
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = jstNow.toISOString().split("T")[0];

  // ===== PRTimes RSSの全記事を検査 =====

  let articles;
  let rssError: string | null = null;
  try {
    articles = await fetchIceCreamNews();
  } catch (e) {
    rssError = e instanceof Error ? e.message : String(e);
    articles = [];
  }

  type PrTimesResult = {
    title: string;
    pubDate: string;
    pubDateAge_days: number;
    releaseDate: string | null;
    verdict: "ok" | "skip";
    reason: string;
  };

  const prtimesResults: PrTimesResult[] = [];

  for (const article of articles) {
    const pubDateAge_days = Math.floor(
      (Date.now() - new Date(article.pubDate).getTime()) / (24 * 60 * 60 * 1000)
    );

    // ① pubDate が 30 日超え → skip（Claude API 不要）
    if (pubDateAge_days > 30) {
      prtimesResults.push({
        title: article.title,
        pubDate: article.pubDate,
        pubDateAge_days,
        releaseDate: null,
        verdict: "skip",
        reason: "pubDate_too_old",
      });
      continue;
    }

    // ② 投稿済み → skip（Claude API 不要）
    const alreadyPosted = await isAlreadyPosted(article.guid);
    if (alreadyPosted) {
      prtimesResults.push({
        title: article.title,
        pubDate: article.pubDate,
        pubDateAge_days,
        releaseDate: null,
        verdict: "skip",
        reason: "already_posted",
      });
      continue;
    }

    // ③ 発売日を抽出（Claude API コール）
    let releaseDate: string | null = null;
    let extractError: string | null = null;
    try {
      releaseDate = await extractReleaseDate(article);
    } catch (e) {
      extractError = e instanceof Error ? e.message : String(e);
    }

    let verdict: "ok" | "skip";
    let reason: string;

    if (extractError) {
      verdict = "skip";
      reason = `extractReleaseDate_error: ${extractError}`;
    } else if (!releaseDate) {
      verdict = "skip";
      reason = "no_release_date";
    } else if (releaseDate <= todayStr) {
      verdict = "skip";
      reason = `release_date_passed (${releaseDate} <= ${todayStr})`;
    } else {
      verdict = "ok";
      reason = `投稿OK (発売日: ${releaseDate})`;
    }

    prtimesResults.push({
      title: article.title,
      pubDate: article.pubDate,
      pubDateAge_days,
      releaseDate,
      verdict,
      reason,
    });
  }

  // ===== CVSキューの全商品を検査 =====

  type CvsResult = {
    name: string;
    store: string;
    releaseDate: string;
    parsedDate: string | null;
    verdict: "ok" | "skip";
    reason: string;
  };

  let cvsProducts;
  let cvsError: string | null = null;
  try {
    // 上限を大きくして全件取得
    cvsProducts = await getCvsProductsToPost(500);
  } catch (e) {
    cvsError = e instanceof Error ? e.message : String(e);
    cvsProducts = [];
  }

  const cvsResults: CvsResult[] = [];

  for (const product of cvsProducts) {
    const parsedDate = parseReleaseDate(product.releaseDate);

    let verdict: "ok" | "skip";
    let reason: string;

    if (!parsedDate) {
      verdict = "skip";
      reason = "no_release_date";
    } else if (parsedDate <= todayStr) {
      verdict = "skip";
      reason = `release_date_passed (${parsedDate} <= ${todayStr})`;
    } else {
      verdict = "ok";
      reason = `投稿OK (発売日: ${parsedDate})`;
    }

    cvsResults.push({
      name: product.name,
      store: product.store,
      releaseDate: product.releaseDate,
      parsedDate,
      verdict,
      reason,
    });
  }

  // ===== レスポンス組み立て =====

  const prtimesOk = prtimesResults.filter((r) => r.verdict === "ok").length;
  const cvsOk = cvsResults.filter((r) => r.verdict === "ok").length;

  return NextResponse.json({
    jstToday: todayStr,
    summary: {
      prtimes_total: prtimesResults.length,
      prtimes_ok: prtimesOk,
      prtimes_skip: prtimesResults.length - prtimesOk,
      cvs_queue_total: cvsResults.length,
      cvs_ok: cvsOk,
      cvs_skip: cvsResults.length - cvsOk,
      ...(rssError ? { rss_error: rssError } : {}),
      ...(cvsError ? { cvs_error: cvsError } : {}),
    },
    prtimes: prtimesResults,
    cvs: cvsResults,
  });
}
