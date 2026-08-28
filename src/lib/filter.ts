import type { Release } from "./prtimes";

/**
 * Claude を呼ぶ前の無料フィルタ。
 * PR TIMES 全社ファイアホースは1日1500〜2000件流れてくるので、
 * ここで99%以上を落とさないと API コストもタイムアウトも破綻する。
 */

/**
 * アイスと確定できる語。単独の「アイス」は入れない。
 * 「アイスコーヒー」「アイスティー」「アイスホッケー」を巻き込むため。
 */
const STRONG_ICE_TERMS = [
  "アイスクリーム",
  "アイスバー",
  "アイスキャンディ",
  "アイスキャンデー",
  "アイスモナカ",
  "アイス最中",
  "アイスミルク",
  "アイスケーキ",
  "アイスサンド",
  "ラクトアイス",
  "氷菓",
  "ジェラート",
  "ソフトクリーム",
  "シャーベット",
  "かき氷",
  "かきごおり",
  "フローズンヨーグルト",
  "アイスデザート",
  "アイススイーツ",
];

/**
 * 単独では弱いが、アイスらしい文脈語と同時に出れば候補にする語。
 */
const WEAK_ICE_TERMS = ["アイス", "氷", "フローズン", "冷菓", "ひんやり"];

/** 弱い語を後押しする文脈語（食品・冷凍・味まわり） */
const CONTEXT_TERMS = [
  "バニラ",
  "チョコ",
  "ミルク",
  "乳脂肪",
  "種類別",
  "カップ",
  "マルチパック",
  "冷凍",
  "冷凍食品",
  "スイーツ",
  "デザート",
  "乳製品",
  "アイスクリーム類",
  "フレーバー",
  "コンビニ",
  "税込",
  "希望小売価格",
];

/** これが当たったら問答無用で落とす（アイス違いの語） */
const EXCLUDE_TERMS = [
  "アイスコーヒー",
  "アイスティー",
  "アイスラテ",
  "アイスカフェ",
  "アイスドリンク",
  "アイスホッケー",
  "アイススケート",
  "アイスリンク",
  "アイスランド",
  "アイスショー",
  "アイスダンス",
  "ドライアイス",
  "アイスパック",
  "アイスノン",
  "アイシング",
  "アイスブレイク",
  "アイスバケツ",
  "アイスマスク",
  "アイスジェル",
  "保冷剤",
  "アイスウォーター",
  "アイスピック",
];

/** 新商品・発売の告知であることを示す語 */
const LAUNCH_TERMS = [
  "新発売",
  "新商品",
  "発売",
  "登場",
  "リニューアル",
  "新フレーバー",
  "新登場",
  "販売開始",
  "数量限定",
  "期間限定",
  "先行販売",
];

/** 明らかに新商品告知ではないものを落とす */
const NON_LAUNCH_TERMS = [
  "決算",
  "人事",
  "採用",
  "IR情報",
  "株主",
  "資本業務提携",
  "調査結果",
  "アンケート結果",
  "受賞",
  "認定を取得",
  "キャンペーン開催",
  "プレゼントキャンペーン",
  "イベント開催",
  "出展",
  "サステナビリティ",
];

export interface PrefilterResult {
  passed: boolean;
  /** どの語で通ったか／落ちたか。ログとチューニングのために必ず残す。 */
  reason: string;
  hits: string[];
}

function found(text: string, terms: string[]): string[] {
  return terms.filter((t) => text.includes(t));
}

/**
 * タイトル＋要約＋配信企業名を1本のテキストにして判定する。
 * 判定は「アイスであること」と「新商品告知であること」の2軸。
 */
export function prefilter(release: Release): PrefilterResult {
  const text = `${release.title}\n${release.summary}\n${release.corp}`;

  const excluded = found(text, EXCLUDE_TERMS);
  const strong = found(text, STRONG_ICE_TERMS);

  // 除外語しか無いのに強い語が無いなら落とす。
  // （「アイスクリームとアイスコーヒーのセット」のようなケースは残す）
  if (excluded.length > 0 && strong.length === 0) {
    return {
      passed: false,
      reason: `除外語のみ該当: ${excluded.join(", ")}`,
      hits: excluded,
    };
  }

  let iceHits = strong;
  if (iceHits.length === 0) {
    const weak = found(text, WEAK_ICE_TERMS);
    const ctx = found(text, CONTEXT_TERMS);
    // 弱い語は文脈語2つ以上とセットのときだけ通す
    if (weak.length > 0 && ctx.length >= 2) {
      iceHits = [...weak, ...ctx];
    } else {
      return { passed: false, reason: "アイス関連語なし", hits: [] };
    }
  }

  const launch = found(text, LAUNCH_TERMS);
  if (launch.length === 0) {
    return {
      passed: false,
      reason: "発売告知を示す語なし",
      hits: iceHits,
    };
  }

  const nonLaunch = found(text, NON_LAUNCH_TERMS);
  // 新商品語より非商品語のほうが強く出ているものは落とす
  if (nonLaunch.length > launch.length) {
    return {
      passed: false,
      reason: `商品告知以外の可能性: ${nonLaunch.join(", ")}`,
      hits: iceHits,
    };
  }

  return {
    passed: true,
    reason: `該当: ${[...iceHits, ...launch].slice(0, 6).join(", ")}`,
    hits: [...iceHits, ...launch],
  };
}
