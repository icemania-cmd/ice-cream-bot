import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, FIREHOSE_URL } from "@/lib/config";
import { fetchReleases } from "@/lib/prtimes";
import { prefilter } from "@/lib/filter";
import { missingCredentials, uploadMediaBuffer, verifyCredentials } from "@/lib/x";
import { makeTestPng } from "@/lib/testimage";
import { queueSize, redisToken, redisUrl, storeHealth } from "@/lib/store";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 依存先を一括で叩いて、どこが壊れているかを一目で分かるようにする。
 * 「動かない」と言われたときに最初に見る場所。投稿は一切行わない。
 *
 * ?media=1 を付けると画像アップロードまで実際に試す（投稿はしない）。
 */
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks: Check[] = [];
  const testMedia = new URL(request.url).searchParams.get("media") === "1";
  const rejectionReasons: Record<string, number> = {};
  let iceMentioned = 0;

  // 1. 環境変数
  const requiredEnv = [
    "ANTHROPIC_API_KEY",
    "CRON_SECRET",
    "X_API_KEY",
    "X_API_SECRET",
    "X_ACCESS_TOKEN",
    "X_ACCESS_TOKEN_SECRET",
  ];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);
  // Redis は連携の作成時期で変数名が2通りある
  if (!redisUrl || !redisToken) {
    missingEnv.push("KV_REST_API_URL/TOKEN（または UPSTASH_REDIS_REST_URL/TOKEN）");
  }
  checks.push({
    name: "環境変数",
    ok: missingEnv.length === 0,
    detail:
      missingEnv.length === 0
        ? `${requiredEnv.length + 2}件すべて設定済み`
        : `未設定: ${missingEnv.join(", ")}`,
  });
  checks.push({
    name: "管理画面パスワード(ADMIN_SECRET)",
    ok: true,
    detail: process.env.ADMIN_SECRET
      ? "ADMIN_SECRET を使用"
      : "未設定のため CRON_SECRET を代用（本番では分けることを推奨）",
  });

  // 2. Redis
  const store = await storeHealth();
  checks.push({
    name: "Upstash Redis",
    ok: store.ok,
    detail: store.ok
      ? `読み書き成功（${redisUrl.replace(/^https?:\/\//, "").split("/")[0]}）`
      : `失敗: ${store.error}`,
  });

  // 3. PR TIMES
  let sampleTitles: string[] = [];
  try {
    const { releases, feedsOk, feedsFailed } = await fetchReleases(false);
    const passed = releases.filter((r) => prefilter(r).passed);
    sampleTitles = passed.slice(0, 5).map((r) => r.title);

    // 通過0件のとき「アイスの新商品が今たまたま無い」のか
    // 「フィルタが壊れている」のかを切り分けられるよう、落ちた理由を集計する
    for (const r of releases) {
      const pf = prefilter(r);
      if (pf.passed) continue;
      const key = pf.reason.split(":")[0];
      rejectionReasons[key] = (rejectionReasons[key] || 0) + 1;
    }
    // 「アイスの語はあるが発売告知ではない」記事はフィルタが生きている証拠になる
    iceMentioned = releases.filter((r) =>
      /アイス|ジェラート|ソフトクリーム|かき氷|氷菓/.test(
        `${r.title}${r.summary}`
      )
    ).length;

    checks.push({
      name: "PR TIMES フィード",
      ok: feedsOk > 0 && releases.length > 0,
      detail:
        feedsOk > 0
          ? `${releases.length}件取得（${FIREHOSE_URL}）／アイス語を含む記事 ${iceMentioned}件／事前フィルタ通過 ${passed.length}件`
          : `失敗: ${feedsFailed.map((f) => f.error).join(", ")}`,
    });
  } catch (e) {
    checks.push({
      name: "PR TIMES フィード",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. Claude
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const r = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "「OK」とだけ返してください。" }],
    });
    const text = r.content[0]?.type === "text" ? r.content[0].text.trim() : "";
    checks.push({
      name: "Claude API",
      ok: text.length > 0,
      detail: `${CLAUDE_MODEL} 応答: ${text || "(空)"}`,
    });
  } catch (e) {
    checks.push({
      name: "Claude API",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 5. X 認証
  const missingX = missingCredentials();
  if (missingX.length > 0) {
    checks.push({
      name: "X 認証",
      ok: false,
      detail: `鍵が未設定: ${missingX.join(", ")}`,
    });
  } else {
    const v = await verifyCredentials();
    checks.push({
      name: "X 認証",
      ok: v.ok,
      detail: v.ok ? `@${v.username} として認証成功` : `失敗: ${v.error}`,
    });
  }

  // 6. 画像アップロード（任意）
  if (testMedia) {
    // 外部サイトの画像URLに依存すると、その画像が消えた時点で
    // 「Xへのアップロードが通るのか」という肝心の検証ができなくなる。
    // 検証用PNGはその場で生成する。
    const png = makeTestPng(256);
    const m = await uploadMediaBuffer({ buffer: png, contentType: "image/png" });
    checks.push({
      name: "X 画像アップロード",
      ok: !!m.mediaId,
      detail: m.mediaId
        ? `成功（${m.via} エンドポイント / ${Math.round(png.length / 1024)}KB のPNGを送信 / media_id=${m.mediaId}）`
        : `失敗: ${m.error}`,
    });
  } else {
    checks.push({
      name: "X 画像アップロード",
      ok: true,
      detail: "未検証（?media=1 を付けると実際に試します）",
    });
  }

  const [ready, review] = await Promise.all([
    queueSize("ready").catch(() => -1),
    queueSize("review").catch(() => -1),
  ]);

  const failed = checks.filter((c) => !c.ok);
  return NextResponse.json(
    {
      healthy: failed.length === 0,
      summary:
        failed.length === 0
          ? "すべて正常です"
          : `${failed.length}件の問題: ${failed.map((c) => c.name).join(", ")}`,
      checks,
      queues: { 投稿待ち: ready, 承認待ち: review },
      サンプル候補: sampleTitles,
      フィルタで落ちた理由の内訳: rejectionReasons,
    },
    { status: failed.length === 0 ? 200 : 503 }
  );
}
