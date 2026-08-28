import { NextRequest, NextResponse } from "next/server";
import {
  MAX_ARTICLE_AGE_HOURS,
  MAX_CLASSIFY_PER_RUN,
  MAX_POSTS_PER_RUN,
} from "@/lib/config";
import { fetchReleaseDetail, fetchReleases, type Release } from "@/lib/prtimes";
import { prefilter } from "@/lib/filter";
import { classifyAndCompose } from "@/lib/classify";
import { verifyPost } from "@/lib/verify";
import { postTweet, uploadMedia } from "@/lib/x";
import {
  acquireRunLock,
  appendRunLog,
  claimForPost,
  enqueue,
  filterUnhandled,
  getRateStatus,
  jstDateString,
  listQueue,
  markHandled,
  markPosted,
  pruneOldEntries,
  queueSize,
  recordPost,
  releaseClaim,
  releaseRunLock,
  type QueuedItem,
  type RunLog,
} from "@/lib/store";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * 収集 → 判定 → 照合 → 投稿 を1本にまとめた唯一の実行経路。
 *
 * ?dry=1   … Xへの投稿を一切行わず、何が起きるかだけ返す
 * ?deep=1  … 企業別フィードも併せて舐める（取りこぼしの拾い直し）
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry") === "1";
  // Vercel cron は x-vercel-cron-schedule で「どのスケジュールが叩いたか」を教えてくれる。
  // 時報側のスケジュールで来たときは企業別フィードも舐める。
  const cronSchedule = request.headers.get("x-vercel-cron-schedule") || "";
  const deep =
    url.searchParams.get("deep") === "1" || cronSchedule.startsWith("21 ");

  const log: RunLog = {
    at: new Date().toISOString(),
    mode: `${dryRun ? "dry" : "live"}${deep ? "+deep" : ""}`,
    fetched: 0,
    newCount: 0,
    candidates: 0,
    classified: 0,
    posted: 0,
    queued: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
    notes: [],
  };

  const details: Record<string, unknown>[] = [];
  const today = jstDateString();
  let postsThisRun = 0;

  /** 1件を実際にXへ出す。成功したら true。 */
  async function publish(item: QueuedItem): Promise<boolean> {
    const rate = await getRateStatus();
    if (!rate.canPost) {
      log.notes.push(rate.reason || "投稿枠なし");
      return false;
    }
    // cron の二重配信・同時実行に備えて記事単位の投稿権を取る
    if (!(await claimForPost(item.guid))) {
      log.notes.push(`他の実行が処理中のためスキップ: ${item.title}`);
      return false;
    }

    let mediaIds: string[] | undefined;
    if (item.imageUrl) {
      const media = await uploadMedia(item.imageUrl);
      if (media.mediaId) {
        mediaIds = [media.mediaId];
      } else {
        // 画像が付かなくても本文は出す。ただし記録は残す。
        log.errors.push(`画像アップロード失敗(${item.title}): ${media.error}`);
      }
    }

    const result = await postTweet(item.text, mediaIds);
    if (!result.success) {
      log.errors.push(`投稿失敗(${item.title}): ${result.error}`);
      if (result.rateLimited) {
        log.notes.push("X側のレート制限に到達したため以降の投稿を中止");
        postsThisRun = MAX_POSTS_PER_RUN;
      }
      // 失敗した記事は ready に残し、次回の実行で再試行する
      await releaseClaim(item.guid);
      details.push({ guid: item.guid, action: "投稿失敗", error: result.error });
      return false;
    }

    await markPosted(item.guid, {
      title: item.title,
      link: item.link,
      text: item.text,
      tweetId: result.tweetId,
      imageUrl: item.imageUrl,
      releaseDate: item.releaseDate,
      route: "auto",
    });
    // markPosted が ready/review からの削除も済ませているので dequeue は不要
    await recordPost();
    postsThisRun++;
    log.posted++;
    details.push({
      guid: item.guid,
      action: "投稿成功",
      tweetId: result.tweetId,
      withImage: !!mediaIds,
      text: item.text,
    });
    return true;
  }

  if (!(await acquireRunLock())) {
    return NextResponse.json(
      { skipped: true, reason: "前回の実行がまだ走っているためスキップしました" },
      { status: 200 }
    );
  }

  try {
    // ---- 1. 投稿待ちキューを先に捌く（古い順＝速報性優先）----
    const ready = await listQueue("ready", 20);
    if (dryRun) {
      for (const item of ready) {
        details.push({
          guid: item.guid,
          title: item.title,
          action: "dry-run:投稿待ち（次の実行で投稿される）",
          text: item.text,
        });
      }
    } else {
      for (const item of ready) {
        if (postsThisRun >= MAX_POSTS_PER_RUN) break;
        const done = await publish(item);
        // 投稿枠が無いなら以降を試しても同じ結果なので打ち切る
        if (!done && (await getRateStatus()).canPost === false) break;
      }
    }

    // ---- 2. 収集 ----
    const { releases, feedsOk, feedsFailed } = await fetchReleases(deep);
    log.fetched = releases.length;
    for (const f of feedsFailed) {
      log.errors.push(`フィード取得失敗 ${f.source}: ${f.error}`);
    }
    if (feedsOk === 0) {
      log.notes.push("すべてのフィード取得に失敗しました");
      throw new Error("フィードを1本も取得できませんでした");
    }

    // 鮮度で足切り（速報botなので古い記事は追わない）
    const cutoff = Date.now() - MAX_ARTICLE_AGE_HOURS * 3600 * 1000;
    const fresh = releases.filter((r) => {
      const t = new Date(r.publishedAt).getTime();
      return Number.isFinite(t) ? t >= cutoff : true;
    });

    // ---- 3. 既知判定（SMISMEMBER 2コマンドで全件判定）----
    const unhandled = new Set(await filterUnhandled(fresh.map((r) => r.guid)));
    const unknown = fresh.filter((r) => unhandled.has(r.guid));
    log.newCount = unknown.length;

    // ---- 4. 無料の事前フィルタ ----
    const candidates: Release[] = [];
    const rejectedGuids: string[] = [];
    for (const r of unknown) {
      const pf = prefilter(r);
      if (pf.passed) candidates.push(r);
      else rejectedGuids.push(r.guid);
    }
    log.candidates = candidates.length;
    log.skipped = rejectedGuids.length;
    // 落としたものは印を付けて二度と処理しない（dry-run では状態を汚さない）
    if (!dryRun && rejectedGuids.length > 0) await markHandled(rejectedGuids);

    // 新しい順に、1回の上限まで
    candidates.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    const toClassify = candidates.slice(0, MAX_CLASSIFY_PER_RUN);
    if (candidates.length > toClassify.length) {
      log.notes.push(
        `候補${candidates.length}件のうち${toClassify.length}件を処理（残りは次回）`
      );
    }

    // ---- 5. 判定 → 照合 → 振り分け ----
    for (const release of toClassify) {
      try {
        const detail = await fetchReleaseDetail(release.link);
        const bodyText = detail?.bodyText || "";
        const sourceText = `${release.title}\n${release.corp}\n${release.summary}\n${bodyText}`;

        const extraction = await classifyAndCompose(release, bodyText);
        log.classified++;

        if (!extraction.is_ice_cream_new_product) {
          if (!dryRun) await markHandled([release.guid]);
          details.push({
            guid: release.guid,
            title: release.title,
            action: "対象外",
            reason: extraction.reason,
          });
          continue;
        }

        const check = verifyPost({ extraction, sourceText, today });

        const item: QueuedItem = {
          guid: release.guid,
          title: release.title,
          link: release.link,
          corp: release.corp,
          publishedAt: release.publishedAt,
          // RSS の [画像1:] はリリース本体の主画像。og:image は汎用バナーのことがある
          imageUrl: release.imageUrl || detail?.ogImage,
          releaseDate: extraction.release_date,
          productName: extraction.product_name,
          maker: extraction.maker,
          price: extraction.price,
          region: extraction.region,
          text: check.text,
          blocking: check.blocking,
          warnings: check.warnings,
          sourceExcerpt: sourceText.slice(0, 4000),
          createdAt: new Date().toISOString(),
        };

        if (dryRun) {
          details.push({
            guid: release.guid,
            title: release.title,
            action: check.autoPostable ? "dry-run:自動投稿の対象" : "dry-run:承認待ちの対象",
            text: check.text,
            blocking: check.blocking,
            warnings: check.warnings,
          });
          continue;
        }

        if (check.autoPostable) {
          if (postsThisRun < MAX_POSTS_PER_RUN) {
            const done = await publish(item);
            if (!done) {
              await enqueue("ready", item);
              log.queued++;
            }
          } else {
            await enqueue("ready", item);
            log.queued++;
            details.push({
              guid: release.guid,
              title: release.title,
              action: "投稿待ちへ",
            });
          }
        } else {
          await enqueue("review", item);
          log.queued++;
          details.push({
            guid: release.guid,
            title: release.title,
            action: "承認待ちへ",
            blocking: check.blocking,
            warnings: check.warnings,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.errors.push(`処理エラー(${release.title}): ${msg}`);
        // markSeen しない = 次回のスキャンで自動的に再試行される
      }
    }

    // 掃除は毎回やる必要がない。Upstash のコマンド数を抑えるため毎時1回に留める。
    if (deep && !dryRun) await pruneOldEntries();
  } catch (e) {
    log.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    await releaseRunLock().catch(() => undefined);
  }

  log.durationMs = Date.now() - startedAt;
  if (!dryRun) await appendRunLog(log).catch(() => undefined);

  const [readyCount, reviewCount] = await Promise.all([
    queueSize("ready").catch(() => -1),
    queueSize("review").catch(() => -1),
  ]);

  return NextResponse.json({
    summary: `取得${log.fetched} / 新規${log.newCount} / 候補${log.candidates} / 判定${log.classified} / 投稿${log.posted} / キュー追加${log.queued}`,
    log,
    queues: { ready: readyCount, review: reviewCount },
    details,
  });
}
