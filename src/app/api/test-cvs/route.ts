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
    name: "ローソン",
    url: "https://www.lawson.co.jp/recommend/original/icecream/",
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

  const results = [];

  for (const site of CVS_SITES) {
    try {
      const res = await fetch(site.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
        },
      });

      const html = await res.text();
      const imgCount = (html.match(/<img/gi) || []).length;
      const hasProductData =
        html.includes("商品") ||
        html.includes("アイス") ||
        html.includes("product");

      // 画像URLのサンプルを抽出
      const imgMatches = html.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
      const sampleImages = imgMatches.slice(0, 3).map((tag: string) => {
        const srcMatch = tag.match(/src=["']([^"']+)["']/i);
        return srcMatch?.[1] || "";
      });

      // 商品名らしきテキストを探す
      const titlePatterns = html.match(
        /(?:class=["'][^"']*(?:name|title|product)[^"']*["'][^>]*>)([^<]{2,50})/gi
      );

      results.push({
        name: site.name,
        url: site.url,
        status: res.status,
        contentType: res.headers.get("content-type"),
        htmlLength: html.length,
        imgCount,
        hasProductData,
        sampleImages,
        sampleTitles: titlePatterns?.slice(0, 5) || [],
        first500: html.substring(0, 500),
        snippet: html.substring(
          Math.max(0, html.indexOf("アイス") - 100),
          html.indexOf("アイス") + 200
        ),
      });
    } catch (error) {
      results.push({
        name: site.name,
        url: site.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ results });
}
