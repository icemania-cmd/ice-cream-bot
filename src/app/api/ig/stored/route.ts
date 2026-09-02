import { NextRequest } from "next/server";
import sharp from "sharp";
import { verifyImageSig } from "@/lib/instagram";
import { getIgUpload } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 差し替え用にアップロードされた画像をIG向けに最適化して返す公開エンドポイント。
 * IG が image_url としてここを取得する。署名付きで、鍵を持つbotだけがURLを作れる。
 *
 *   GET /api/ig/stored?u=<base64url(guid)>&sig=<HMAC>
 *
 * IGの許容比(4:5〜1.91:1)外なら余白（白）を足して収める。範囲内は縮小のみ。
 */
const MAX_W = 1080;
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const u = params.get("u") || "";
  const sig = params.get("sig") || "";
  if (!u || !sig || !verifyImageSig(u, sig)) {
    return new Response("forbidden", { status: 403 });
  }

  let guid: string;
  try {
    guid = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const b64 = await getIgUpload(guid);
  if (!b64) return new Response("not found", { status: 404 });

  try {
    const input = Buffer.from(b64, "base64");
    const meta = await sharp(input).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    const r = w > 0 && h > 0 ? w / h : 1;

    let pipeline = sharp(input, { failOn: "none" }).rotate();
    if (r < MIN_RATIO || r > MAX_RATIO) {
      // 範囲外は余白を足して4:5に収める（クロップしない＝人が選んだ画像を尊重）
      const canvasW = MAX_W;
      const canvasH = Math.round(MAX_W / MIN_RATIO);
      pipeline = pipeline.resize(canvasW, canvasH, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255 },
      });
    } else {
      pipeline = pipeline.resize({ width: Math.min(w || MAX_W, MAX_W), withoutEnlargement: true });
    }
    const out = await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return new Response(new Uint8Array(out), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return new Response(`process error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}
