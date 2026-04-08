import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews } from "@/lib/rss";
import { generatePost, extractReleaseDate } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import { isAlreadyPosted, markAsPosted, saveReminder } from "@/lib/store";

// 1回のCron実行で投稿する最大件数
// Xアルゴリズム対策: 33分おきにcronを実行し、1件ずつ投稿する
const MAX_POSTS_PER_RUN = 1;

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
        // ① 発売日チェック: 投稿日より前の発売日はスキップ
        const releaseDate = await extractReleaseDate(article);
        if (releaseDate) {
          // 日本時間(JST=UTC+9)で今日の日付を取得
          const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const today = jstNow.toISOString().split("T")[0];
          if (releaseDate < today) {
            console.log(`⏭️ 発売日スキップ: ${releaseDate} < ${today} - ${article.title}`);
            await markAsPosted(article.guid);
            results.push({ title: article.title, status: "skipped_past_release" });
            continue;
          }
        }

        // ② Claude APIで投稿文を生成
        const postText = await generatePost(article);
        console.log(`生成された投稿文:\n${postText}\n`);

        // ③ 新商品以外（SKIP）はXに投稿せず記録だけして終了
        if (postText.trim() === "SKIP") {
          console.log(`⏭️ 新商品以外のためスキップ: ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_not_new_product" });
          continue;
        }

        // 画像がある場合はアップロード
        let mediaIds: string[] | undefined;
        if (article.imageUrl) {
          console.log(`画像アップロード: ${article.imageUrl}`);
          const mediaId = await uploadImageToX(article.imageUrl);
          if (mediaId) {
            mediaIds = [mediaId];
            console.log(`画像アップロード成功: ${mediaId}`);
          } else {
            console.log("画像アップロード失敗、テキストのみで投稿");
          }
        }

        // X APIで投稿（画像があれば添付）
        const result = await postTweet(postText, mediaIds);

        if (result.success) {
          await markAsPosted(article.guid);

          // 発売日が未来の場合はリマインド予約を保存（①で取得済みのreleaseDateを再利用）
          try {
            if (releaseDate) {
              const jstNow2 = new Date(Date.now() + 9 * 60 * 60 * 1000);
              const today2 = jstNow2.toISOString().split("T")[0];
              if (releaseDate > today2) {
                // 7時・12時・20時からランダムに投稿時間を選択（bot感を減らすため）
                const REMINDER_HOURS = [7, 12, 20];
                const chosenHour = REMINDER_HOURS[Math.floor(Math.random() * REMINDER_HOURS.length)];
                await saveReminder({
                  title: article.title,
                  description: article.description,
                  link: article.link,
                  imageUrl: article.imageUrl,
                  guid: article.guid,
                  releaseDate,
                  chosenHour,
                });
                console.log(`📅 リマインド予約: ${releaseDate} ${chosenHour}時 - ${article.title}`);
              }
            }
          } catch (reminderError) {
            console.error("リマインド予約エラー:", reminderError);
          }

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
