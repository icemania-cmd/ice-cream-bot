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
  const parser = new Parser();
  const allItems: PressRelease[] = [];
  const seenGuids = new Set<string>();

  for (const url of RSS_URLS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items) {
        const guid = item.guid || item.link || "";
        if (seenGuids.has(guid)) continue;

        const text = `${item.title || ""} ${item.contentSnippet || ""}`.toLowerCase();
        const isRelevant = KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));

        if (isRelevant) {
          seenGuids.add(guid);
          allItems.push({
            title: item.title || "",
            description: (item.contentSnippet || "").slice(0, 300),
            link: item.link || "",
            pubDate: item.pubDate || new Date().toISOString(),
            guid,
          });
        }
      }
    } catch (error) {
      console.error(`RSS取得エラー: ${url}`, error);
    }
  }

  // 新しい順にソート
  return allItems.sort(
    (a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
  );
}
