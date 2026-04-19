import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export interface CvsProduct {
  store: string; // ファミリーマート / セブン-イレブン / ローソン / ミニストップ
  name: string; // 商品名
  maker: string; // メーカー名
  price: string; // 価格（税込表記含む）
  releaseDate: string; // 発売日（YYYY-MM-DD or 空）
  region: string; // 販売エリア
  description: string; // 商品説明
  imageUrl: string; // 商品画像URL
  productId: string; // 重複チェック用の一意キー
}

const CVS_SITES = [
  {
    store: "ファミリーマート",
    url: "https://www.family.co.jp/goods/ice.html",
    baseUrl: "https://www.family.co.jp",
  },
  {
    store: "セブン-イレブン",
    url: "https://www.sej.co.jp/products/a/cat/060020010000000/",
    baseUrl: "https://www.sej.co.jp",
  },
  {
    store: "ローソン",
    url: "https://www.lawson.co.jp/recommend/original/icecream/",
    baseUrl: "https://www.lawson.co.jp",
  },
  {
    store: "ミニストップ",
    url: "https://www.ministop.co.jp/syohin/icecream.html",
    baseUrl: "https://www.ministop.co.jp",
  },
  {
    store: "竹下製菓",
    url: "https://takeshita-seika.jp/pages/41/",
    baseUrl: "https://takeshita-seika.jp",
  },
];

