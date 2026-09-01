import Anthropic from "@anthropic-ai/sdk";
import {
  CLAUDE_MODEL,
  MAX_TWEET_WEIGHT,
  POST_PREFIX,
  TARGET_TWEET_WEIGHT,
  tweetWeight,
} from "./config";
import type { Release } from "./prtimes";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

/**
 * 記事の種類。
 * 「発売告知かどうか」の1本だけで切ると、出店・イベント・コラボの告知が
 * すべて捨てられる。話題性のあるものは拾って人に見せたいので、
 * 何の記事なのかを分けて持つ。
 */
export type TopicType =
  | "new_product"
  | "store"
  | "event"
  | "collab"
  | "other_ice"
  | "not_ice";

export interface Extraction {
  is_ice_cream_new_product: boolean;
  topic_type: TopicType;
  reason: string;
  product_name: string;
  maker: string;
  price: string;
  release_date: string;
  release_date_text: string;
  region: string;
  post_text: string;
}

/**
 * 出力形式を tool_choice で固定する。
 * 旧実装は自由文を正規表現で拾っていたため、Claude が前置きを付けた瞬間に壊れていた。
 * ツール呼び出しにすれば JSON パース失敗というバグ種別ごと無くせる。
 */
const REPORT_TOOL: Anthropic.Tool = {
  name: "report",
  description: "プレスリリースの判定結果と投稿文を報告する",
  input_schema: {
    type: "object",
    properties: {
      is_ice_cream_new_product: {
        type: "boolean",
        description:
          "アイスクリーム・氷菓・ジェラート・ソフトクリームなど冷菓の『新商品の発売告知』であれば true。キャンペーン、イベント、コラボ企画のみ、決算、採用、既発売品の紹介、飲料や菓子など冷菓以外は false。",
      },
      topic_type: {
        type: "string",
        enum: [
          "new_product",
          "store",
          "event",
          "collab",
          "other_ice",
          "not_ice",
        ],
        description:
          "記事の種類。new_product=冷菓の発売告知（新商品・復活・再販・リニューアル・定番昇格）。store=アイス／ソフトクリーム／ジェラート等の店の出店・オープン・期間限定出店・ポップアップ。event=アイスに関わるイベント・フェア・催事・出展。collab=冷菓のコラボ・タイアップの告知で発売告知の形になっていないもの。other_ice=それ以外でアイスに関係する話題（調査結果・受賞・応募キャンペーンなど）。not_ice=アイスと関係ない。",
      },
      reason: { type: "string", description: "その判定にした理由を一文で" },
      product_name: {
        type: "string",
        description:
          "商品名。原文の表記をそのまま。ただし商品名を囲む『』「」は含めない（例: 『黒ごま＆きなこ』→ 黒ごま＆きなこ）。不明なら空文字",
      },
      maker: {
        type: "string",
        description: "メーカー名・企業名。原文の表記をそのまま。不明なら空文字",
      },
      price: {
        type: "string",
        description:
          "価格。原文の表記のまま（例: 194円、税込248円）。記載がなければ空文字。絶対に推測しない",
      },
      release_date: {
        type: "string",
        description:
          "その商品の発売日を YYYY-MM-DD 形式で。キャンペーン期間の終了日・予約開始日・イベント開催日と混同しないこと。年の記載がなければ配信日の年を使う。既に発売中、または記載がなければ空文字",
      },
      release_date_text: {
        type: "string",
        description:
          "その発売日が原文でどう書かれていたか、原文からそのまま写した表記（例: 9月1日、2026年9月1日（月））。原文に存在しない書き方をしないこと。無ければ空文字",
      },
      region: {
        type: "string",
        description:
          "販売エリア。原文に明記があるときだけ（例: 全国、関東地方の一部）。記載がなければ空文字",
      },
      post_text: {
        type: "string",
        description:
          "X に投稿する本文。is_ice_cream_new_product が false のときは空文字",
      },
    },
    required: [
      "is_ice_cream_new_product",
      "topic_type",
      "reason",
      "product_name",
      "maker",
      "price",
      "release_date",
      "release_date_text",
      "region",
      "post_text",
    ],
  },
};

/**
 * 締めのひと言。
 * アイスマン福留の実際の投稿は「その商品を好きな層への呼びかけ」で終わることが多い。
 *   例: パルム好きはお見逃しなく / ラムレーズン好きはブックマークを!! / 和スイーツ好きは要チェック
 * 固定文の羅列ではなく型として渡し、商品に合わせて埋めさせる。
 */
