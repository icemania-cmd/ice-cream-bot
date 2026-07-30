import { NextRequest, NextResponse } from "next/server";
import { fetchIceCreamNews, fetchOgImage, type PressRelease } from "@/lib/rss";
import { generatePost, generateReminderPost, generateReleaseDayPost, extractReleaseDate } from "@/lib/comment";
import {
  isAlreadyPosted,
  markAsPosted,
  getCachedReleaseDate,
  setCachedReleaseDate,
  isDuplicateWithCvs,
} from "@/lib/store";
import {
  saveDraft,
  hasDraft,
  isRejected,
  factCheckDraft,
  type DraftPostType,
} from "@/lib/drafts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * 承認制モード:
 * この cron は X への投稿を一切行わない。
 * PR TIMES をスキャンし、投稿文の「下書き」を生成して Redis に保存するだけ。
 * 実際の投稿は /admin で人間が承認したときにのみ行われる。
 */

const MAX_DRAFTS_PER_RUN = 5;

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
    console.log("🍦 Cron開始: PR Times スキャン（下書き生成モード）");

    const articles = await fetchIceCreamNews();
    console.log(`取得記事数: ${articles.length}`);

    // 未処理フィルタ（投稿済み・下書き作成済み・却下済みを除外）
    const newArticles: PressRelease[] = [];
    for (const article of articles) {
      if (await isAlreadyPosted(article.guid)) continue;
      if (await hasDraft(article.guid)) continue;
      if (await isRejected(article.guid)) continue;
      newArticles.push(article);
    }
    console.log(`未処理記事数: ${newArticles.length}`);

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
    const enriched = await Promise.all(
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
    const toProcess = eligible.slice(0, MAX_DRAFTS_PER_RUN);

    console.log(`下書き生成予定: ${toProcess.length}件`);

    const results: Array<Record<string, unknown>> = [];

    for (const { article, releaseDate, days } of toProcess) {
      try {
        let postText: string;
        let postType: DraftPostType;

        if (days === 0) {
          postType = "release_day";
          postText = await generateReleaseDayPost(article);
          if (!postText.startsWith("【本日発売！】")) postText = "【本日発売！】" + postText;
        } else if (days === 1) {
          postType = "day_before_reminder";
          postText = await generateReminderPost(article, "day_before");
          if (!postText.startsWith("【リマインド】")) postText = "【リマインド】" + postText;
        } else {
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

        // og:image 取得（未取得の場合のみ、プレビュー用に下書きへ保存）
        if (!article.imageUrl && article.link) {
          article.imageUrl = await fetchOgImage(article.link);
        }

        // 事実チェック: 生成文をソース本文と照合
        const sourceText = `${article.title}\n${article.description}`;
        const warnings = factCheckDraft({ text: postText, sourceText, releaseDate });

        await saveDraft({
          guid: article.guid,
          title: article.title,
          sourceText,
          link: article.link,
          imageUrl: article.imageUrl,
          releaseDate,
          postType,
          text: postText,
          warnings,
          createdAt: new Date().toISOString(),
        });

        results.push({
          title: article.title,
          releaseDate,
          postType,
          days,
          warnings: warnings.length,
          status: "draft_created",
        });
        console.log(`✅ 下書き作成[${postType}] 警告${warnings.length}件: ${article.title}`);
      } catch (error) {
        console.error(`エラー: ${article.title}`, error);
        results.push({ title: article.title, error: error instanceof Error ? error.message : "不明なエラー", status: "error" });
      }
    }

    return NextResponse.json({
      message: `${results.filter(r => r.status === "draft_created").length}/${toProcess.length}件の下書きを作成（承認待ち）`,
      results,
    });
  } catch (error) {
    console.error("Cronジョブエラー:", error);
    return NextResponse.json({ error: "Cronジョブ実行中にエラーが発生しました" }, { status: 500 });
  }
}
