import { MAX_TWEET_WEIGHT, POST_PREFIX } from "./config";
import type { Extraction } from "./classify";

/**
 * 生成された投稿文を原文と機械照合する。
 *
 * ここが「ハイブリッド運用」の心臓部。全項目クリアなら自動投稿、
 * 1つでも引っかかったら人間の承認待ちに回す。LLM に自己採点はさせない。
 *
 * 重要な考え方:
 * 「原文のどこかに同じ文字列がある」だけでは不十分。プレスリリースは
 * 1本で3〜5商品を告知することが多く、商品Aの名前に商品Bの価格、
 * 商品Cの発売日を組み合わせても素朴な部分一致は全部通ってしまう。
 * そのため価格・日付・販売エリアは「商品名の近くにあるか」まで見る。
 */

export interface VerifyResult {
  /** 自動投稿してよいか */
  autoPostable: boolean;
  /** そもそも投稿してはいけない致命的問題（承認画面でも修正必須） */
  blocking: string[];
  /** 人間の目視確認が必要な疑い */
  warnings: string[];
  /** 前後の空白除去や接頭辞補完を済ませた最終本文 */
  text: string;
  weight: number;
}

/** 全角英数字・記号を半角に寄せ、空白を落として照合の取りこぼしを防ぐ */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/[，、]/g, ",")
    .replace(/[／]/g, "/")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .replace(/[〜～]/g, "~")
    .replace(/[＃]/g, "#")
    .replace(/\s+/g, "");
}

/** X の文字数カウント近似（全角2・半角1）。URLは含めない前提。 */
export function tweetWeight(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  return w;
}

/** "2026-09-01" → 原文にありうる表記のバリエーション（正規化済み） */
function dateVariants(iso: string): string[] {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, yyyy, mm, dd] = m;
  const mo = String(parseInt(mm, 10));
  const d = String(parseInt(dd, 10));
  return [
    `${mo}月${d}日`,
    `${mm}月${dd}日`,
    `${mo}月${dd}日`,
    `${mm}月${d}日`,
    `${yyyy}年${mo}月${d}日`,
    `${mo}/${d}`,
    `${mm}/${dd}`,
    `${yyyy}/${mm}/${dd}`,
    `${yyyy}-${mm}-${dd}`,
  ];
}

/** hay の中の needle の出現位置をすべて返す */
function indicesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < 30) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/** 商品名の周辺に token があるか。商品名が見つからない場合は全文一致に緩める。 */
const PROXIMITY_WINDOW = 200;

function nearProduct(
  src: string,
  productName: string,
  token: string,
  altTokens: string[] = []
): boolean {
  const all = [token, ...altTokens].filter(Boolean);
  const anchors = indicesOf(src, productName);
  if (anchors.length === 0) {
    // 商品名が原文で見つからない場合は別途警告が出るので、ここは全文一致で判定
    return all.some((t) => src.includes(t));
  }
  for (const idx of anchors) {
    const from = Math.max(0, idx - PROXIMITY_WINDOW);
    const to = idx + productName.length + PROXIMITY_WINDOW;
    if (all.some((t) => src.slice(from, to).includes(t))) return true;
  }
  return false;
}

// ===== 「その商品の値」かどうかを見る仕組み =====

interface Occurrence<T> {
  index: number;
  raw: string;
  value: T;
}

/**
 * 原文中で、商品名の直後に最初に現れる値を「その商品の値」とみなす。
 *
 * 日本語のプレスリリースは「商品名 → 発売日 → 価格」の順で書かれるため、
 * 商品名より後ろにある最初の値がその商品のものになる。
 * 単純な「いちばん近い値」にすると、直前の商品の価格
 * （例: …86円（税別）。また、BLACK濃厚チョコは…）を拾ってしまう。
 *
 * 判定材料が足りないときは null を返し、呼び出し側は近傍判定にとどめる。
 */
function attributedValues<T>(
  src: string,
  productName: string,
  occurrences: Occurrence<T>[]
): Set<T> | null {
  const anchors = indicesOf(src, productName);
  if (anchors.length === 0 || occurrences.length === 0) return null;

  const chosen = new Set<T>();
  for (const a of anchors) {
    const after = occurrences.find((o) => o.index >= a);
    if (after) {
      chosen.add(after.value);
      continue;
    }
    // 商品名より後ろに無ければ、直前のものを採る
    const before = [...occurrences].reverse().find((o) => o.index < a);
    if (before) chosen.add(before.value);
  }
  return chosen.size > 0 ? chosen : null;
}

// ---- 価格 ----

const PRICE_RE = /[\d,]+円/g;

