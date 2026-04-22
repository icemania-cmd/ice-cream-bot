import { NextRequest, NextResponse } from "next/server";
import { generateReminderPost, generateReleaseDayPost, generateCvsReminderPost } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import {
  getRemindersForTimeSlot,
  isReminderTypePosted,
  markReminderTypeAsPosted,
  canPostNow,
  canPostToday,
  recordPostTime,
  incrementDailyCount,
  type ReminderType,
} from "@/lib/store";
import type { PressRelease } from "@/lib/rss";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * リマインド投稿 API
 * 7時台・12時台・20時台に10分おきに実行
 * 各リマインドは scheduledHour + scheduledMinute（10分窓）で照合する
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = jstNow.toISOString().split("T")[0];
    const jstHour = jstNow.getUTCHours();
    const jstMinute = jstNow.getUTCMinutes();

    console.log(`📅 リマインドCron開始: JST ${jstHour}:${String(jstMinute).padStart(2, "0")} (${todayStr})`);

    const reminders = await getRemindersForTimeSlot(todayStr, jstHour, jstMinute);
    console.log(`該当リマインド: ${reminders.length}件`);

    if (reminders.length === 0) {
      return NextResponse.json({ message: "該当するリマインドなし", date: todayStr, hour: jstHour, minute: jstMinute });
    }

    const results = [];

    for (const reminder of reminders) {
      try {
        const reminderType: ReminderType = reminder.reminderType ?? "day_before";

        // 投稿済みチェック
        if (await isReminderTypePosted(reminderType, reminder.guid)) {
          console.log(`投稿済みスキップ [${reminderType}]: ${reminder.title}`);
          continue;
        }

        // レート制限チェック
        if (!(await canPostToday())) {
          console.log(`⛔ 本日の投稿上限(20件)に達したため停止`);
          results.push({ title: reminder.title, status: "skipped_daily_limit" });
          continue;
        }
        if (!(await canPostNow())) {
          console.log(`⏳ 15分ギャップ未達のためスキップ: ${reminder.title}`);
          results.push({ title: reminder.title, status: "skipped_gap" });
          continue;
        }

        const pr: PressRelease = {
          title: reminder.title,
          description: reminder.description,
          link: reminder.link ?? "",
          pubDate: "",
          guid: reminder.guid,
          imageUrl: reminder.imageUrl,
        };

        // reminderType・type に応じて投稿文を生成
        let postText: string;
        if (reminder.type === "cvs") {
          postText = await generateCvsReminderPost({
            name: reminder.title,
            store: reminder.store || "",
            description: reminder.description,
            releaseDate: reminder.releaseDate,
          });
          if (!postText.startsWith("【コンビニ】")) postText = "【コンビニ】" + postText;
        } else if (reminderType === "release_day") {
          postText = await generateReleaseDayPost(pr);
          if (!postText.startsWith("【本日発売！】")) postText = "【本日発売！】" + postText;
        } else {
          postText = await generateReminderPost(pr, reminderType);
          if (!postText.startsWith("【リマインド】")) postText = "【リマインド】" + postText;
        }

        console.log(`投稿文[${reminderType}]:\n${postText}\n`);

        // 画像アップロード
        let mediaIds: string[] | undefined;
        if (reminder.imageUrl) {
          const mediaId = await uploadImageToX(reminder.imageUrl);
          if (mediaId) mediaIds = [mediaId];
        }

        // 投稿
        const result = await postTweet(postText, mediaIds);
        if (result.success) {
          await recordPostTime();
          await incrementDailyCount();
          await markReminderTypeAsPosted(reminderType, reminder.guid);
          results.push({ title: reminder.title, releaseDate: reminder.releaseDate, reminderType, tweetId: result.tweetId, status: "success" });
          console.log(`✅ リマインド投稿成功 [${reminderType}]: ${reminder.title}`);
        } else {
          results.push({ title: reminder.title, error: result.error, status: "failed" });
          console.error(`❌ リマインド投稿失敗: ${result.error}`);
        }
      } catch (error) {
        console.error(`リマインドエラー: ${reminder.title}`, error);
        results.push({ title: reminder.title, error: error instanceof Error ? error.message : "不明なエラー", status: "error" });
      }
    }

    return NextResponse.json({
      message: `${results.filter(r => r.status === "success").length}/${results.length}件リマインド投稿完了`,
      date: todayStr,
      hour: jstHour,
      results,
    });
  } catch (error) {
    console.error("リマインドCronエラー:", error);
    return NextResponse.json({ error: "リマインドCron実行中にエラーが発生しました" }, { status: 500 });
  }
}
