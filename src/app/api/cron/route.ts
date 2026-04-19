import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews, fetchOgImage, type PressRelease } from "@/lib/rss";
import { generatePost, extractReleaseDate } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import {
  isAlreadyPosted,
  markAsPosted,
  saveReminder,
  getCachedReleaseDate,
  setCachedReleaseDate,
} from "@/lib/store";

// Route Segment Config: vercel.json の functions はApp Routerで未適用の場合あり
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// 1回のCron実行で投稿する最大件数（通常記事用）
// 「翌日発売」記事はこの上限とは別枠で必ず処理する（取りこぼし防止）。
const MAX_POSTS_PER_RUN = 5;

type Enriched = { article: PressRelease; releaseDate: string | null };

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
    const newArticles: PressRelease[] = [];
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

    // 3. 全未投稿記事の発売日を抽出（キャッシュ優先・Claude API節約）
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
    const tomorrowJst = new Date(jstNow);
    tomorrowJst.setDate(tomorrowJst.getDate() + 1);
    const tomorrowStr = tomorrowJst.toISOString().split("T")[0];

    // 4. 事前フィルタ: 古い記事 / 発売日不明 / 発売日が過去・当日 はキューから除外し
    //    再処理しないよう posted マークをつける
    // ただし「発売日不明」かつ pubDate が新しい場合は一時失敗の可能性が高いので
    // posted マークせず次回 cron で再試行する（Claude API ハイカップ等の取りこぼし防止）
    const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3日以内の記事は再試行を許可
    const eligible: { article: PressRelease; releaseDate: string }[] = [];
    for (const { article, releaseDate } of enriched) {
      const pubDateAge = Date.now() - new Date(article.pubDate).getTime();
      if (pubDateAge > 30 * 24 * 60 * 60 * 1000) {
        console.log(`⏭️ 記事が古すぎるためスキップ (${article.pubDate}): ${article.title}`);
        await markAsPosted(article.guid);
        continue;
      }
      if (!releaseDate) {
        if (pubDateAge < RETRY_WINDOW_MS) {
          // 新しい記事の発売日不明は posted マークせず次回再試行
          console.log(`⏭️ 発売日不明（再試行待ち）: ${article.title}`);
          await setCachedReleaseDate(article.guid, null); // 短期キャッシュ済み・再抽出を防ぐ
        } else {
          console.log(`⏭️ 発売日不明スキップ（諦める）: ${article.title}`);
          await markAsPosted(article.guid);
        }
        continue;
      }
      if (releaseDate <= today) {
        console.log(`⏭️ 発売日が過去/当日スキップ: ${releaseDate} <= ${today} - ${article.title}`);
        await markAsPosted(article.guid);
        continue;
      }
      eligible.push({ article, releaseDate });
    }

    // 5. 発売日が近い順にソート
    eligible.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));

    // 6. 緊急（翌日発売）は全件処理 + 通常記事は MAX_POSTS_PER_RUN まで
    const urgent = eligible.filter((e) => e.releaseDate <= tomorrowStr);
    const normal = eligible.filter((e) => e.releaseDate > tomorrowStr);
    const normalSlots = Math.max(0, MAX_POSTS_PER_RUN - urgent.length);
    const toProcess = [...urgent, ...normal.slice(0, normalSlots)];

    console.log(
      `処理予定: 緊急(翌日発売)=${urgent.length}件 / 通常=${Math.min(normal.length, normalSlots)}件 / 合計=${toProcess.length}件`
    );

    const results: Array<Record<string, unknown>> = [];

    for (const { article, releaseDate } of toProcess) {
      try {
        // Claude APIで投稿文を生成（【新商品】が抜けた場合は強制補完）
        let postText = await generatePost(article);
        console.log(`生成された投稿文:\n${postText}\n`);

        // 新商品以外（SKIP）はXに投稿せず記録だけして終了
        if (postText.trim() === "SKIP") {
          console.log(`⏭️ 新商品以外のためスキップ: ${article.title}`);
          await markAsPosted(article.guid);
          results.push({ title: article.title, status: "skipped_not_new_product" });
          continue;
        }

        if (!postText.startsWith("【新商品】")) {
          console.warn(`⚠️ 【新商品】が抜けていたため補完: ${postText.substring(0, 50)}`);
          postText = "【新商品】" + postText;
        }

        // RSSから画像が取れなかった場合のみog:imageを取得（全件取得はタイムアウトの原因）
        if (!article.imageUrl && article.link) {
          console.log(`og:image取得: ${article.link}`);
          article.imageUrl = await fetchOgImage(article.link);
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
          try {
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

          results.push({
            title: article.title,
            tweetId: result.tweetId,
            releaseDate,
            urgent: releaseDate <= tomorrowStr,
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
      message: `${results.filter((r) => r.status === "success").length}/${toProcess.length}件投稿完了`,
      urgent: urgent.length,
      normal: Math.min(normal.length, normalSlots),
      pending: Math.max(0, normal.length - normalSlots),
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