const CLOSING_PATTERNS = [
  "「〇〇好きは要チェック」（〇〇に商品の特徴やジャンルを入れる）",
  "「〇〇好きはお見逃しなく」",
  "「〇〇好きはブックマークを!!」",
  "「見かけたら即買い推奨」",
  "「発売日にチェックを」",
  "「これは楽しみ」",
  "「気になりすぎる」",
  "「個人的にかなり期待」",
  "「これは試したい」",
  "「絶対に押さえておきたい一本」",
];

function buildPrompt(
  release: Release,
  bodyText: string,
  styleSamples: string[]
): string {
  // 締めの型は毎回シャッフルして渡す。固定順で渡すと上から選びがちで表現が偏る。
  const closings = [...CLOSING_PATTERNS]
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  // 実際に投稿した文があればそれを見本にする。
  // 承認前に手を入れた文は、本人の感覚そのものなので固定の見本より近い。
  // 無い間は、過去の実投稿から作った固定の見本を使う。
  const samples =
    styleSamples.length > 0
      ? `【文体の見本】（あなたが実際に投稿した直近の文。この温度感と情報の並べ方に寄せる）\n` +
        styleSamples.map((t) => t.trim()).join("\n\n")
      : `【文体の見本】（この温度感と情報の並べ方に寄せる）
${POST_PREFIX}ホワイトチョコ版が2年ぶりに帰ってきた!! 森永製菓『白い板チョコアイス』が9/21(月)より全国発売。今年からは期間限定ではなく秋冬の定番に昇格。ザクザクのクッキークランチ入りホワイトチョコに、なめらかバニラ。価格：216円（税込）

${POST_PREFIX}PARMから期間限定の新作。森永乳業『PARM キャラメルヴァニーユ』が9/7(月)発売。キャラメルバニラアイスをホワイトチョコでコーティング、中には岩塩を効かせた濃厚キャラメルソース。価格：190円（税別）。パルム好きはお見逃しなく

${POST_PREFIX}赤城乳業『ミルクレア』にポケモンパッケージが登場。濃厚生キャラメル → 8/31(月)発売、ベルギーチョコレートは8月下旬より順次。10周年×ポケモン30周年の数量限定デザイン。価格：486円（税込）、販売エリア＝全国`;

  return `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。
PR TIMES のプレスリリースを読み、(1) それがアイスの発売告知かを判定し、(2) 該当する場合はご自身の X アカウントに投稿する本文を作成します。

【判定の基準】
- 対象: アイスクリーム、アイスミルク、ラクトアイス、氷菓、ジェラート、ソフトクリーム、シャーベット、かき氷などの冷菓の発売告知。新商品のほか、復活・再販・リニューアル・定番昇格も対象に含める
- 対象外: アイスコーヒーなどの飲料、常温の菓子、既に発売中の商品の紹介のみ、決算・人事・採用・調査リリース
- 迷ったら false にしてください。誤って投稿するより、拾い損ねるほうがましです。

【記事の種類】topic_type から必ず1つ選ぶ（is_ice_cream_new_product とは別に判断する）
- new_product … 冷菓の発売告知。is_ice_cream_new_product が true になるのはこれだけ
- store … アイス／ソフトクリーム／ジェラート等の店の出店・オープン・期間限定出店・ポップアップ
- event … アイスに関わるイベント・フェア・催事・出展
- collab … 冷菓のコラボ・タイアップの告知で、発売告知の形になっていないもの
- other_ice … それ以外でアイスに関係する話題（調査結果・受賞・応募キャンペーンなど）
- not_ice … アイスと関係ない

store / event / collab は投稿文を作りません（post_text は空文字）。
本人が見て判断するので、種類の判定だけ正確に行ってください。

【投稿文の型】
1行目: ${POST_PREFIX} に続けて、短いフックを一文。「何が起きたのか」を一息で言い切る
本文: メーカー名と商品名、発売日、販売形態。続けて味・食感・構成を1〜2文で具体的に
末尾: 「価格：」「販売エリア＝」のラベルと、読者への呼びかけ

【表記のルール】（この形を必ず守る）
- 冒頭は必ず「${POST_PREFIX}」で始める
- 日付は「9/21(月)」のようにスラッシュ表記。曜日は原文に書かれている場合のみ括弧で付ける。書かれていなければ「9/21」だけにする
- 価格は「価格：216円（税込）」の形。税込・税別は原文どおりに書く
- 販売エリアは原文に明記がある場合のみ「販売エリア＝全国」の形で書く
- 特定の店舗限定なら「セブン‐イレブン限定」のように明記する
- 「!!」は使ってよい。「→」「・」も可
- 商品名は product_name に入れたものと同じ表記を投稿文にも使う（言い換え・省略・別名の合成をしない）
- URL は入れない。ハッシュタグは付けない。絵文字は使わない
- 長さは全角2文字・半角1文字換算で ${TARGET_TWEET_WEIGHT} 以内。日本語なら概ね110文字。超えると投稿できないので、味の説明を削ってでも収めること

【内容のルール】
- プレスリリースに書かれた事実だけを書く。発売日・価格・販売エリア・味の説明を推測で補ってはいけない
- 情報の羅列にせず、アイスマン福留の視点を一言添える。ただし今回は簡潔さを優先する
- 末尾の呼びかけは次のいずれかの型から選び、商品に合わせて埋める: ${closings.join(" / ")}

${samples}

【プレスリリース】
配信企業: ${release.corp}
配信日時: ${release.publishedAt}
タイトル: ${release.title}

--- 本文ここから ---
${bodyText || release.summary}
--- 本文ここまで ---

report ツールを使って結果を報告してください。`;
}