function priceOccurrences(text: string): Occurrence<number>[] {
  const out: Occurrence<number>[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const value = parseInt(m[0].replace(/[,円]/g, ""), 10);
    if (Number.isFinite(value)) {
      out.push({ index: m.index ?? 0, raw: m[0], value });
    }
  }
  return out;
}

// ---- 日付 ----

/** 表記ゆれを吸収した日付の正規形。"9-1" や "9-上旬" のような形にする。 */
const DATE_RE =
  /(?:\d{4}年)?\d{1,2}月\d{1,2}日|\d{1,2}月(?:上|中|下)旬|\d{1,2}\/\d{1,2}/g;

function canonicalDate(raw: string): string | null {
  let m = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}`;
  m = raw.match(/(\d{1,2})月(上|中|下)旬/);
  if (m) return `${parseInt(m[1], 10)}-${m[2]}旬`;
  m = raw.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}`;
  return null;
}

function dateOccurrences(text: string): Occurrence<string>[] {
  const out: Occurrence<string>[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const value = canonicalDate(m[0]);
    if (value) out.push({ index: m.index ?? 0, raw: m[0], value });
  }
  return out;
}

// ---- 税表記 ----

const TAX_TERMS = ["税込", "税抜", "税別"] as const;

/** 文中で price の直後（15文字以内）に現れる税表記を返す */
function taxNear(text: string, priceRaw: string): string | null {
  for (const idx of indicesOf(text, priceRaw)) {
    const window = text.slice(idx, idx + priceRaw.length + 15);
    for (const t of TAX_TERMS) if (window.includes(t)) return t;
  }
  return null;
}

// ---- 販売エリア ----

/**
 * 販売エリアの表明。商品名の直後に現れるものをその商品のエリアとみなす。
 * 「全国」は原文のどこかに必ずと言っていいほど出てくる（例:「全国の量販店」）ため、
 * 単純な部分一致では捏造を検出できない。どの商品のエリアかまで見る必要がある。
 */
const REGION_RE =
  /全国|一部地域|一部店舗|一部エリア|関東|関西|東海|近畿|中部|九州|北海道|沖縄|東北|中国・四国|四国/g;

function regionOccurrences(text: string): Occurrence<string>[] {
  const out: Occurrence<string>[] = [];
  for (const m of text.matchAll(REGION_RE)) {
    out.push({ index: m.index ?? 0, raw: m[0], value: m[0] });
  }
  return out;
}

// 販売チャネルの主張。原文に裏が取れないと事故になる語。
const CHANNEL_CLAIMS = [
  "先行",
  "限定",
  "セブン",
  "ローソン",
  "ファミリーマート",
  "ファミマ",
  "ミニストップ",
  "ドラッグストア",
];
// 「コンビニ」「スーパー」は締めのひと言（例: コンビニ寄らなきゃ）に出るため対象外

const EMOJI_RE =
  /[\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2500}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}\u{20E3}]/u;
const URL_RE = /(https?:\/\/|www\.|[a-z0-9-]+\.(?:jp|com|net|co\.jp)\b)/i;

