import { MAX_TWEET_WEIGHT, POST_PREFIX, tweetWeight } from "./config";
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

/**
 * 照合用の正規化。
 *
 * 表記ゆれで「一致しない」と誤判定すると、正しい投稿まで承認待ちに回って
 * 自動投稿が実質機能しなくなる。日本語のプレスリリースは商品名を
 * 『』「」で囲むのが普通で、投稿文では外れることが多いため、
 * 引用符・かぎ括弧は両側から取り除いたうえで比較する。
 */
function normalize(s: string): string {
  return (
    s
      // 全角英数字 → 半角
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[Ａ-Ｚａ-ｚ]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0)
      )
      // 全角記号 → 半角
      .replace(/[，、]/g, ",")
      .replace(/[／]/g, "/")
      .replace(/[（(]/g, "(")
      .replace(/[）)]/g, ")")
      .replace(/[〜～]/g, "~")
      .replace(/[＃]/g, "#")
      .replace(/[＆]/g, "&")
      .replace(/[％]/g, "%")
      .replace(/[＋]/g, "+")
      .replace(/[－ー―‐−]/g, "-")
      .replace(/[！]/g, "!")
      .replace(/[？]/g, "?")
      .replace(/[：]/g, ":")
      // 引用符・かぎ括弧・中黒は取り除く（商品名の囲み方が一定しないため）
      .replace(/[「」『』“”‘’"'【】〈〉《》〔〕\[\]・･]/g, "")
      // 空白は全部落とす
      .replace(/\s+/g, "")
  );
}

// 既存の呼び出し元（管理画面のAPI）向けに再輸出する
export { tweetWeight };

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
/** 抽出結果の裏付けを探すときに、商品名との距離として許す範囲 */
const EVIDENCE_WINDOW = 300;

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

/**
 * 「280円(税込308円)」のように、ひとつの価格表記が複数の金額を含むことがある。
 * 近接した価格はまとめて1件の価格表記として扱わないと、
 * 税込額を書いただけで「別商品の価格」と誤検出してしまう。
 */
const PRICE_GROUP_GAP = 12;

function groupPrices(
  prices: Occurrence<number>[]
): Occurrence<number[]>[] {
  const groups: Occurrence<number[]>[] = [];
  for (const p of prices) {
    const last = groups[groups.length - 1];
    if (last && p.index - (last.index + last.raw.length) <= PRICE_GROUP_GAP) {
      last.value.push(p.value);
      last.raw = `${last.raw}…${p.raw}`;
      continue;
    }
    groups.push({ index: p.index, raw: p.raw, value: [p.value] });
  }
  return groups;
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

/**
 * 文中で price に付いている税表記を返す。
 * 「373円（税込）」のように後ろに来る形が普通だが、
 * 「280円（税込308円）」のように前に来る形もあるため両方向を見る。
 * 後ろを優先し、無ければ直前を見る。
 */
function taxNear(text: string, priceRaw: string): string | null {
  const positions = indicesOf(text, priceRaw);
  for (const idx of positions) {
    const forward = text.slice(idx, idx + priceRaw.length + 15);
    for (const t of TAX_TERMS) if (forward.includes(t)) return t;
  }
  for (const idx of positions) {
    const backward = text.slice(Math.max(0, idx - 12), idx);
    for (const t of TAX_TERMS) if (backward.includes(t)) return t;
  }
  return null;
}

/**
 * 商品名を意味のある単位に割る。
 * 「ANY1 ICE あずき」と「ANY1 ICE CREAMから第三弾『あずき』」のように、
 * 同じ商品を別の言い回しで書いてしまうことがあるため、
 * 完全一致ではなく「構成語がすべて含まれるか」で見る。
 */
/**
 * 商品名の末尾に付いた補足を落とす。
 * 「UN/ICE BOX（10フレーバー）」のように内容量やフレーバー数を括弧で
 * 付け足して抽出されることがあり、そのままだと投稿文と一致しない。
 */
function coreProductName(name: string): string {
  return name.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
}

function productTokens(productName: string): string[] {
  return productName
    .split(/[\s　・･/／、,＆&＋+\-ー―「」『』()（）]+/)
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2);
}

function containsAllTokens(haystack: string, tokens: string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
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
  "セブン",
  "ローソン",
  "ファミリーマート",
  "ファミマ",
  "ミニストップ",
  "ドラッグストア",
];

