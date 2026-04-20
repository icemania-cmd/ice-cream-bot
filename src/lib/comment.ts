import Anthropic from "@anthropic-ai/sdk";
import type { PressRelease } from "./rss";
import type { CvsProductData } from "./store";
import type { ReminderType } from "./store";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// 投稿末尾のひと言バリエーション（30種超）
// プロンプトに埋め込み、Claude がランダムに1つ選ぶよう指示する
const CLOSING_REMARKS = `
- 楽しみ！
- 気になる〜
- いよいよ！
- これは絶対買う
- 見かけたら即買い
- 推しの一本になりそう
- 早速チェックします
- 発売日にチェックを
- これは試したい
- 情報入りました
- どんな味なんだろう
- 好きなやつです
- たまりませんね
- 買うしかない
- コンビニ寄らなきゃ
- チェック推奨
- 気になりすぎる
- これは期待大
- いいですね
- ぜひチェックを
- 発売が待ち遠しい
- 要チェックです
- 見逃せない
- これは嬉しい
- さすがですね
- ちょっと待って、これすごくない？
- 個人的に好きなシリーズ
- まずは一本試してみます
- これはうれしい新フレーバー
- ファンには堪らないですね
- 毎年この季節が来ると思い出す一本
- 外せない一本
- ひそかに待ってたやつ
`;

/**
 * プレスリリースからX投稿文を生成する（新商品告知）
 */
export async function generatePost(pr: PressRelease): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。自分のXアカウントで投稿する文章を作成してください。

【最重要ルール】
このプレスリリースが「新商品の発売告知」でない場合（例：キャンペーン情報、イベント開催告知、企業・決算・採用情報、アイスクリーム以外の商品など）は、本文の代わりに「SKIP」とだけ出力してください。それ以外の文字は一切出力しないでください。

【文体・トーンの指示】（新商品の場合のみ）
- 冒頭は必ず「【新商品】」から始める
- ですます調をベースにしつつ、体言止めやカジュアルなひと言コメントを自然に盛り込む
- 末尾のひと言は以下のリストからランダムに1つだけ選んでください。前後の文章と自然につながるよう調整してOKです。同じ表現が続かないようにしてください：
${CLOSING_REMARKS}
- 毎回同じ構成にしない。短文のときも、少し詳しく書くときもある

【内容のルール】
- メーカー名・商品名・発売日・価格などの具体情報は正確に記載する（プレスリリースにある情報のみ）
- 情報の羅列にならないこと。アイスマン福留らしい視点や感情を乗せる
- プレスリリースに記載がない情報は絶対に捏造しない
- URLは絶対に含めない
- ハッシュタグ不要
- 絵文字は使わない
- 全体で280文字（半角換算）以内

【参考例（雰囲気の参考として）】
【新商品】ロッテから「爽 ブルーベリーヨーグルト味」が4月13日（月）から全国発売です。2色巻き仕様でブルーベリーとプレーンヨーグルトの組み合わせ。194円（税込）。これは楽しみ！

【新商品】森永乳業から「PARM 白桃＆アールグレイ」が4月20日（月）から全国で期間限定発売。アールグレイミルクティーアイスをホワイトチョコでコーティングして中に白桃ソース。180円（税別）。どんな味なんだろう、気になる〜。

【プレスリリース】
タイトル: ${pr.title}
内容: ${pr.description}

投稿文のみを出力してください。余計な説明や前置きは不要です。`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}

/**
 * プレスリリースから発売日を抽出する（YYYY-MM-DD形式）
 */
export async function extractReleaseDate(pr: PressRelease): Promise<string | null> {
  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: `以下のプレスリリースから商品の「発売日」を抽出してください。

【ルール】
- YYYY-MM-DD 形式で出力（例: 2026-04-13）
- 発売日が明確に記載されている場合のみ出力
- 「発売中」「好評発売中」など既に発売済みの場合は「NONE」と出力
- 発売日が不明な場合は「NONE」と出力
- 日付のみを出力。余計な文字は不要

タイトル: ${pr.title}
内容: ${pr.description}`,
        },
      ],
    });

    const result = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(result)) return result;
    return null;
  } catch (error) {
    console.error("発売日抽出エラー:", error);
    return null;
  }
}

/**
 * リマインド投稿文を生成する
 * reminderType に応じてトーンを変える
 */
export async function generateReminderPost(
  pr: PressRelease,
  reminderType: ReminderType = "day_before"
): Promise<string> {
  const isWeekBefore = reminderType === "week_before";
  const isThreeDays = reminderType === "three_days_before";
  const isDayBefore = reminderType === "day_before";

  const timing = isWeekBefore
    ? "1週間後"
    : isThreeDays
    ? "3日後"
    : "明日";

  const urgency = isDayBefore
    ? "明日発売です！忘れずに。"
    : isThreeDays
    ? "発売まであと3日です。"
    : "発売まであと1週間です。";

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。以下の商品が「${timing}発売」であることをXで投稿してください。

【文体・トーンの指示】
- 冒頭は必ず「【リマインド】」から始める
- ですます調をベースに、体言止めやカジュアルなひと言を自然に混ぜる
- ${urgency}というニュアンスを自然に盛り込む
- 末尾のひと言は以下のリストからランダムに1つだけ選んでください。前後の文章と自然につながるよう調整してOKです：
${CLOSING_REMARKS}
- 毎回同じ構成にしない

【内容のルール】
- 商品名・メーカー名・発売日・販売エリア・価格などはプレスリリースにある範囲で正確に
- 数量限定の場合はさりげなく強調する
- プレスリリースに記載がない情報は絶対に捏造しない
- URLは絶対に含めない
- ハッシュタグ不要
- 絵文字は使わない
- 全体で280文字（半角換算）以内

【参考例（雰囲気の参考として）】
【リマインド】森永乳業「ピノ ストロベリーチーズケーキ」がいよいよ明日発売です。全国のコンビニで数量限定。買えるうちに手に入れてください。楽しみ！

【リマインド】赤城乳業「トッピンぎゅ～！」明日全国発売です。カラースプレー・チョコソース・ホイップ全部乗せの鬼トッピング仕様。数量限定なのでお早めに。見かけたら即買い推奨です。

【プレスリリース】
タイトル: ${pr.title}
内容: ${pr.description}

投稿文のみを出力してください。余計な説明や前置きは不要です。`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}

