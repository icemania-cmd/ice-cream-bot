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
import { isAutoPostPublisher } from "@/lib/trust";
import { notifyQueued } from "@/lib/push";

/**
 * 発売告知ではないが、人に見せる価値がある記事の種類。
 * 出店・イベント・コラボは話題性があるので拾い、承認待ちに積む。
 * 投稿するかどうかと文面は人が決める。
 */
const NOTICE_TOPICS: Record<string, string> = {
  store: "専門店の出店・オープン",
  event: "イベント・催事",
  collab: "コラボ・タイアップ",
};
import { postTweet, uploadMedia } from "@/lib/x";
import {
  acquireRunLock,
  appendRunLog,
  claimForPost,
  enqueue,
  filterUnhandled,
  findSimilarPostedProduct,
  getRateStatus,
  jstDateString,
  listQueue,
  getStyleSamples,
  markHandled,
  markPosted,
  pruneOldEntries,
  queueSize,
  recordPost,
  rememberPostedProduct,
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
  // ヘッダが来ない環境でも保険が働くよう、実行時刻（毎時21分台）でも判定する
  const deep =
    url.searchParams.get("deep") === "1" ||
    cronSchedule.startsWith("21 ") ||
    new Date().getUTCMinutes() === 21;

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
  // このスキャンで人の確認待ちに積んだもの。最後にまとめて1通だけ通知する。
  // 1件ごとに送ると、まとめて記事が出た日に通知が連打される。
  const queuedReview: string[] = [];
  const queuedReady: string[] = [];

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
      // 投稿されたかどうか分からない失敗（タイムアウト・5xx）で権利を解放すると
      // 次回の実行が同じ記事をもう一度投稿しうる。確実に弾かれた場合だけ解放する。
      if (result.definitelyNotPosted) {
        await releaseClaim(item.guid);
      } else {
        log.notes.push(
          `投稿結果が不明のため再試行しません（Xを確認してください）: ${item.title}`
        );
      }
      details.push({ guid: item.guid, action: "投稿失敗", error: result.error });
      return false;
    }

    await rememberPostedProduct(item.productName);
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

  if (!(await acquireRunLock(330))) {
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
    const {
      releases,
      feedsOk,
      feedsFailed,
      freshnessMinutes,
      newestAt,
      freshnessBySource,
    } = await fetchReleases(deep);
    log.fetched = releases.length;

    // フィードが止まっていないかを毎回記録する。
    // 速報botなので、ここが数時間遅れていたら投稿件数以前の問題になる。
    if (freshnessMinutes !== null) {
      log.notes.push(`フィード最新: ${newestAt}（${freshnessMinutes}分前）`);
    }
    // 主ソースは2本ある。片方だけ止まったときに切り分けられるよう別々に見る。
    for (const f of freshnessBySource) {
      if (f.minutes === null) {
        log.errors.push(`${f.source} から1件も取得できていません`);
      } else if (f.minutes > 90) {
        log.errors.push(
          `${f.source} が${f.minutes}分前で止まっています。配信側またはCDNのキャッシュを疑ってください`
        );
      } else {
        log.notes.push(`${f.source}: ${f.minutes}分前`);
      }
    }
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
    // あいぱく関連は通常の関門を飛ばして通しているので、
    // あとで「自動投稿しない」を確実に効かせるために覚えておく。
    const watchGuids = new Set<string>();
    for (const r of unknown) {
      const pf = prefilter(r);
      if (pf.passed) {
        candidates.push(r);
        if (pf.watch) watchGuids.add(r.guid);
      } else rejectedGuids.push(r.guid);
    }
    log.candidates = candidates.length;
    log.skipped = rejectedGuids.length;

    // 「候補0」が続いたとき、アイスのニュースが無いのか、
    // フィルタが落としているのかを、ログだけで切り分けられるようにする。
    const iceMentioned = unknown.filter((r) =>
      /アイス|ジェラート|ソフトクリーム|かき氷|氷菓|シャーベット|冷菓/.test(
        `${r.title}${r.summary}`
      )
    );
    if (iceMentioned.length > 0) {
      log.notes.push(
        `アイス語を含む新規記事 ${iceMentioned.length}件 → 候補 ${candidates.length}件`
      );
      // 通らなかったものは理由つきで出す。フィルタ調整の材料になる
      for (const r of iceMentioned) {
        const pf = prefilter(r);
        if (!pf.passed) {
          log.notes.push(`除外「${r.title.slice(0, 40)}」: ${pf.reason}`);
        }
      }
    }
    // 落としたものは印を付けて二度と処理しない（dry-run では状態を汚さない）
    if (!dryRun && rejectedGuids.length > 0) await markHandled(rejectedGuids);

    // 古い順に処理する。新しい順にすると、候補が上限を超えた日に
    // 古いものが毎回後回しにされ、フィードから消えて永久に取りこぼされる。
    candidates.sort(
      (a, b) =>
        new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    );
    const toClassify = candidates.slice(0, MAX_CLASSIFY_PER_RUN);
    if (candidates.length > toClassify.length) {
      log.notes.push(
        `候補${candidates.length}件のうち${toClassify.length}件を処理（残りは次回）`
      );
    }

    // ---- 5. 判定 → 照合 → 振り分け ----
    // Vercel の上限は300秒。1件あたり記事取得+Claude+画像+投稿で最大30秒程度
    // かかりうるため、余裕を持って打ち切る。途中で殺されると Claude の課金だけ
    // 発生して結果が残らないため、これは費用対策でもある。
    const TIME_BUDGET_MS = 200_000;

    // 文体の見本はこのスキャンで共通。記事ごとに取るとコマンドが無駄に増える。
    const styleSamples =
      toClassify.length > 0 ? await getStyleSamples() : [];
    if (styleSamples.length > 0) {
      log.notes.push(`文体の見本: 実際の投稿${styleSamples.length}本を使用`);
    }
    for (const release of toClassify) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        log.notes.push("実行時間の予算に達したため、残りは次回に回します");
        break;
      }
      try {
        const detail = await fetchReleaseDetail(release.link);
        const bodyText = detail?.bodyText || "";
        const sourceText = `${release.title}\n${release.corp}\n${release.summary}\n${bodyText}`;

        const extraction = await classifyAndCompose(
          release,
          bodyText,
          styleSamples
        );
        log.classified++;

        const isWatch = watchGuids.has(release.guid);

        const noticeLabel = NOTICE_TOPICS[extraction.topic_type];

        if (!extraction.is_ice_cream_new_product) {
          if (!isWatch && !noticeLabel) {
            if (!dryRun) await markHandled([release.guid]);
            details.push({
              guid: release.guid,
              title: release.title,
              action: "対象外",
              reason: extraction.reason,
            });
            continue;
          }
          // あいぱく関連は新商品告知でなくても情報として残す。
          // 投稿文は作らない（新商品でないとき Claude は空を返す）。
          // 見出しとURLだけ渡して、出すかどうかと文面は人が決める。
          const notice: QueuedItem = {
            guid: release.guid,
            title: release.title,
            link: release.link,
            corp: release.corp,
            publishedAt: release.publishedAt,
            imageUrl: release.imageUrl || detail?.ogImage,
            releaseDate: "",
            productName: "",
            maker: release.corp,
            price: "",
            region: "",
            text: `${release.title}\n${release.link}`,
            blocking: [],
            warnings: [
              isWatch
                ? "あいぱく関連の記事です（新商品の告知ではありません）。文面は書き足してください。"
                : `${noticeLabel}の記事です（新商品の告知ではありません）。文面は書き足してください。`,
              extraction.reason,
            ].filter(Boolean),
            sourceExcerpt: sourceText.slice(0, 4000),
            createdAt: new Date().toISOString(),
            topicType: extraction.topic_type,
          };
          if (!dryRun) {
            await enqueue("review", notice);
            log.queued++;
            queuedReview.push(release.title);
          }
          details.push({
            guid: release.guid,
            title: release.title,
            action: isWatch
              ? "あいぱく関連として承認待ちへ"
              : `${noticeLabel}として承認待ちへ`,
          });
          continue;
        }

        const check = verifyPost({ extraction, sourceText, today });

        // 同じ商品を別の記事で二重投稿しないか確認する。
        // コラボ商品は両社がリリースを出すため、記事ID単位の重複防止では防げない。
        const twin = await findSimilarPostedProduct(extraction.product_name);
        if (twin) {
          check.warnings.push(
            `同じ商品を既に投稿している可能性があります（投稿済み: 「${twin}」）`
          );
          check.autoPostable = false;
        }

        // あいぱく関連は、新商品告知として成立していても自動投稿しない。
        if (check.autoPostable && isWatch) {
          check.warnings.push("あいぱく関連の記事のため確認が必要です");
          check.autoPostable = false;
        }

        // 事実照合を通っても、自動投稿は大手の流通・メーカーの配信に限る。
        // 中小・地方メーカーはリリースの書式が不揃いで、照合を通っても
        // 読むと違和感が残ることがある。件数も多くないので目視の負担は小さい。
        if (check.autoPostable && !isAutoPostPublisher(release.corp)) {
          check.warnings.push(
            `自動投稿の対象外の配信元のため確認が必要です（配信元: ${release.corp || "不明"}）`
          );
          check.autoPostable = false;
        }

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
          topicType: extraction.topic_type,
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
              queuedReady.push(item.title);
            }
          } else {
            await enqueue("ready", item);
            log.queued++;
            queuedReady.push(item.title);
            details.push({
              guid: release.guid,
              title: release.title,
              action: "投稿待ちへ",
            });
          }
        } else {
          await enqueue("review", item);
          log.queued++;
          queuedReview.push(item.title);
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

    // 確認待ちが増えたらスマホへ通知する。
    // 通知の失敗でスキャンを落とさない（投稿の可否とは無関係のため）。
    if (!dryRun && queuedReview.length + queuedReady.length > 0) {
      try {
        const r = await notifyQueued({
          review: queuedReview.length,
          ready: queuedReady.length,
          sampleTitle: queuedReview[0] || queuedReady[0] || "",
        });
        log.notes.push(
          r.skipped
            ? `通知は送っていません（${r.skipped}）`
            : `通知を${r.sent}台へ送信（失効${r.expired}台${
                r.errors.length ? ` / 失敗${r.errors.length}件` : ""
              }）`
        );
        for (const e of r.errors) log.errors.push(`通知の送信に失敗: ${e}`);
      } catch (e) {
        log.errors.push(
          `通知の送信に失敗: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // ZSET の刈り込みは3コマンドしか使わないので毎回実行して確実に走らせる
    if (!dryRun) await pruneOldEntries();
  } catch (e) {
    log.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    await releaseRunLock().catch(() => undefined);
  }

  log.durationMs = Date.now() - startedAt;

  // Vercel のログに1行で要約を出す。
  // 管理画面を開かなくても「今回何が起きたか」が分かる状態を保つため。
  console.log(
    `[scan:${log.mode}] 取得${log.fetched} 新規${log.newCount} 候補${log.candidates} ` +
      `判定${log.classified} 投稿${log.posted} キュー${log.queued} ` +
      `除外${log.skipped} ${(log.durationMs / 1000).toFixed(1)}秒`
  );
  for (const n of log.notes) console.log(`[scan] 備考: ${n}`);
  for (const e of log.errors) console.error(`[scan] エラー: ${e}`);
  for (const d of details) console.log(`[scan] ${JSON.stringify(d)}`);

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