/**
 * 「限定」は「期間限定」「数量限定」の形でほぼ全てのリリースに出てくる。
 * 商品名との近接まで求めると誤警告が増えるだけなので、原文にあるかだけ見る。
 * 「セブン‐イレブン限定」のような取り違えは店舗名側の判定で捕まえる。
 */
const LOOSE_CLAIMS = ["限定"];
// 「コンビニ」「スーパー」は締めのひと言（例: コンビニ寄らなきゃ）に出るため対象外

/**
 * 絵文字の判定。
 * 矢印（→ ⇒ など U+2190〜U+21FF）は文章の記号として使うので除外する。
 * アイスマン福留の文体では「濃厚生キャラメル → 8/31(月)発売」のように用いる。
 */
const EMOJI_RE =
  /[\u{00A9}\u{00AE}\u{203C}\u{2049}\u{2122}\u{2139}\u{2300}-\u{23FF}\u{2500}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}\u{20E3}]/u;
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
  const product = normalize(coreProductName(ex.product_name));

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

  // 1. 商品名（完全一致ではなく、構成語がすべて含まれるかで見る）
  const tokens = productTokens(coreProductName(ex.product_name));
  if (!ex.product_name) {
    warnings.push("商品名を特定できていません");
  } else {
    if (!src.includes(product) && !containsAllTokens(src, tokens)) {
      warnings.push(`商品名「${ex.product_name}」が原文で確認できません`);
    }
    if (!ntext.includes(product) && !containsAllTokens(ntext, tokens)) {
      warnings.push("投稿文に商品名が入っていません");
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
  const priceGroups = groupPrices(srcPrices);
  const attributedGroup = attributedValues(src, product, priceGroups);
  // 商品名の直後にある価格表記に含まれる金額（税抜・税込の両方）
  const productPrices = attributedGroup
    ? new Set<number>(Array.from(attributedGroup).flat())
    : null;
  const productDates = attributedValues(src, product, srcDates);

  // 3. 発売日
  //
  // 位置による推定（商品名の直後にある日付）だけだと、
  // 「キャンペーン期間：9月1日〜9月30日」のように発売日が商品名より前に
  // 書かれている記事で取りこぼす。そこで、AIが抽出した発売日の「原文での表記」が
  // 実際に原文にあり、かつその近くでこの商品が語られている場合は、
  // 位置の推定より抽出結果を優先する。
  // 「原文のどこかにあればOK」にはしない（それでは別商品の日付を拾える）。
  const isoMatch = ex.release_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const canonRelease = isoMatch
    ? `${parseInt(isoMatch[2], 10)}-${parseInt(isoMatch[3], 10)}`
    : null;

  const evidenceBackedDate = (() => {
    if (!ex.release_date_text) return false;
    const ev = normalize(ex.release_date_text);
    if (!ev || !src.includes(ev)) return false;
    for (const idx of indicesOf(src, ev)) {
      const w = src.slice(
        Math.max(0, idx - EVIDENCE_WINDOW),
        idx + ev.length + EVIDENCE_WINDOW
      );
      if (w.includes(product) || containsAllTokens(w, tokens)) return true;
    }
    return false;
  })();

  if (!ex.release_date) {
    warnings.push("発売日を特定できていません");
  } else {
    const attributed = productDates?.has(canonRelease ?? "") ?? false;
    if (!attributed && !evidenceBackedDate) {
      if (!srcDates.some((o) => o.value === canonRelease)) {
        warnings.push(
          `発売日 ${ex.release_date} が原文に見当たりません（AIの推定の可能性）`
        );
      } else {
        warnings.push(
          `発売日 ${ex.release_date} がこの商品の日付か確認できません（原文で商品名の直後にある日付: ${
            productDates ? Array.from(productDates).join("/") : "不明"
          }）`
        );
      }
    }

    if (ex.release_date < today) {
      warnings.push(`発売日 ${ex.release_date} が過去日です（本日 ${today}）`);
    }

    // 抽出した発売日が投稿文に現れているか（本文と抽出結果の食い違い検出）
    const inText = dateOccurrences(ntext).some((o) => o.value === canonRelease);
    if (!inText) {
      warnings.push("抽出した発売日が投稿文に見当たりません");
    }
  }

  // 4. 投稿文中の日付表記がすべてこの商品のものか
  for (const o of dateOccurrences(ntext)) {
    if (!srcDates.some((s2) => s2.value === o.value)) {
      warnings.push(`投稿文の日付「${o.raw}」が原文に見当たりません`);
      continue;
    }
    // 抽出した発売日そのもので、裏付けが取れているものは通す
    if (o.value === canonRelease && (evidenceBackedDate || productDates?.has(o.value))) {
      continue;
    }
    if (productDates && !productDates.has(o.value)) {
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
  for (const claim of LOOSE_CLAIMS) {
    if (ntext.includes(claim) && !src.includes(claim)) {
      warnings.push(`「${claim}」という表現が原文にありません`);
    }
  }
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

/** 投稿直前の最終確認の結果 */
export interface FinalCheck {
  /** 形式の違反。絶対に投稿してはいけない */
  blocking: string[];
  /** 原文で裏が取れない主張。人が確認しないと出せない */
  unverified: string[];
  weight: number;
}

/**
 * これから X に出す文そのものを、原文と突き合わせる。
 *
 * これまで事実照合はキューに入れる時点で1度しか走っていなかった。
 * そのため次の2つが無検査のまま外に出ていた。
 *   (1) 古いコードが作り、キューに残っていた文面
 *   (2) 人が承認画面で書き換えた文面
 * 生成の品質をいくら上げても、この経路が空いている限り事故は起きる。
 * だから投稿の直前に、出す文そのものをもう一度見る。
 *
 * 判定の芯は1つだけ:
 *   「投稿文に出てくる金額と日付は、すべて原文にも存在しなければならない」
 * 生成側がどう間違えようと、原文に無い数字は外に出せなくなる。
 */
export function verifyFinalText(params: {
  text: string;
  /** 記事の原文（QueuedItem.sourceExcerpt） */
  sourceText: string;
  /** JST の今日（YYYY-MM-DD） */
  today: string;
}): FinalCheck {
  const { text, sourceText, today } = params;
  const blocking: string[] = [];
  const unverified: string[] = [];
  const src = normalize(sourceText);
  const ntext = normalize(text);
  const weight = tweetWeight(text);

  if (!text.trim()) blocking.push("投稿本文が空です");
  if (weight > MAX_TWEET_WEIGHT) {
    blocking.push(`文字数超過（${weight}/${MAX_TWEET_WEIGHT}）`);
  }
  if (URL_RE.test(text)) {
    blocking.push("投稿文にURLらしき文字列が含まれています");
  }
  if (ntext.includes("#")) blocking.push("投稿文にハッシュタグが含まれています");
  if (EMOJI_RE.test(text)) blocking.push("投稿文に絵文字が含まれています");

  // 原文が手元に無いなら、数字の裏取りはできない。
  // 「確認できなかった」と言い切る。黙って通さない。
  if (!src.trim()) {
    unverified.push(
      "この項目には原文が保存されていないため、数字の裏取りができません（古い項目の可能性）"
    );
    return { blocking, unverified, weight };
  }

  // ---- 金額: 投稿文の金額はすべて原文にあること ----
  const srcPrices = new Set(priceOccurrences(src).map((o) => o.value));
  for (const p of priceOccurrences(ntext)) {
    if (!srcPrices.has(p.value)) {
      unverified.push(`価格「${p.value}円」は原文に出てきません`);
    }
  }

  // ---- 日付: 投稿文の日付はすべて原文にあること ----
  const srcDateList = dateOccurrences(src).map((o) => o.value);
  const srcDates = new Set(srcDateList);
  for (const d of dateOccurrences(ntext)) {
    if (!srcDates.has(d.value)) {
      unverified.push(`日付「${d.value}」は原文に出てきません`);
    }
  }

  // ---- 「発売中」と、まだ来ていない発売日は両立しない ----
  if (/発売中|販売中|好評発売/.test(ntext)) {
    const future = srcDateList.filter((v) => v > today);
    const past = srcDateList.filter((v) => v <= today);
    if (future.length > 0 && past.length === 0) {
      unverified.push(
        `「発売中」とありますが、原文の日付（${future.sort()[0]}）はまだ先です`
      );
    }
  }

  return {
    blocking,
    unverified: Array.from(new Set(unverified)),
    weight,
  };
}
