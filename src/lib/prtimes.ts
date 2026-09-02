import {
  BROWSER_UA,
  COMPANY_FEEDS,
  FIREHOSE_URL,
  ATPRESS_FEED_URL,
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
  /** og:title（記事URLだけを指定して試すときの表題） */
  ogTitle?: string;
  /** 配信企業名（og:site_name は「PR TIMES」になるため <title> から取る） */
  ogSiteName?: string;
  /** 本文中の商品画像候補（IGの画像選択用）。絶対URL・重複除去・最大8件 */
  images?: string[];
}

// ===== 低レベルユーティリティ =====

/** AbortController 付き fetch。Vercel 上で1本のリクエストが全体を道連れにしないようにする。 */
/**
 * キャッシュ回避用のクエリを足す。
 *
 * 配信側やCDNがフィードをキャッシュしていると、10分おきに叩いても
 * 同じ内容が返り続け、数時間ぶんがまとめて出現する挙動になる。
 * 速報botとしては致命的なので、毎回URLを変えて確実に取りに行く。
 */
function bustCache(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_", Date.now().toString());
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  accept: string
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(bustCache(url), {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: accept,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
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
  /** 主ソースの最新記事が何分前のものか。フィードが止まっていないかの指標 */
  freshnessMinutes: number | null;
  /** 主ソースの最新記事の配信時刻 */
  newestAt: string | null;
  /** 配信元ごとの鮮度（分）。どちらのフィードが止まったのか切り分けるため */
  freshnessBySource: { source: string; minutes: number | null }[];
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
    // PR TIMES を使わないメーカーがあるため @Press も主ソースとして常に見る
    { url: ATPRESS_FEED_URL, source: "atpress", timeout: 12000 },
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

  // フィードの鮮度。ここが数時間ぶん遅れていたら配信側かCDNのキャッシュを疑う。
  // 主ソースが2本あるので、片方だけ止まった場合に分かるよう別々に出す。
  const minutesOf = (src: string): { minutes: number | null; at: string | null } => {
    const of = releases.filter((r) => r.source === src);
    const at = of.length > 0 ? of[0].publishedAt : null;
    const ms = at ? new Date(at).getTime() : NaN;
    return {
      minutes: Number.isFinite(ms) ? Math.round((Date.now() - ms) / 60000) : null,
      at,
    };
  };
  const prtimes = minutesOf("firehose");
  const atpress = minutesOf("atpress");
  const freshnessBySource = [
    { source: "PR TIMES", minutes: prtimes.minutes },
    { source: "@Press", minutes: atpress.minutes },
  ];

  return {
    releases,
    feedsOk,
    feedsFailed,
    freshnessMinutes: prtimes.minutes,
    newestAt: prtimes.at,
    freshnessBySource,
  };
}

// ===== 記事ページの詳細取得 =====

/**
 * 本文HTMLから商品画像らしき <img> を集める。IGの画像候補に使う。
 * ロゴ・アイコン・スペーサ等は名前で弾き、絶対URL化して重複を除く。
 */
function extractImages(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\b(?:data-src|data-original|src)=["\']([^"\']+)["\']/i) || [])[1];
    if (!src) continue;
    let abs: string;
    try {
      abs = new URL(src, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    if (/\.svg(\?|$)/i.test(abs)) continue;
    if (/(sprite|icon|logo|avatar|spacer|blank|loading|pixel|tracking|1x1|badge|arrow|common)/i.test(abs)) continue;
    // 画像らしさ（拡張子 or 画像配信パス）で軽く絞る
    if (!/\.(jpe?g|png|webp|gif)(\?|$)/i.test(abs) && !/(\/img|image|media|upload|assets)/i.test(abs)) continue;
    urls.push(abs);
  }
  return Array.from(new Set(urls)).slice(0, 8);
}

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
    const ogTitle = metaContent(html, "og:title");
    // PR TIMES の og:site_name は「…｜PR TIMES」で会社名にならない。
    // <title> の「｜○○のプレスリリース」から配信元を取る。
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    const cleanTitle = decodeEntities(titleTag);
    const ogSiteName =
      cleanTitle.match(/[|｜]\s*([^|｜]+?)のプレスリリース/)?.[1]?.trim() ||
      // @Press は「タイトル | 会社名」。末尾の区切り以降を配信元として扱う。
      (/atpress\.ne\.jp/.test(link)
        ? cleanTitle.split(/[|｜]/).pop()?.trim()
        : undefined) ||
      metaContent(html, "og:site_name");

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

    const images = extractImages(main, link);
    if (bodyText.length < 50)
      return { bodyText: "", ogImage, ogTitle, ogSiteName, images };
    return { bodyText, ogImage, ogTitle, ogSiteName, images };
  } catch {
    return null;
  }
}
