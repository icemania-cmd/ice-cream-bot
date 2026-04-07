import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews } from "@/lib/rss";
import { generatePost } from "@/lib/comment";
import { postTweet } from "@/lib/x-client";
import { isAlreadyPosted, markAsPosted } from "@/lib/store";

// 1回のCron実行で投稿する最大件数（レート制限対策）
const MAX_POSTS_PER_RUN = 10;

// 投稿間隔（ミリ秒）— X APIのレート制限を回避
const POST_INTERVAL_MS = 5000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest) {
  // Vercel Cronからの呼び出しを認証
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("🍦 Cron開始: アイスクリームニュースを取得中...");

    // 1. PR TIMESからRSSを取得
    const articles = await fetchIceCreamNews();
    console.log(`取得記事数: ${articles.length}`);

    // 2. 未投稿の記事をフィルタ
    const newArticles = [];
    for (const article of articles) {
      const posted = await isAlreadyPosted(article.guid);
      if (!posted) {
        newArticles.push(article);
      }
    }
    console.log(`未投稿記事数: ${newArticles.length}`);

    if (newArticles.length === 0) {
      return NextResponse.json({
        message: articles.length === 0
          ? "RSS取得結果が0件です（フィード取得エラーの可能性）"
          : "新しい記事はありません",
        checked: articles.length,
        newArticles: 0,
      });
    }

    // 3. 最大件数まで投稿
    const results = [];
    const toPost = newArticles.slice(0, MAX_POSTS_PER_RUN);

    for (const article of toPost) {
      try {
        // Claude APIで投稿文を生成
        const postText = await generatePost(article);
        console.log(`生成された投稿文:\n${postText}\n`);

        // X APIで投稿
        const result = await postTweet(postText);

        if (result.success) {
          await markAsPosted(article.guid);
          results.push({
            title: article.title,
            tweetId: result.tweetId,
            status: "success",
          });
          console.log(`✅ 投稿成功: ${article.title}`);
        } else {
          results.push({
            title: article.title,
            error: result.error,
            status: "failed",
          });
          console.error(`❌ 投稿失敗: ${article.title} - ${result.error}`);
        }

        // 次の投稿まで待機
        if (toPost.indexOf(article) < toPost.length - 1) {
          await sleep(POST_INTERVAL_MS);
        }
      } catch (error) {
        console.error(`エラー: ${article.title}`, error);
        results.push({
          title: article.title,
          error: error instanceof Error ? error.message : "不明なエラー",
          status: "error",
        });
      }
    }

    return NextResponse.json({
      message: `${results.filter((r) => r.status === "success").length}/${toPost.length}件投稿完了`,
      results,
    });
  } catch (error) {
    console.error("Cronジョブエラー:", error);
    return NextResponse.json(
      { error: "Cronジョブ実行中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
