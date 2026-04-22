import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews } from "@/lib/rss";
import { generatePost, extractReleaseDate } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import { isAlreadyPosted, markAsPosted, saveReminder, isDuplicateWithCvs } from "@/lib/store";

// 1回のCron実行で投稿する最大件数
const MAX_POSTS_PER_RUN = 1;
// タイムアウト防止: Claude APIを呼ぶ記事の上限（extractReleaseDate + generatePost で ~5s/記事）
const MAX_CLAUDE_CALLS_PER_RUN = 8;

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

    // 3. 新着記事を順番にスキャンし、投稿できるものを探す
    // ※ 1記事しか試さない旧設計を修正：スキップされても次の記事へ進む
    const results = [];
    let postedCount = 0;
    let claudeCallCount = 0;
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const today = jstNow.toISOString().split("T")[0];

    for (const article of newArticles) {
      if (postedCount >= MAX_POSTS_PER_RUN) break;
      if (claudeCallCount >= MAX_CLAUDE_CALLS_PER_RUN) {
        console.log(`⚠️ Claude API呼び出し上限(${MAX_CLAUDE_CALLS_PER_RUN})に達したため残り記事をスキップ`);
        break;
      }

      try {
        // ① CVS投稿済み重複チェック（安価・Claude API不要）
        const cvsDup = await isDuplicateWithCvs(article.title);
        if (cvsDup) {
          console.log(`⏭️ CVS投稿済みのためスキップ: ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_cvs_duplicate" });
          continue;
        }

        // ② pubDate が30日以上前の記事はスキップ（安価）
        const pubDateAge = Date.now() - new Date(article.pubDate).getTime();
        if (pubDateAge > 30 * 24 * 60 * 60 * 1000) {
          console.log(`⏭️ 記事が古すぎるためスキップ (${article.pubDate}): ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_old_article" });
          continue;
        }

        // ③ 発売日チェック（Claude API — ここからカウント）
        claudeCallCount++;
        const releaseDate = await extractReleaseDate(article);

        if (!releaseDate) {
          console.log(`⏭️ 発売日不明スキップ: ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_no_release_date" });
          continue;
        }
        if (releaseDate <= today) {
          console.log(`⏭️ 発売日スキップ: ${releaseDate} <= ${today} - ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_release_date" });
          continue;
        }

        // ④ Claude APIで投稿文を生成
        claudeCallCount++;
        const postText = await generatePost(article);
        console.log(`生成された投稿文:\n${postText}\n`);

        // ⑤ 新商品以外（SKIP）はXに投稿せず記録だけして終了
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
          await markAsPosted(article.guid, article.title, article.imageUrl);

          // リマインド予約を保存（発売が2日以上先の場合のみ）
          // 翌日発売品は本投稿が「前日告知」を兼ねるため不要。
          // また翌日発売にリマインドを保存すると chosenHour=7 が当日7:00 UTC 実行済みで
          // 永久にスキップされるバグ、または12/20時に同日二重投稿になるバグを防ぐ。
          try {
            const tomorrowJst = new Date(jstNow);
            tomorrowJst.setDate(tomorrowJst.getDate() + 1);
            const tomorrowStr = tomorrowJst.toISOString().split("T")[0];

            if (releaseDate > tomorrowStr) {
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
            } else {
              console.log(`📅 リマインド不要（翌日発売のため本投稿が前日告知を兼ねる）: ${article.title}`);
            }
          } catch (reminderError) {
            console.error("リマインド予約エラー:", reminderError);
          }

          postedCount++;
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
      message: `${postedCount}件投稿完了 (${results.length}件スキャン)`,
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
