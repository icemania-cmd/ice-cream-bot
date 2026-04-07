import Parser from "rss-parser";

export interface PressRelease {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  guid: string;
}

// PR TIMESのメインRSSフィード（全プレスリリース）
// ※ searchrss エンドポイントは廃止済み。全件取得→キーワードフィルタで対応
const RSS_URLS = [
  "https://prtimes.jp/index.rdf",
];

// キーワードフィルタ: これらのいずれかを含む記事のみ対象
const KEYWORDS = [
  "アイスクリーム",
  "アイス",
  "ジェラート",
  "ソフトクリーム",
  "かき氷",
  "シャーベット",
  "フローズン",
  "氷菓",
  "パフェ",
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