/**
 * 発売当日の投稿文を生成する（【本日発売！】）
 */
export async function generateReleaseDayPost(pr: PressRelease): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。以下の商品が「本日発売」であることをXで投稿してください。

【文体・トーンの指示】
- 冒頭は必ず「【本日発売！】」から始める
- ですます調をベースに、発売当日の高揚感を自然に表現する
- 「ついに発売！」「今日から買えます」「売り場でお見かけしたら」などのフレーズを自然に使う
- 末尾のひと言は以下のリストからランダムに1つだけ選んでください：
${CLOSING_REMARKS}
- 毎回同じ構成にしない

【内容のルール】
- 商品名・メーカー名・販売エリア・価格などはプレスリリースにある範囲で正確に
- プレスリリースに記載がない情報は絶対に捏造しない
- URLは絶対に含めない
- ハッシュタグ不要
- 絵文字は使わない
- 全体で280文字（半角換算）以内

【プレスリリース】
タイトル: ${pr.title}
内容: ${pr.description}

投稿文のみを出力してください。余計な説明や前置きは不要です。`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}

/**
 * CVSコンビニ商品の投稿文を生成する
 */
const CVS_STORE_NAMES = ["ファミリーマート", "セブン-イレブン", "ローソン", "ミニストップ"];

export async function generateCvsPost(product: CvsProductData): Promise<string> {
  const isCvs = CVS_STORE_NAMES.includes(product.store);
  const prefix = isCvs ? "【コンビニ】" : "【新商品】";
  const storeLabel = isCvs ? `コンビニ名（${product.store}）は必ず記載` : `メーカー名（${product.store}）は必ず記載`;
  const exampleStore = isCvs
    ? `【コンビニ】ファミリーマートから「たべる牧場ミルク バニラ＆いちご」が4月15日発売。190円（税込）。バニラといちごの2層仕立て。これは気になる〜。

【コンビニ】セブン-イレブンで「まるでマンゴーを冷凍したような食感のアイスバー」が4月22日から発売。108円。全国販売です。見かけたら即買い推奨。`
    : `【新商品】竹下製菓から「ブラックモンブラン〇〇」が5月1日全国発売。162円（税込）。これは楽しみ！

【新商品】竹下製菓「ミルクック〇〇」が4月20日より発売。夏に向けた新フレーバー。気になる〜。`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `あなたはアイスクリーム評論家「アイスマン福留」（@icemania）です。${isCvs ? "コンビニの新商品情報" : "アイスメーカーの新商品情報"}をXで投稿する文章を作成してください。

【最重要ルール】
- 投稿文のみを出力すること。余計な説明・前置き・コードブロックは不要
- エラーメッセージや技術的な文言は絶対に含めない
- 商品情報が不完全・不自然な場合は「SKIP」とだけ出力する
- アイスクリーム・アイス・ジェラート・ソフトクリーム${product.store === "ミニストップ" ? "・ハロハロ・パフェなどのコールドスイーツ" : ""}以外の商品の場合は「SKIP」とだけ出力する

【文体・トーンの指示】
- 冒頭は必ず「${prefix}」から始める
- ですます調をベースにしつつ、体言止めやカジュアルなひと言を自然に混ぜる
- 末尾のひと言は以下のリストからランダムに1つだけ選んでください。同じ表現が続かないようにしてください：
${CLOSING_REMARKS}
- 毎回同じ構成にしない。短文のときも、少し詳しく書くときもある

【内容のルール - 正確性最優先】
- ${storeLabel}
- 商品名は正確に記載
- 発売日は必ず含める（最重要情報）。表記ルール：年は省略し「4月8日発売」のように書く。ゼロ埋めしない（04月→4月、08日→8日）
- 価格・メーカー名があれば含める。不明なら省略（推測しない）
- 販売エリアが「全国」以外なら記載する。不明なら省略
- 提供された情報にないことは絶対に書かない
- URLは絶対に含めない
- ハッシュタグ不要
- 絵文字は使わない
- 全体で280文字（半角換算）以内

【参考例（雰囲気の参考として）】
${exampleStore}

【商品情報】
${isCvs ? "コンビニ" : "メーカー"}: ${product.store}
商品名: ${product.name}
メーカー: ${product.maker || "不明"}
価格: ${product.price || "不明"}
発売日: ${product.releaseDate || "不明"}
販売エリア: ${product.region || "全国"}
商品説明: ${product.description || "なし"}

投稿文のみを出力してください。`,
      },
    ],
  });

  const postText = message.content[0].type === "text" ? message.content[0].text : "";
  return postText.trim();
}
