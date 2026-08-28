import { MAX_TWEET_WEIGHT, POST_PREFIX } from "./config";
import type { Extraction } from "./classify";

/**
 * 生成された投稿文を原文と機械照合する。
 * ここが「ハイブリッド運用」の心臓部で、全項目クリアなら自動投稿、
 * 1つでも引っかかったら人間の承認待ちに回す。
 * LLM に自己採点させず、必ず文字列一致で判定する。
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

/** 全角英数字・記号を半角に寄せ、照合の取りこぼしを防ぐ */
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
    .replace(/\s+/g, "");
}

/** X の文字数カウント近似（全角2・半角1）。URLは含めない前提。 */
export function tweetWeight(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  return w;
}

/** "2026-09-01" → 原文にありうる表記のバリエーション */
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

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const URL_RE = /(https?:\/\/|www\.)/i;

export function verifyPost(params: {
  extraction: Extraction;
  /** タイトル・RSS要約・記事本文を全部つないだもの */
  sourceText: string;
  /** JST の今日（YYYY-MM-DD） */
  today: string;
}): VerifyResult {
  const { extraction: ex, sourceText, today } = params;
  const blocking: string[] = [];
  const warnings: string[] = [];
  const src = normalize(sourceText);

  // 接頭辞は指示忘れが起きうるのでコード側で必ず補完する
  let text = ex.post_text.trim();
  if (!text.startsWith(POST_PREFIX)) {
    text = POST_PREFIX + text.replace(/^【[^】]*】/, "");
  }

  const weight = tweetWeight(text);

  // ---- 致命的（投稿不能）----
  if (text.replace(POST_PREFIX, "").trim().length === 0) {
    blocking.push("投稿本文が空です");
  }
  if (weight > MAX_TWEET_WEIGHT) {
    blocking.push(`文字数超過（${weight}/${MAX_TWEET_WEIGHT}）`);
  }
  if (URL_RE.test(text)) blocking.push("投稿文にURLが含まれています");
  if (text.includes("#")) blocking.push("投稿文にハッシュタグが含まれています");
  if (EMOJI_RE.test(text)) blocking.push("投稿文に絵文字が含まれています");

  // ---- 事実照合（1つでも当たれば承認待ちへ）----

  // 1. 発売日
  if (!ex.release_date) {
    warnings.push("発売日を特定できていません");
  } else {
    const variants = dateVariants(ex.release_date).map(normalize);
    if (!variants.some((v) => src.includes(v))) {
      warnings.push(
        `発売日 ${ex.release_date} が原文で確認できません（AIの推定の可能性）`
      );
    }
    if (ex.release_date < today) {
      warnings.push(
        `発売日 ${ex.release_date} が過去日です（本日 ${today}）`
      );
    }
  }

  // 2. 投稿文中の日付が原文にあるか
  const textDates = Array.from(
    new Set(normalize(text).match(/\d{1,2}月\d{1,2}日/g) || [])
  );
  for (const d of textDates) {
    const m = d.match(/(\d{1,2})月(\d{1,2})日/)!;
    const padded = `${m[1].padStart(2, "0")}月${m[2].padStart(2, "0")}日`;
    if (!src.includes(d) && !src.includes(padded)) {
      warnings.push(`投稿文の日付「${d}」が原文に見当たりません`);
    }
  }

  // 3. 投稿文中の価格が原文にあるか
  const textPrices = Array.from(
    new Set(normalize(text).match(/[\d,]+円/g) || [])
  );
  for (const p of textPrices) {
    const bare = p.replace(/,/g, "");
    if (!src.includes(p) && !src.includes(bare)) {
      warnings.push(`投稿文の価格「${p}」が原文に見当たりません`);
    }
  }

  // 4. 販売エリアの捏造
  if (text.includes("全国") && !src.includes("全国")) {
    warnings.push("「全国」という販売エリア表記が原文にありません");
  }

  // 5. 商品名・メーカー名
  if (!ex.product_name) {
    warnings.push("商品名を特定できていません");
  } else if (!src.includes(normalize(ex.product_name))) {
    warnings.push(`商品名「${ex.product_name}」が原文と一致しません`);
  }
  if (!ex.maker) {
    warnings.push("メーカー名を特定できていません");
  } else if (!src.includes(normalize(ex.maker))) {
    warnings.push(`メーカー名「${ex.maker}」が原文と一致しません`);
  }

  // 6. 商品名が投稿文に入っているか（入っていないと何の告知か伝わらない）
  if (ex.product_name && !normalize(text).includes(normalize(ex.product_name))) {
    warnings.push("投稿文に商品名が含まれていません");
  }

  return {
    autoPostable: blocking.length === 0 && warnings.length === 0,
    blocking,
    warnings,
    text,
    weight,
  };
}
