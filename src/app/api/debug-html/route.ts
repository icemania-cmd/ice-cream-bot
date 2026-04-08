import { NextRequest, NextResponse } from "next/server";

const CVS_SITES = [
  {
    name: "ファミリーマート",
    url: "https://www.family.co.jp/goods/ice.html",
  },
  {
    name: "セブン-イレブン",
    url: "https://www.sej.co.jp/products/a/cat/060020010000000/",
  },
  {
    name: "ミニストップ",
    url: "https://www.ministop.co.jp/syohin/sweets/",
  },
];

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const storeName = request.nextUrl.searchParams.get("store") || "ファミリーマート";
  const site = CVS_SITES.find((s) => s.name === storeName) || CVS_SITES[0];

  try {
    const res = await fetch(site.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
      },
    });

    const html = await res.text();

    // 商品関連キーワードの出現位置を調査
    const keywords = ["アイス", "商品", "product", "item", "ice", "price", "円"];
    const keywordPositions: Record<string, number[]> = {};

    for (const kw of keywords) {
      const positions: number[] = [];
      let idx = html.indexOf(kw);
      while (idx !== -1 && positions.length < 5) {
        positions.push(idx);
        idx = html.indexOf(kw, idx + 1);
      }
      if (positions.length > 0) {
        keywordPositions[kw] = positions;
      }
    }

    // 30000文字以内にある商品情報の有無
    const first30k = html.substring(0, 30000);
    const has30kIce = first30k.includes("アイス");
    const has30kProduct = first30k.includes("商品") || first30k.includes("product");

    // 各セクションのサンプル（前半・中盤・後半）
    const samples = {
      "0-500": html.substring(0, 500),
      "29500-30500": html.substring(29500, 30500),
      "middle": html.substring(Math.floor(html.length / 2) - 250, Math.floor(html.length / 2) + 250),
      "last500": html.substring(html.length - 500),
    };

    return NextResponse.json({
      store: site.name,
      url: site.url,
      totalLength: html.length,
      truncateAt30k: {
        hasIce: has30kIce,
        hasProduct: has30kProduct,
      },
      keywordPositions,
      samples,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
