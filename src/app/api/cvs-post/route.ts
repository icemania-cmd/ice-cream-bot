import { NextRequest, NextResponse } from "next/server";
import { generateCvsPost } from "@/lib/comment";
import { postTweet, uploadImageToX } from "@/lib/x-client";
import { getCvsProductsToPost, markCvsProductPosted, saveReminder, isDuplicateWithPrTimes } from "@/lib/store";

const MAX_POSTS_PER_RUN = 1;

/**
 * 投稿文のバリデーション
 * エラーメッセージや異常な文字列が含まれていないか確認する
 */
function isValidPostText(text: string): boolean {
  // 空文字・SKIPチェック
  if (!text || text === "SKIP" || text.trim().length === 0) return false;

  // エラーメッセージっぽい文字列が含まれていないか
  const errorPatterns = [
    /error/i,
    /エラー/,
    /undefined/i,
    /null/i,
    /NaN/i,
    /\[object/i,
    /Exception/i,
    /failed/i,
    /失敗/,
    /SKIP/,
    /```/,
    /^\s*\{/,    // JSONっぽい
    /^\s*\[/,    // 配列っぽい
    /function\s/i,
    /import\s/i,
    /const\s/i,
    /console\./i,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(text)) {
      console.error(`投稿文バリデーション失敗: パターン "${pattern}" にマッチ`);
      return false;
    }
  }

  // 最低限の長さチェック（短すぎる投稿は不自然）
  if (text.length < 20) {
    console.error(`投稿文が短すぎる: ${text.length}文字`);
    return false;
  }

  // 【コンビニ】で始まっているかチェック
  if (!text.startsWith("【コンビニ】")) {
    console.error(`投稿文が【コンビニ】で始まっていない: ${text.substring(0, 30)}`);
    return false;
  }

  return true;
}

/**
 * 発売日文字列をYYYY-MM-DD形式にパースする
 * ISO形式・日本語形式（年あり/なし）に対応
 */
function parseReleaseDate(releaseDate: string): string | null {
  if (!releaseDate || releaseDate === "不明") return null;

  // YYYY-MM-DD形式
  const isoMatch = releaseDate.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  // 日本語: 2026年1月27日
  const jpFullMatch = releaseDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (jpFullMatch) {
    return `${jpFullMatch[1]}-${jpFullMatch[2].padStart(2, "0")}-${jpFullMatch[3].padStart(2, "0")}`;
  }

  // 日本語: 1月27日（年なし → JST当年を使用）
  const jpMatch = releaseDate.match(/(\d{1,2})月(\d{1,2})日/);
  if (jpMatch) {
    const year = new Date(Date.now() + 9 * 60 * 60 * 1000).getFullYear();
    return `${year}-${jpMatch[1].padStart(2, "0")}-${jpMatch[2].padStart(2, "0")}`;
  }

  return null;
}

/**
 * CVS商品投稿 API
 * 12時台・18時台にそれぞれ33分おきに実行
 * 1回の実行で最大1件投稿
 */
export async function GET(request: NextRequest) {
  // Vercel Cronからの呼び出しを認証
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("🏪 CVS投稿Cron開始");

    // 投稿キューから未投稿の商品を取得
    const products = await getCvsProductsToPost(MAX_POSTS_PER_RUN);

    if (products.length === 0) {
      console.log("投稿キューに商品がありません");
      return NextResponse.json({
        message: "投稿対象の商品がありません",
        posted: 0,
      });
    }

    const results = [];

    // 今日の日付（JST）を取得
    const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = nowJst.toISOString().split("T")[0];

    for (const product of products) {
      try {
        console.log(`投稿処理開始: ${product.store} - ${product.name}`);

        // PR TIMES重複チェック（スキャン後にPR TIMESが投稿した場合の漏れを防ぐ）
        const prDup = await isDuplicateWithPrTimes(product.name);
        if (prDup) {
          console.log(`⏭️ PR TIMES投稿済みのためスキップ: ${product.name}`);
          await markCvsProductPosted(product.productId);
          results.push({ name: product.name, store: product.store, status: "skipped", reason: "prtimes_duplicate" });
          continue;
        }

        // 発売日チェック（二重防御：スキャン時にもチェック済みだが念のため）
        // 発売日不明・当日以降は投稿しない（前日までのみ投稿OK）
        const parsedDate = parseReleaseDate(product.releaseDate);
        if (!parsedDate) {
          console.log(`発売日不明スキップ: ${product.name}`);
          await markCvsProductPosted(product.productId);
          results.push({ name: product.name, store: product.store, status: "skipped", reason: "no_release_date" });
          continue;
        }
        if (parsedDate <= todayStr) {
          console.log(`発売日スキップ: ${product.name} (${parsedDate})`);
          await markCvsProductPosted(product.productId);
          results.push({ name: product.name, store: product.store, status: "skipped", reason: "release_date_passed" });
          continue;
        }

        // 投稿文を生成
        const postText = await generateCvsPost(product);
        console.log(`生成された投稿文:\n${postText}\n`);

        // バリデーション
        if (!isValidPostText(postText)) {
          console.error(`投稿文バリデーション失敗、スキップ: ${product.name}`);
          // バリデーション失敗してもキューからは削除（無限ループ防止）
          await markCvsProductPosted(product.productId);
          results.push({
            name: product.name,
            store: product.store,
            status: "skipped",
            reason: "validation_failed",
          });
          continue;
        }

        // 画像がある場合はアップロード
        let mediaIds: string[] | undefined;
        if (product.imageUrl) {
          try {
            const mediaId = await uploadImageToX(product.imageUrl);
            if (mediaId) {
              mediaIds = [mediaId];
            }
          } catch (imgError) {
            console.error(
              `画像アップロード失敗（投稿は続行）: ${imgError instanceof Error ? imgError.message : imgError}`
            );
            // 画像アップロード失敗しても投稿は続行
          }
        }

        // X APIで投稿
        const result = await postTweet(postText, mediaIds);

        if (result.success) {
          await markCvsProductPosted(product.productId);

          // 発売日が「明後日以降」の場合はリマインド予約を保存
          // 翌日発売品は本投稿が「前日告知」を兼ねるため不要
          try {
            const tomorrowJst = new Date(nowJst);
            tomorrowJst.setDate(tomorrowJst.getDate() + 1);
            const tomorrowStr = tomorrowJst.toISOString().split("T")[0];

            if (parsedDate > tomorrowStr) {
              const REMINDER_HOURS = [7, 12, 20];
              const chosenHour = REMINDER_HOURS[Math.floor(Math.random() * REMINDER_HOURS.length)];
              await saveReminder({
                title: product.name,
                description: product.description || "",
                guid: `cvs_reminder:${product.productId}`,
                imageUrl: product.imageUrl,
                releaseDate: parsedDate,
                chosenHour,
                type: "cvs",
                store: product.store,
              });
              console.log(`📅 CVSリマインド予約: ${parsedDate} ${chosenHour}時 - ${product.name}`);
            } else {
              console.log(`📅 CVSリマインド不要（翌日発売のため本投稿が前日告知を兼ねる）: ${product.name}`);
            }
          } catch (reminderError) {
            console.error("CVSリマインド予約エラー:", reminderError);
          }

          results.push({
            name: product.name,
            store: product.store,
            tweetId: result.tweetId,
            status: "success",
          });
          console.log(`✅ CVS投稿成功: ${product.store} - ${product.name}`);
        } else {
          results.push({
            name: product.name,
            store: product.store,
            error: result.error,
            status: "failed",
          });
          console.error(`❌ CVS投稿失敗: ${result.error}`);
        }
      } catch (error) {
        console.error(`CVS投稿エラー: ${product.name}`, error);
        results.push({
          name: product.name,
          store: product.store,
          error: error instanceof Error ? error.message : "不明なエラー",
          status: "error",
        });
      }
    }

    return NextResponse.json({
      message: `${results.filter((r) => r.status === "success").length}/${results.length}件CVS投稿完了`,
      results,
    });
  } catch (error) {
    console.error("CVS投稿Cronエラー:", error);
    return NextResponse.json(
      { error: "CVS投稿Cron実行中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
