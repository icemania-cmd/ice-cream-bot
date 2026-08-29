import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, POST_PREFIX } from "./config";
import type { Release } from "./prtimes";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface Extraction {
  is_ice_cream_new_product: boolean;
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
          "発売日を YYYY-MM-DD 形式で。年の記載がなければ配信日の年を使う。既に発売中、または記載がなければ空文字",
      },
      release_date_text: {
        type: "string",
        description:
          "発売日が原文でどう書かれていたか、そのままの表記（例: 9月1日、2026年9月1日（月））。無ければ空文字",
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

const CLOSINGS = [
  "楽しみ！",
  "気になる〜",
  "いよいよ！",
  "これは絶対買う",
  "見かけたら即買い",
  "推しの一本になりそう",
  "早速チェックします",
  "発売日にチェックを",
  "これは試したい",
  "情報入りました",
  "どんな味なんだろう",
  "好きなやつです",
  "たまりませんね",
  "買うしかない",
  "コンビニ寄らなきゃ",
  "気になりすぎる",
  "これは期待大",
  "ぜひチェックを",
  "発売が待ち遠しい",
  "要チェックです",
  "見逃せない",
  "これは嬉しい",
  "まずは一本試してみます",
  "ファンには堪らないですね",
  "外せない一本",
  "ひそかに待ってたやつ",
];

function buildPrompt(release: Release, bodyText: string): string {
  // 締めの言葉は毎回コード側でシャッフルして渡す。
  // プロンプトに固定リストを埋めると Claude が上から選びがちで表現が偏るため。
  const shuffled = [...CLOSINGS].sort(() => Math.random() - 0.5).slice(0, 8);

  return `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。
PR TIMES のプレスリリースを読み、(1) それがアイスの新商品発売告知かを判定し、(2) 該当する場合は自分の X アカウントに投稿する本文を作成します。

【判定の基準】
- 対象: アイスクリーム、アイスミルク、ラクトアイス、氷菓、ジェラート、ソフトクリーム、シャーベット、かき氷などの冷菓の「新商品」または「リニューアル品」の発売告知
- 対象外: アイスコーヒーなどの飲料、常温の菓子、既に発売中の商品の紹介のみ、キャンペーン／イベント／コラボ企画の告知のみ、店舗オープン、決算・人事・採用・調査リリース
- 迷ったら false にしてください。誤って投稿するより、拾い損ねるほうがましです。

【投稿文のルール】（絶対厳守）
- 冒頭は必ず「${POST_PREFIX}」で始める
- 記載された事実だけを書く。プレスリリースに書かれていない発売日・価格・販売エリア・味の説明を、推測で補ってはいけない
- 日付・価格は原文の表記をそのまま使う。年は省略し「9月1日発売」の形。ゼロ埋めしない（09月01日→9月1日）
- 販売エリアは原文に明記がある場合のみ書く。「全国」と書かれていないなら「全国」と書かない
- URL は入れない。ハッシュタグは付けない。絵文字は使わない
- 全角2文字・半角1文字換算で 280 以内に必ず収める
- ですます調をベースに、体言止めやカジュアルなひと言を自然に混ぜる。毎回同じ構成にしない
- 末尾のひと言は次のいずれかから1つ選び、前後と自然につなげる: ${shuffled.join(" / ")}

【参考にする文体】
${POST_PREFIX}ロッテから「爽 ブルーベリーヨーグルト味」が4月13日から全国発売です。2色巻き仕様でブルーベリーとプレーンヨーグルトの組み合わせ。194円（税込）。これは楽しみ！

${POST_PREFIX}森永乳業の「PARM 白桃＆アールグレイ」が4月20日より期間限定で登場。アールグレイミルクティーアイスをホワイトチョコでコーティングし、中に白桃ソース。どんな味なんだろう、気になる〜。

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
  bodyText: string
): Promise<Extraction> {
  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1200,
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report" },
    messages: [{ role: "user", content: buildPrompt(release, bodyText) }],
  });

  const toolUse = message.content.find(
    (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
  );
  if (!toolUse) {
    throw new Error("Claude が report ツールを返しませんでした");
  }

  const raw = toolUse.input as Partial<Extraction>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  return {
    is_ice_cream_new_product: raw.is_ice_cream_new_product === true,
    reason: str(raw.reason),
    product_name: str(raw.product_name),
    maker: str(raw.maker),
    price: str(raw.price),
    release_date: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.release_date))
      ? str(raw.release_date)
      : "",
    release_date_text: str(raw.release_date_text),
    region: str(raw.region),
    post_text: str(raw.post_text),
  };
}