/**
 * 1記事あたり Claude 呼び出しは1回だけ。
 * 旧実装は「発売日抽出」と「投稿文生成」で2回叩いており、
 * 片方だけ成功して状態が食い違う不整合の原因になっていた。
 */
export async function classifyAndCompose(
  release: Release,
  bodyText: string,
  /**
   * 文体の見本。呼び出し側が1回だけ取って全件に使い回す。
   * ここで毎回取ると、記事1件ごとに Redis を叩くことになる。
   */
  styleSamples: string[] = []
): Promise<Extraction> {
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1200,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report" },
    messages: [
      { role: "user", content: buildPrompt(release, bodyText, styleSamples) },
    ],
  });

  const toolUse = message.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude が report ツールを返しませんでした");
  }

  const raw = toolUse.input as Partial<Extraction>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  let postText = str(raw.post_text);

  // 長さ超過は「投稿不可」になってしまい、内容が正しくても世に出ない。
  // 指示だけでは守りきれないので、上限を下回るまで短縮を繰り返す。
  // 1回だけだと「短くはなったがまだ超過」で終わることがある（実測289字）。
  if (raw.is_ice_cream_new_product === true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tweetWeight(postText) <= MAX_TWEET_WEIGHT) break;
      const shorter = await shorten(postText, attempt);
      if (shorter === postText) break; // これ以上縮まらない
      postText = shorter;
    }
  }

  const TOPICS: TopicType[] = [
    "new_product",
    "store",
    "event",
    "collab",
    "other_ice",
    "not_ice",
  ];
  const topic = TOPICS.includes(raw.topic_type as TopicType)
    ? (raw.topic_type as TopicType)
    // 未知の値が来たら、発売告知かどうかだけで機械的に決める。
    // ここで例外を投げると1件の判定不能で記事を落とすことになる。
    : raw.is_ice_cream_new_product === true
      ? "new_product"
      : "other_ice";

  return {
    is_ice_cream_new_product: raw.is_ice_cream_new_product === true,
    topic_type: topic,
    reason: str(raw.reason),
    product_name: str(raw.product_name),
    maker: str(raw.maker),
    price: str(raw.price),
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.release_date))
      ? str(raw.release_date)
      : "",
    release_date_text: str(raw.release_date_text),
    region: str(raw.region),
    post_text: postText,
  };
}

/**
 * 長すぎる投稿文を1度だけ短縮させる。
 * 事実を落とすのではなく、味の描写や修飾を削らせる。
 */
async function shorten(text: string, attempt = 0): Promise<string> {
  // 回を追うごとに目標を厳しくする。1回目で足りなければもっと削る必要がある。
  const goal = Math.max(160, TARGET_TWEET_WEIGHT - attempt * 30);
  try {
    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `次のX投稿文が長すぎます。全角2文字・半角1文字換算で ${goal} 以内に必ず収めてください。現在は ${tweetWeight(text)} です。

【削ってよいもの】味や食感の描写、修飾語、冒頭のフック、二文目以降の補足
【絶対に残すもの】冒頭の「${POST_PREFIX}」、メーカー名、商品名、発売日、価格、末尾のひと言
【禁止】書かれていない情報を足すこと、URL、ハッシュタグ、絵文字

短縮した投稿文だけを出力してください。前置きや説明は不要です。

${text}`,
        },
      ],
    });
    const out =
      message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
    // 短縮に失敗した（かえって長い・空）なら元のまま返し、照合側で弾かせる
    if (!out || tweetWeight(out) >= tweetWeight(text)) return text;
    return out;
  } catch {
    return text;
  }
}
