import Parser from "rss-parser";

export interface PressRelease {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  guid: string;
  imageUrl?: string;
}

/**
 * media:content 要素からURLを抽出する
 * rss-parser は media:content を { url: "..." } または { $: { url: "..." } } 形式で返す
 */
function extractMediaContentUrl(mediaContent: unknown): string | undefined {
  if (!mediaContent) return undefined;
  if (typeof mediaContent === "string") return mediaContent || undefined;
  if (typeof mediaContent === "object") {
    const mc = mediaContent as Record<string, unknown>;
    const url = (mc.url as string) || ((mc.$ as Record<string, string>)?.url);
    return url || undefined;
  }
  return undefined;
}

/**
 * RSSのcontent内から画像URLを抽出する
 * PR TIMESのRSSにはHTMLコンテンツ内に画像が含まれる
 */
function extractImageFromContent(content: string): string | undefined {
  // <img src="..."> からURLを抽出
  const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) return imgMatch[1];

  // <enclosure url="..."> からURLを抽出
  const encMatch = content.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
  if (encMatch?.[1]) return encMatch[1];

  return undefined;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * プレスリリースページからog:image を取得するフォールバック
 * 投稿直前に個別呼び出しする用途（全件一括取得はタイムアウトの原因になる）
 */
export async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
    });
    const html = await res.text();
    // og:image メタタグからURLを抽出
    const ogMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogMatch?.[1]) return ogMatch[1];

    // 逆順パターン: content が先に来る場合
    const ogMatch2 = html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
    );
    if (ogMatch2?.[1]) return ogMatch2[1];

    return undefined;
  } catch {
    console.error(`og:image取得失敗: ${url}`);
    return undefined;
  }
}

// 大手アイスメーカー＋コンビニの企業別RSSフィード
// フォーマット: https://prtimes.jp/companyrdf.php?company_id=XXX
const COMPANY_FEEDS: { name: string; id: number }[] = [
  { name: "赤城乳業", id: 515 },
  { name: "ハーゲンダッツ ジャパン", id: 12760 },
  { name: "井村屋", id: 38645 },
  { name: "森永乳業", id: 21580 },
  { name: "森永製菓", id: 19896 },
  { name: "協同乳業", id: 10851 },
  { name: "株式会社 明治", id: 155982 },
  { name: "オハヨー乳業", id: 27905 },
  { name: "ロッテ", id: 2360 },
  { name: "ロッテアイス", id: 4964 },
  { name: "江崎グリコ", id: 1124 },
  { name: "シャトレーゼ", id: 4553 },
  { name: "セブン‐イレブン・ジャパン", id: 155396 },
  { name: "ローソン", id: 2136 },
  { name: "ファミリーマート", id: 46210 },
];

const RSS_URLS = COMPANY_FEEDS.map(
  (c) => `https://prtimes.jp/companyrdf.php?company_id=${c.id}`
);

// キーワードフィルタ: 「アイスクリーム」「アイス」関連に限定
const KEYWORDS = [
  "アイスクリーム",
  "アイス",
];

export async function fetchIceCreamNews(): Promise<PressRelease[]> {
  // User-Agentをブラウザ互換に設定（Cloudflare WAF対策）
  const parser = new Parser({
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    timeout: 15000,
  });

  const allItems: PressRelease[] = [];
  const seenGuids = new Set<string>();

  for (const url of RSS_URLS) {
    try {
      console.log(`RSS取得開始: ${url}`);
      const feed = await parser.parseURL(url);
      console.log(`RSS取得成功: ${feed.items.length}件のアイテム`);

      for (const item of feed.items) {
        const guid = item.guid || item.link || "";
        if (seenGuids.has(guid)) continue;

        const text = `${item.title || ""} ${item.contentSnippet || ""} ${item.content || ""}`;
        // 企業別フィードなので、キーワードのみでフィルタ
        const isRelevant = KEYWORDS.some((kw) =>
          text.toLowerCase().includes(kw.toLowerCase())
        );

        if (isRelevant) {
          seenGuids.add(guid);
          // RSSコンテンツから画像URLを抽出
          const imageUrl =
            extractMediaContentUrl((item as Record<string, unknown>)["media:content"]) ||
            extractImageFromContent(item.content || "") ||
            (item.enclosure as { url?: string })?.url;

          allItems.push({
            title: item.title || "",
            description: (item.contentSnippet || item.content || "").slice(0, 1500),
            link: item.link || "",
            pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
            guid,
            imageUrl,
          });
        }
      }
      console.log(`キーワード一致: ${allItems.length}件`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`RSS取得エラー: ${url} → ${errMsg}`);

      // フォールバック: fetchで直接取得してパース
      try {
        console.log(`フォールバック: fetchで直接取得`);
        const res = await fetch(url, {
          headers: {
            "User-Agent": BROWSER_UA,
            Accept: "application/rss+xml, application/xml, text/xml, */*",
          },
        });
        const text = await res.text();
        console.log(`fetch結果: status=${res.status}, content-type=${res.headers.get("content-type")}, length=${text.length}`);
        console.log(`最初の500文字: ${text.substring(0, 500)}`);

        // fetchしたテキストを直接パース
        const feed = await parser.parseString(text);
        console.log(`パース成功: ${feed.items.length}件`);

        for (const item of feed.items) {
          const guid = item.guid || item.link || "";
          if (seenGuids.has(guid)) continue;

          const itemText = `${item.title || ""} ${item.contentSnippet || ""} ${item.content || ""}`;
          const isRelevant = KEYWORDS.some((kw) =>
            itemText.toLowerCase().includes(kw.toLowerCase())
          );

          if (isRelevant) {
            seenGuids.add(guid);
            const fbImageUrl =
              extractMediaContentUrl((item as Record<string, unknown>)["media:content"]) ||
              extractImageFromContent(item.content || "") ||
              (item.enclosure as { url?: string })?.url;

            allItems.push({
              title: item.title || "",
              description: (item.contentSnippet || item.content || "").slice(0, 1500),
              link: item.link || "",
              pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
              guid,
              imageUrl: fbImageUrl,
            });
          }
        }
        console.log(`フォールバック キーワード一致: ${allItems.length}件`);
      } catch (fallbackError) {
        const fbMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        console.error(`フォールバックも失敗: ${fbMsg}`);
      }
    }
  }

  // 新しい順にソート
  return allItems.sort(
    (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
  );
}