export function verifyPost(params: {
  extraction: Extraction;
  /** タイトル・配信企業・RSS要約・記事本文を全部つないだもの */
  sourceText: string;
  /** JST の今日（YYYY-MM-DD） */
  today: string;
}): VerifyResult {
  const { extraction: ex, sourceText, today } = params;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const src = normalize(sourceText);
  const product = normalize(ex.product_name);

  // 接頭辞はモデルが付け忘れることがあるのでコード側で必ず整える。
  // 【】以外で始まっていても二重付与にならないよう、先頭の【…】は一度剥がす。
  let text = ex.post_text.trim().replace(/^[^【]*(?=【)/, "");
  if (text.startsWith("【")) text = text.replace(/^【[^】]*】/, "");
  text = POST_PREFIX + text.trim();

  const ntext = normalize(text);
  const weight = tweetWeight(text);

  // ---- 致命的（投稿不能）----
  if (text.replace(POST_PREFIX, "").trim().length === 0) {
    blocking.push("投稿本文が空です");
  }
  if (weight > MAX_TWEET_WEIGHT) {
    blocking.push(`文字数超過（${weight}/${MAX_TWEET_WEIGHT}）`);
  }
  if (URL_RE.test(text)) blocking.push("投稿文にURLらしき文字列が含まれています");
  if (ntext.includes("#")) blocking.push("投稿文にハッシュタグが含まれています");
  if (EMOJI_RE.test(text)) blocking.push("投稿文に絵文字が含まれています");

  // ---- 事実照合（1つでも当たれば承認待ちへ）----

  // 1. 商品名
  if (!ex.product_name) {
    warnings.push("商品名を特定できていません");
  } else {
    if (!src.includes(product)) {
      warnings.push(`商品名「${ex.product_name}」が原文と一致しません`);
    }
    if (!ntext.includes(product)) {
      warnings.push("投稿文に商品名が含まれていません");
    }
  }

  // 2. メーカー名
  if (!ex.maker) {
    warnings.push("メーカー名を特定できていません");
  } else if (!src.includes(normalize(ex.maker))) {
    warnings.push(`メーカー名「${ex.maker}」が原文と一致しません`);
  }

  // ---- 原文側の値を1度だけ抽出しておく ----
  const srcPrices = priceOccurrences(src);
  const srcDates = dateOccurrences(src);
  const productPrices = attributedValues(src, product, srcPrices);
  const productDates = attributedValues(src, product, srcDates);

  // 3. 発売日
  if (!ex.release_date) {
    warnings.push("発売日を特定できていません");
  } else {
    const iso = ex.release_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const canon = iso
      ? `${parseInt(iso[2], 10)}-${parseInt(iso[3], 10)}`
      : null;

    if (canon && productDates && !productDates.has(canon)) {
      warnings.push(
        `発売日 ${ex.release_date} がこの商品の日付として原文で確認できません（原文で商品名の直後にある日付: ${Array.from(productDates).join("/")}）`
      );
    } else if (canon && !srcDates.some((o) => o.value === canon)) {
      warnings.push(
        `発売日 ${ex.release_date} が原文に見当たりません（AIの推定の可能性）`
      );
    }

    if (ex.release_date < today) {
      warnings.push(`発売日 ${ex.release_date} が過去日です（本日 ${today}）`);
    }

    // 抽出した発売日が投稿文に現れているか（本文と抽出結果の食い違い検出）
    const inText = dateOccurrences(ntext).some((o) => o.value === canon);
    if (!inText) {
      warnings.push("抽出した発売日が投稿文に見当たりません");
    }
  }

  // 4. 投稿文中の日付表記がすべてこの商品のものか
  for (const o of dateOccurrences(ntext)) {
    if (!srcDates.some((s2) => s2.value === o.value)) {
      warnings.push(`投稿文の日付「${o.raw}」が原文に見当たりません`);
    } else if (productDates && !productDates.has(o.value)) {
      warnings.push(
        `投稿文の日付「${o.raw}」は別商品の日付の可能性があります（この商品の日付: ${Array.from(productDates).join("/")}）`
      );
    }
  }

  // 5. 投稿文中の価格がすべてこの商品のものか
  for (const o of priceOccurrences(ntext)) {
    if (!srcPrices.some((s2) => s2.value === o.value)) {
      warnings.push(`投稿文の価格「${o.raw}」が原文に見当たりません`);
      continue;
    }
    if (productPrices && !productPrices.has(o.value)) {
      warnings.push(
        `投稿文の価格「${o.raw}」は別商品の価格の可能性があります（この商品の価格: ${Array.from(productPrices).map((v) => v + "円").join("/")}）`
      );
      continue;
    }
    // 6. 税込／税抜の取り違え。同じ金額に原文で別の税表記が付いていないか。
    const postTax = taxNear(ntext, o.raw);
    if (postTax) {
      const srcTax = taxNear(src, o.raw) || taxNear(src, `${o.value}円`);
      if (srcTax && srcTax !== postTax) {
        warnings.push(
          `税表記が原文と異なります（投稿:${postTax} / 原文:${srcTax}）`
        );
      } else if (!srcTax) {
        warnings.push(`「${postTax}」という表記が原文の価格に付いていません`);
      }
    }
  }

  // 7. 販売エリア
  const productRegions = attributedValues(src, product, regionOccurrences(src));
  for (const r of regionOccurrences(ntext)) {
    if (productRegions && !productRegions.has(r.value)) {
      warnings.push(
        `販売エリア「${r.raw}」が原文と異なる可能性があります（原文で商品名の直後にあるのは「${Array.from(productRegions).join("/")}」）`
      );
    } else if (!productRegions && !src.includes(r.value)) {
      warnings.push(`販売エリア「${r.raw}」が原文にありません`);
    }
  }

  // 8. 販売チャネルの主張
  for (const claim of CHANNEL_CLAIMS) {
    if (!ntext.includes(claim)) continue;
    if (!nearProduct(src, product, claim)) {
      warnings.push(
        `販売エリア・チャネルの表現「${claim}」を商品名の近くで確認できません`
      );
    }
  }

  return {
    autoPostable: blocking.length === 0 && warnings.length === 0,
    blocking,
    warnings,
    text,
    weight,
  };
}
