import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews, fetchOgImage, type PressRelease } from "@/lib/rss";
import { generatePost, generateReminderPost, generateReleaseDayPost, extractReleaseDate } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import {
  isAlreadyPosted,
  markAsPosted,
  scheduleReminders,
  getCachedReleaseDate,
  setCachedReleaseDate,
  canPostNow,
  canPostToday,
  recordPostTime,
  incrementDailyCount,
  isDuplicateWithCvs,
} from "@/lib/store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_POSTS_PER_RUN = 3;

type Enriched = { article: PressRelease; releaseDate: string | null };

/** 発売日文字列(YYYY-MM-DD)と今日のJST日付から残り日数を計算する */
function daysUntilRelease(releaseDate: string, todayStr: string): number {
  const rel = new Date(releaseDate + "T00:00:00+09:00").getTime();
  const tod = new Date(todayStr + "T00:00:00+09:00").getTime();
  return Math.round((rel - tod) / (1000 * 60 * 60 * 24));
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("🍦 Cron開始: PR Times スキャン");

    const articles = await fetchIceCreamNews();
    console.log(`取得記事数: ${articles.length}`);

    // 未投稿フィルタ
    const newArticles: PressRelease[] = [];
    for (const article of articles) {
      if (!(await isAlreadyPosted(article.guid))) newArticles.push(article);
    }
    console.log(`未投稿記事数: ${newArticles.length}`);

    if (newArticles.length === 0) {
      return NextResponse.json({
        message: articles.length === 0
          ? "RSS取得結果が0件（フィード取得エラーの可能性）"
          : "新しい記事はありません",
        checked: articles.length,
        newArticles: 0,
      });
    }

    // 発売日を並列抽出（キャッシュ優先）
    const enriched: Enriched[] = await Promise.all(
      newArticles.map(async (article) => {
        let releaseDate = await getCachedReleaseDate(article.guid);
        if (releaseDate === undefined) {
          releaseDate = await extractReleaseDate(article);
          await setCachedReleaseDate(article.guid, releaseDate);
        }
        return { article, releaseDate };
      })
    );

    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const today = jstNow.toISOString().split("T")[0];
    const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

    // 発売日フィルタ: 過去・発売日不明を除外
    const eligible: { article: PressRelease; releaseDate: string; days: number }[] = [];
    for (const { article, releaseDate } of enriched) {
      // CVS投稿済み重複チェック（安価・Claude API不要）
      const cvsDup = await isDuplicateWithCvs(article.title);
      if (cvsDup) {
        console.log(`⏭️ CVS投稿済みのためスキップ: ${article.title}`);
        await markAsPosted(article.guid);
        continue;
      }

      const pubDateAge = Date.now() - new Date(article.pubDate).getTime();
      if (pubDateAge > 30 * 24 * 60 * 60 * 1000) {
        console.log(`⏭️ 記事が古すぎるためスキップ: ${article.title}`);
        await markAsPosted(article.guid);
        continue;
      }
      if (!releaseDate) {
        if (pubDateAge < RETRY_WINDOW_MS) {
          console.log(`⏭️ 発売日不明（再試行待ち）: ${article.title}`);
          await setCachedReleaseDate(article.guid, null);
        } else {
          console.log(`⏭️ 発売日不明スキップ（諦める）: ${article.title}`);
          await markAsPosted(article.guid);
        }
        continue;
      }
      const days = daysUntilRelease(releaseDate, today);
      if (days < 0) {
        console.log(`⏭️ 発売済みスキップ: ${releaseDate} - ${article.title}`);
        await markAsPosted(article.guid);
        continue;
      }
      eligible.push({ article, releaseDate, days });
    }

    // 発売日が近い順にソート
    eligible.sort((a, b) => a.days - b.days);
    const toProcess = eligible.slice(0, MAX_POSTS_PER_RUN);

    console.log(`処理予定: ${toProcess.length}件`);

    const results: Array<Record<string, unknown>> = [];

    for (const { article, releaseDate, days } of toProcess) {
      try {
        // レート制限チェック
        if (!(await canPostToday())) {
          console.log(`⛔ 本日の投稿上限(20件)に達したため停止`);
          results.push({ title: article.title, status: "skipped_daily_limit" });
          continue;
        }
        if (!(await canPostNow())) {
          console.log(`⏳ 15分ギャップ未達のためスキップ: ${article.title}`);
          results.push({ title: article.title, status: "skipped_gap" });
          continue;
        }

        let postText: string;
        let postType: string;

        if (days === 0) {
          // 発売当日: 【本日発売！】
          postType = "release_day";
          postText = await generateReleaseDayPost(article);
          if (!postText.startsWith("【本日発売！】")) postText = "【本日発売！】" + postText;
        } else if (days === 1) {
          // 翌日発売: 【リマインド】のみ（新商品投稿なし）
          postType = "day_before_reminder";
          postText = await generateReminderPost(article, "day_before");
          if (!postText.startsWith("【リマインド】")) postText = "【リマインド】" + postText;
        } else {
          // 2日以上先: 【新商品】
          postType = "new_product";
          postText = await generatePost(article);
          if (postText.trim() === "SKIP") {
            console.log(`⏭️ 新商品以外のためスキップ: ${article.title}`);
            await markAsPosted(article.guid);
            results.push({ title: article.title, status: "skipped_not_new_product" });
            continue;
          }
          if (!postText.startsWith("【新商品】")) postText = "【新商品】" + postText;
        }

        console.log(`投稿文[${postType}]:\n${postText}\n`);

        // og:image 取得（未取得の場合のみ）
        if (!article.imageUrl && article.link) {
          article.imageUrl = await fetchOgImage(article.link);
        }

        // 画像アップロード
        let mediaIds: string[] | undefined;
        if (article.imageUrl) {
          const mediaId = await uploadImageToX(article.imageUrl);
          if (mediaId) {
            mediaIds = [mediaId];
            console.log(`画像アップロード成功: ${mediaId}`);
          }
        }

        // 投稿
        const result = await postTweet(postText, mediaIds);
        if (result.success) {
          await recordPostTime();
          await incrementDailyCount();
          await markAsPosted(article.guid, article.title, article.imageUrl);

          // リマインド予約（翌日発売はrelease_dayのみ、それ以外は発売日に応じてスケジュール）
          try {
            if (days === 1) {
              // 翌日発売 → release_day のみ予約
              await scheduleReminders(
                { title: article.title, description: article.description, link: article.link, imageUrl: article.imageUrl, guid: article.guid, releaseDate },
                1
              );
            } else if (days >= 2) {
              await scheduleReminders(
                { title: article.title, description: article.description, link: article.link, imageUrl: article.imageUrl, guid: article.guid, releaseDate },
                days
              );
            }
          } catch (reminderError) {
            console.error("リマインド予約エラー:", reminderError);
          }

          results.push({ title: article.title, tweetId: result.tweetId, releaseDate, postType, days, status: "success" });
          console.log(`✅ 投稿成功[${postType}]: ${article.title}`);
        } else {
          results.push({ title: article.title, error: result.error, status: "failed" });
          console.error(`❌ 投稿失敗: ${result.error}`);
        }
      } catch (error) {
        console.error(`エラー: ${article.title}`, error);
        results.push({ title: article.title, error: error instanceof Error ? error.message : "不明なエラー", status: "error" });
      }
    }

    return NextResponse.json({
      message: `${results.filter(r => r.status === "success").length}/${toProcess.length}件投稿完了`,
      results,
    });
  } catch (error) {
    console.error("Cronジョブエラー:", error);
    return NextResponse.json({ error: "Cronジョブ実行中にエラーが発生しました" }, { status: 500 });
  }
}
