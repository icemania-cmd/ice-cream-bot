import { NextRequest } from "next/server";
import sharp from "sharp";
import { verifyImageSig } from "@/lib/instagram";
import { BROWSER_UA } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * IG向けに最適化した画像を返す公開エンドポイント。
 * IG が image_url としてここを取得し、その場で最適化JPEGを受け取る。
 *
 *   GET /api/ig/image?u=<base64url(元画像URL)>&sig=<HMAC>
 *
 * 署名(sig)が正しいURLだけ処理する（踏み台化の防止）。
 *
 * IG_IMAGE_MODE:
 *   square   … 1:1 中央クロップ（既定）
 *   portrait … 4:5 中央クロップ
 *   auto     … 範囲(4:5〜1.91:1)外のときだけ最小クロップ、範囲内は素通し
 *   pad      … 4:5 キャンバスに全体を収め、余白はぼかし背景で埋める（クロップしない）
 */

const MODE = (process.env.IG_IMAGE_MODE || "square").toLowerCase();
const MAX_W = 1080;
const FETCH_TIMEOUT_MS = 15000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
// IGの許容比（幅/高さ）
const MIN_RATIO = 0.8; // 4:5
const MAX_RATIO = 1.91; // 1.91:1

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const u = params.get("u") || "";
  const sig = params.get("sig") || "";
  if (!u || !sig || !verifyImageSig(u, sig)) {
    return new Response("forbidden", { status: 403 });
  }

  let src: string;
  try {
    src = Buffer.from(u, "base64url").toString("utf8");
    if (!/^https?:\/\//i.test(src)) throw new Error("bad url");
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // 元画像を取得
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let input: Buffer;
  try {
    const res = await fetch(src, {
      headers: { "User-Agent": BROWSER_UA },
      signal: controller.signal,
    });
    if (!res.ok) return new Response(`source ${res.status}`, { status: 502 });
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_SOURCE_BYTES) {
      return new Response("source too large", { status: 413 });
    }
    input = Buffer.from(ab);
  } catch (e) {
    return new Response(`fetch error: ${e instanceof Error ? e.message : String(e)}`, {
      status: 502,
    });
  } finally {
    clearTimeout(timer);
  }

  try {
    const out = await optimize(input);
    return new Response(new Uint8Array(out), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (e) {
    return new Response(`process error: ${e instanceof Error ? e.message : String(e)}`, {
      status: 500,
    });
  }
}

async function optimize(input: Buffer): Promise<Buffer> {
  const base = sharp(input, { failOn: "none" }).rotate(); // EXIF向き補正
  const meta = await base.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  const jpeg = (s: ReturnType<typeof sharp>) => s.jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  // 中央クロップ（cover）で目標比に整える共通処理
  const coverTo = (tw: number, th: number) =>
    jpeg(
      sharp(input, { failOn: "none" })
        .rotate()
        .resize(tw, th, { fit: "cover", position: "attention" })
    );

  if (MODE === "square") {
    return coverTo(MAX_W, MAX_W);
  }
  if (MODE === "portrait") {
    return coverTo(MAX_W, Math.round(MAX_W / MIN_RATIO)); // 1080x1350 (4:5)
  }
  if (MODE === "pad") {
    const canvasW = MAX_W;
    const canvasH = Math.round(MAX_W / MIN_RATIO); // 4:5
    const bg = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(canvasW, canvasH, { fit: "cover", position: "centre" })
      .blur(25)
      .modulate({ brightness: 0.9 })
      .toBuffer();
    const fg = await sharp(input, { failOn: "none" })
      .rotate()
      .resize(canvasW, canvasH, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
    return jpeg(
      sharp(bg).composite([{ input: fg, gravity: "centre" }])
    );
  }

  // auto: 範囲内は素通し（縮小のみ）、範囲外だけ最小クロップ
  if (w > 0 && h > 0) {
    const r = w / h;
    if (r < MIN_RATIO) {
      const outW = Math.min(w, MAX_W);
      return coverTo(outW, Math.round(outW / MIN_RATIO));
    }
    if (r > MAX_RATIO) {
      const outW = Math.min(w, MAX_W);
      return coverTo(outW, Math.round(outW / MAX_RATIO));
    }
  }
  // 範囲内 or サイズ不明: 幅だけ1080に抑えてJPEG化
  return jpeg(
    sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width: Math.min(w || MAX_W, MAX_W), withoutEnlargement: true })
  );
}
