import { NextRequest, NextResponse } from "next/server";
import { generateReminderPost } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import {
  getRemindersForDate,
  isReminderPosted,
  markReminderAsPosted,
} from "@/lib/store";
import type { PressRelease } from "@/lib/rss";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * リマインド投稿 API
 * 毎日20:00 JST に実行され、翌日発売の商品をリマインド投稿する
 */
export async function GET(request: NextRequest) {
  // Vercel Cronからの呼び出しを認証
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("📅 リマインドCron開始");

    // 明日の日付を計算（JST基準）
    const now = new Date();
    const jstOffset = 9 * 60 * 60 * 1000; // UTC+9
    const jstNow = new Date(now.getTime() + jstOffset);
    const jstHour = jstNow.getUTCHours(); // JSTでの現在時（UTC+9後のgetUTCHours）
    const tomorrow = new Date(jstNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0]; // YYYY-MM-DD

    console.log(`明日の日付（JST）: ${tomorrowStr} / 現在時刻（JST）: ${jstHour}時`);

    // 明日発売の商品を取得
    const reminders = await getRemindersForDate(tomorrowStr);
    console.log(`明日発売の商品: ${reminders.length}件`);

    if (reminders.length === 0) {
      return NextResponse.json({
        message: "明日発売の商品はありません",
        date: tomorrowStr,
        reminders: 0,
      });
    }

    const results = [];

    for (const reminder of reminders) {
      try {
        // 既にリマインド投稿済みかチェック
        const alreadyPosted = await isReminderPosted(reminder.guid);
        if (alreadyPosted) {
          console.log(`リマインド投稿済みスキップ: ${reminder.title}`);
          continue;
        }

        // chosenHourが設定されている場合、現在のJST時刻と一致しないスロットはスキップ
        if (reminder.chosenHour !== undefined && reminder.chosenHour !== jstHour) {
          console.log(`⏭️ 投稿時間不一致スキップ: 指定=${reminder.chosenHour}時 現在=${jstHour}時 - ${reminder.title}`);
          continue;
        }

        // PressRelease形式に変換
        const pr: PressRelease = {
          title: reminder.title,
          description: reminder.description,
          link: reminder.link,
          pubDate: "",
          guid: reminder.guid,
          imageUrl: reminder.imageUrl,
        };

        // リマインド投稿文を生成（【リマインド】が抜けた場合は強制補完）
        let postText = await generateReminderPost(pr);
        if (!postText.startsWith("【リマインド】")) {
          console.warn(`⚠️ 【リマインド】が抜けていたため補完: ${postText.substring(0, 50)}`);
          postText = "【リマインド】" + postText;
        }
        console.log(`リマインド投稿文:\n${postText}\n`);

        // 画像がある場合はアップロード
        let mediaIds: string[] | undefined;
        if (reminder.imageUrl) {
          const mediaId = await uploadImageToX(reminder.imageUrl);
          if (mediaId) {
            mediaIds = [mediaId];
          }
        }

        // X APIで投稿
        const result = await postTweet(postText, mediaIds);

        if (result.success) {
          await markReminderAsPosted(reminder.guid);
          results.push({
            title: reminder.title,
            releaseDate: reminder.releaseDate,
            tweetId: result.tweetId,
            status: "success",
          });
          console.log(`✅ リマインド投稿成功: ${reminder.title}`);
        } else {
          results.push({
            title: reminder.title,
            error: result.error,
            status: "failed",
          });
          console.error(`❌ リマインド投稿失敗: ${result.error}`);
        }
      } catch (error) {
        console.error(`リマインドエラー: ${reminder.title}`, error);
        results.push({
          title: reminder.title,
          error: error instanceof Error ? error.message : "不明なエラー",
          status: "error",
        });
      }
    }

    return NextResponse.json({
      message: `${results.filter((r) => r.status === "success").length}/${results.length}件リマインド投稿完了`,
      date: tomorrowStr,
      results,
    });
  } catch (error) {
    console.error("リマインドCronエラー:", error);
    return NextResponse.json(
      { error: "リマインドCron実行中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
