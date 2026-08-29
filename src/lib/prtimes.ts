import {
  BROWSER_UA,
  COMPANY_FEEDS,
  FIREHOSE_URL,
  companyFeedUrl,
} from "./config";

export interface Release {
  /** 記事URL。PR TIMES ではこれが一意なのでそのまま ID に使う。 */
  guid: string;
  title: string;
  link: string;
  /** RSS の description（本文冒頭＋画像参照） */
  summary: string;
  /** dc:corp（配信企業名） */
  corp: string;
  /** dc:date（ISO8601, JSTオフセット付き） */
  publishedAt: string;
  /** RSS から拾えた画像URL */
  imageUrl?: string;
  /** どのフィードで見つけたか（デバッグ用） */
  source: string;
}

/** 記事ページから追加取得した情報 */
export interface ReleaseDetail {
  /** 本文プレーンテキスト（Claude への入力・事実照合の突き合わせ元） */
  bodyText: string;
  /** og:image（RSS の画像より高解像度なことが多い） */
  ogImage?: string;
}

// ===== 低レベルユーティリティ =====

/** AbortController 付き fetch。Vercel 上で1本のリクエストが全体を道連れにしないようにする。 */
async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  accept: string
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: accept },
      signal: controller.signal,
      cache: "no-store",
    });
    // 本文の読み出しまでタイムアウトの内側で行う。
    // ヘッダ到着時点で clearTimeout してしまうと、応答が止まった相手に
    // 無制限に待たされ、Vercel の実行時間を食い潰す。
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#039;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? m);
}

/** <tag>…</tag> の中身を取り出す。CDATA も剥がす。 */
function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  let v = m[1];
  const cdata = v.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) v = cdata[1];
  return decodeEntities(v).trim();
}

/**
 * PR TIMES の description に埋まっている画像参照を拾う。
 *   例: [画像1: https://prcdn.freetls.fastly.net/release_image/…]
 * 併せて <img src> 形式にも対応しておく。
 */
export function extractImageFromSummary(summary: string): string | undefined {
  const bracket = summary.match(
    /\[画像[^\]]*?:\s*(https?:\/\/[^\s\]]+)/
  );
  if (bracket?.[1]) return bracket[1];
  const img = summary.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1]) return img[1];
  return undefined;
}

// ===== RDF / RSS パース =====

/**
 * RSS 1.0 (RDF) と RSS 2.0 の両方を1本で捌く最小パーサ。
 * rss-parser を使わないのは、PR TIMES の RDF で media:content が
 * 実装差で [object Object] 化するなど過去に事故があったため。
 */
export function parseFeed(xml: string, source: string): Release[] {
  const items: Release[] = [];
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = tagText(block, "title");
    let link = tagText(block, "link");
    if (!link) {
      const about = block.match(/<item[^>]*rdf:about=["']([^"']+)["']/i);
      if (about?.[1]) link = decodeEntities(about[1]);
    }
    if (!title || !link) continue;

    const summary = tagText(block, "description");
    const corp =
      tagText(block, "dc:corp") ||
      tagText(block, "dc:creator") ||
      tagText(block, "author");
    const publishedAt =
      tagText(block, "dc:date") ||
      tagText(block, "pubDate") ||
      tagText(block, "date") ||
      "";

    let imageUrl = extractImageFromSummary(summary);
    if (!imageUrl) {
      const media = block.match(
        /<(?:media:content|enclosure)[^>]*url=["']([^"']+)["']/i
      );
      if (media?.[1]) imageUrl = decodeEntities(media[1]);
    }

    items.push({
      guid: link,
      title,
      link,
      summary,
      corp,
      publishedAt,
      imageUrl,
      source,
    });
  }
  return items;
}

// ===== 取得 =====

async function fetchFeed(
  url: string,
  source: string,
  timeoutMs: number
): Promise<{ items: Release[]; error?: string }> {
  try {
    const res = await fetchTextWithTimeout(
      url,
      timeoutMs,
      "application/rss+xml, application/xml, text/xml, */*"
    );
    if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
    const items = parseFeed(res.text, source);
    if (items.length === 0) {
      return { items: [], error: "0件（フォーマット変更の可能性）" };
    }
    return { items };
  } catch (e) {
    return {
      items: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface FetchReport {
  releases: Release[];
  feedsOk: number;
  feedsFailed: { source: string; error: string }[];
}

/**
 * 主ソース = 全社ファイアホース。
 * includeCompanyFeeds を立てると主要メーカーの企業別フィードも並列で舐める（保険）。
 */
export async function fetchReleases(
  includeCompanyFeeds = false
): Promise<FetchReport> {
  const targets: { url: string; source: string; timeout: number }[] = [
    { url: FIREHOSE_URL, source: "firehose", timeout: 12000 },
  ];
  if (includeCompanyFeeds) {
    for (const c of COMPANY_FEEDS) {
      targets.push({
        url: companyFeedUrl(c.id),
        source: `company:${c.name}`,
        timeout: 8000,
      });
    }
  }

  // 直列だと企業フィード15本で軽く2分超えるので必ず並列にする
  const results = await Promise.all(
    targets.map((t) => fetchFeed(t.url, t.source, t.timeout))
  );

  const byGuid = new Map<string, Release>();
  const feedsFailed: { source: string; error: string }[] = [];
  let feedsOk = 0;

  results.forEach((r, i) => {
    if (r.error) {
      feedsFailed.push({ source: targets[i].source, error: r.error });
      return;
    }
    feedsOk++;
    for (const item of r.items) {
      if (!byGuid.has(item.guid)) byGuid.set(item.guid, item);
    }
  });

  const releases = Array.from(byGuid.values()).sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  return { releases, feedsOk, feedsFailed };
}

// ===== 記事ページの詳細取得 =====

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function metaContent(html: string, property: string): string | undefined {
  const a = html.match(
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
      "i"
    )
  );
  if (a?.[1]) return decodeEntities(a[1]);
  const b = html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
      "i"
    )
  );
  if (b?.[1]) return decodeEntities(b[1]);
  return undefined;
}

/**
 * プレスリリース本文を取得する。
 * RSS の description は途中で切れるため、発売日・価格の照合には本文が要る。
 * 失敗しても致命傷にはせず、呼び出し側が RSS だけで続行できるようにする。
 */
export async function fetchReleaseDetail(
  link: string
): Promise<ReleaseDetail | null> {
  try {
    const res = await fetchTextWithTimeout(link, 12000, "text/html,*/*");
    if (!res.ok) return null;
    const html = res.text;

    const ogImage = metaContent(html, "og:image");

    // 本文らしき領域を優先的に切り出し、取れなければ全体から抜く
    const main =
      html.match(
        /<div[^>]+class=["'][^"']*rich-text[^"']*["'][\s\S]*?<\/article>/i
      )?.[0] ||
      html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
      html;

    const bodyText = decodeEntities(stripHtml(main))
      .replace(/[ \t　]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 8000);

    if (bodyText.length < 50) return { bodyText: "", ogImage };
    return { bodyText, ogImage };
  } catch {
    return null;
  }
}