/**
 * HTMLをfetchして取得する
 */
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.7,en;q=0.3",
      },
    });

    if (!res.ok) {
      console.error(`HTML取得失敗: ${url} → ${res.status}`);
      return null;
    }

    return await res.text();
  } catch (error) {
    console.error(
      `HTML取得エラー: ${url} →`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * HTMLから不要な部分を除去して軽量化する
 * <script>, <style>, <head>, ナビゲーション等を除去
 */
function cleanHtml(html: string): string {
  let cleaned = html;
  // <head>セクション全体を除去
  cleaned = cleaned.replace(/<head[\s\S]*?<\/head>/gi, "");
  // <script>タグを除去
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, "");
  // <style>タグを除去
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  // <noscript>タグを除去
  cleaned = cleaned.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  // <nav>タグを除去
  cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  // <footer>タグを除去
  cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  // HTMLコメントを除去
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  // 連続する空白・改行を圧縮
  cleaned = cleaned.replace(/\s{2,}/g, " ");
  return cleaned.trim();
}

/**
 * Claude APIでHTMLからアイスクリーム商品情報を抽出する
 */
async function extractProductsFromHtml(
  html: string,
  store: string,
  baseUrl: string
): Promise<CvsProduct[]> {
  try {
    // 不要なHTML要素を除去してから切り詰め
    const cleanedHtml = cleanHtml(html);
    const truncatedHtml =
      cleanedHtml.length > 50000 ? cleanedHtml.substring(0, 50000) : cleanedHtml;
    console.log(`${store}: HTML軽量化 ${html.length} → ${cleanedHtml.length} → 送信${truncatedHtml.length}文字`);

    const takeshitaNote = store === "竹下製菓" ? `
【竹下製菓 特別ルール】
このページは竹下製菓の新商品ニュース一覧です。
抽出対象：ブラックモンブラン・ミルクック・トラキチ君・くろしろ君など「アイスクリーム」「アイス」本体の新商品のみ。
絶対に含めないもの：マシュマロ・クランチチョコ・ふわふわケーキ・鶴の里など、アイスのブランド名を冠したお菓子・チョコレート・スナック類。
発売日はニュース記事のタイトルや本文から抽出すること（例：「4月7日より発売」→ releaseDate: "2026-04-07"）。
販売エリアは記事に明記されている場合のみ記載すること。「全国」「九州限定」等が明記されていない場合は必ず空文字にすること（「全国」をデフォルトにしない）。
アイスか判断できないものは含めない。` : "";

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: `以下のHTMLは「${store}」の商品ページです。
このHTMLから **アイスクリーム・アイス・ジェラート・ソフトクリーム** の商品情報のみを抽出してください。
${store === "ミニストップ" ? "ハロハロ・パフェなどのコールドスイーツも含めてOKです。" : ""}
${takeshitaNote}

【重要】アイスクリーム類以外の商品（スイーツ、飲料、おにぎり、弁当、パンなど）は絶対に含めないでください。

以下のJSON配列形式で出力してください。商品がない場合は空配列 [] を出力してください。

[
  {
    "name": "商品名",
    "maker": "メーカー名（不明なら空文字）",
    "price": "価格（税込表記があれば含む。不明なら空文字）",
    "releaseDate": "発売日（YYYY-MM-DD形式。不明なら空文字）",
    "region": "販売エリア（不明なら「全国」）",
    "description": "商品の特徴を短く（不明なら空文字）",
    "imageUrl": "商品画像URL（相対パスのまま可）"
  }
]

JSON配列のみを出力してください。余計な説明や前置き、マークダウンのコードブロック記号は不要です。

HTML:
${truncatedHtml}`,
        },
      ],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text.trim() : "";

    // JSONパース
    let products: Array<{
      name: string;
      maker: string;
      price: string;
      releaseDate: string;
      region: string;
      description: string;
      imageUrl: string;
    }> = [];

    try {
      // マークダウンのコードブロック記号を除去（改行付きパターンにも対応）
      let cleanJson = text
        .replace(/```json?\s*/gi, "")
        .replace(/```\s*/gi, "")
        .trim();

      // JSON配列の開始・終了を見つけてそこだけ抽出（余計なテキスト混入対策）
      const startIdx = cleanJson.indexOf("[");
      const endIdx = cleanJson.lastIndexOf("]");
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        cleanJson = cleanJson.substring(startIdx, endIdx + 1);
      }

      products = JSON.parse(cleanJson);
    } catch (parseError) {
      // JSONが途中で切れた場合、最後の完全なオブジェクトまでで復旧を試みる
      console.error(`JSON解析エラー（${store}）:`, text.substring(0, 200));
      try {
        let truncated = text;
        // ``` を除去
        truncated = truncated.replace(/```json?\s*/gi, "").replace(/```\s*/gi, "").trim();
        const arrStart = truncated.indexOf("[");
        if (arrStart !== -1) {
          truncated = truncated.substring(arrStart);
          // 最後の完全な "},{ または "} ] を見つけて切る
          const lastCompleteObj = truncated.lastIndexOf("},");
          if (lastCompleteObj > 0) {
            truncated = truncated.substring(0, lastCompleteObj + 1) + "]";
            products = JSON.parse(truncated);
            console.log(`JSON復旧成功（${store}）: ${products.length}件を救出`);
          } else {
            products = [];
          }
        } else {
          products = [];
        }
      } catch {
        console.error(`JSON復旧も失敗（${store}）`);
        products = [];
      }
    }

    if (!Array.isArray(products)) return [];

    // CvsProduct形式に変換
    return products.map((p) => {
      // 相対URLを絶対URLに変換
      let imageUrl = p.imageUrl || "";
      if (imageUrl && !imageUrl.startsWith("http")) {
        imageUrl = imageUrl.startsWith("/")
          ? `${baseUrl}${imageUrl}`
          : `${baseUrl}/${imageUrl}`;
      }

      return {
        store,
        name: p.name || "",
        maker: p.maker || "",
        price: p.price || "",
        releaseDate: p.releaseDate || "",
        region: p.region || "全国",
        description: p.description || "",
        imageUrl,
        // 重複チェック用キー: 店名+商品名をハッシュ化
        productId: `cvs:${store}:${p.name}`.replace(/\s/g, ""),
      };
    });
  } catch (error) {
    console.error(
      `商品抽出エラー（${store}）:`,
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

/**
 * 全コンビニサイトをスキャンしてアイスクリーム商品を取得する
 */
export async function scanAllCvs(): Promise<CvsProduct[]> {
  const allProducts: CvsProduct[] = [];

  for (const site of CVS_SITES) {
    console.log(`🏪 ${site.store} スキャン開始: ${site.url}`);

    const html = await fetchHtml(site.url);
    if (!html) {
      console.error(`${site.store}: HTML取得失敗、スキップ`);
      continue;
    }

    console.log(`${site.store}: HTML取得成功（${html.length} bytes）`);

    const products = await extractProductsFromHtml(
      html,
      site.store,
      site.baseUrl
    );
    console.log(`${site.store}: ${products.length}件のアイス商品を検出`);

    allProducts.push(...products);
  }

  return allProducts;
}
