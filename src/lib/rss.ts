import Parser from "rss-parser";

export interface PressRelease {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  guid: string;
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
  // User-Agentを設定（ブロック対策）
  const parser = new Parser({
    headers: {
      "User-Agent": "IceCreamBot/1.0 (RSS Reader)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    timeout: 10000,
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
          allItems.push({
            title: item.title || "",
            description: (item.contentSnippet || item.content || "").slice(0, 300),
            link: item.link || "",
            pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
            guid,
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
            "User-Agent": "IceCreamBot/1.0 (RSS Reader)",
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
            allItems.push({
              title: item.title || "",
              description: (item.contentSnippet || item.content || "").slice(0, 300),
              link: item.link || "",
              pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
              guid,
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
