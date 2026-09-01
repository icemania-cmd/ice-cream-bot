import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import {
  listSubscriptions,
  pushConfigured,
  removeSubscription,
  saveSubscription,
  sendPush,
  vapidPublicKey,
} from "@/lib/push";

export const dynamic = "force-dynamic";

/** 通知の設定状況と公開鍵を返す */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subs = pushConfigured() ? await listSubscriptions() : [];
  return NextResponse.json({
    configured: pushConfigured(),
    // 公開鍵はブラウザに配るためのものなので、これを返すのは秘密の漏洩ではない
    publicKey: vapidPublicKey,
    devices: subs.length,
    endpoints: subs.map((s) => s.endpoint),
  });
}

/**
 * 端末の登録、またはテスト送信。
 *   POST { subscription: {...} }  → 登録
 *   POST { test: true }           → 登録済みの全端末へテスト送信
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!pushConfigured()) {
    return NextResponse.json(
      {
        error:
          "VAPID鍵が未設定です。node scripts/gen-vapid.mjs で作って Vercel の環境変数に登録してください",
      },
      { status: 400 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSONが不正です" }, { status: 400 });
  }

  if (body?.test === true) {
    const result = await sendPush({
      title: "🍦 テスト通知",
      body: "この通知が見えていれば、承認待ちのお知らせも届きます",
      url: "/admin",
      tag: "ice-test",
    });
    return NextResponse.json({
      ok: result.errors.length === 0,
      message: result.skipped
        ? result.skipped
        : `${result.sent}台に送信（失効 ${result.expired}台）`,
      result,
    });
  }

  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return NextResponse.json(
      { error: "subscription が不正です" },
      { status: 400 }
    );
  }

  await saveSubscription({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    addedAt: new Date().toISOString(),
    label: typeof body.label === "string" ? body.label.slice(0, 60) : undefined,
  });
  const subs = await listSubscriptions();
  return NextResponse.json({ ok: true, devices: subs.length });
}

/** 端末の登録解除 */
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSONが不正です" }, { status: 400 });
  }
  if (!body?.endpoint) {
    return NextResponse.json({ error: "endpoint が必要です" }, { status: 400 });
  }
  await removeSubscription(body.endpoint);
  return NextResponse.json({ ok: true });
}
