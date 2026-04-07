import Anthropic from "@anthropic-ai/sdk";
import type { PressRelease } from "./rss";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

/**
 * プレスリリースの内容からX投稿文を生成する
 * フォーマット: タイトル要約 + 概要 + 一言コメント（URL無し）
 * 140文字（全角）以内に収める
 */
export async function generatePost(pr: PressRelease): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `あなたはアイスクリーム情報を発信するXアカウントの中の人です。
以下のプレスリリースをもとに、X（旧Twitter）投稿文を作成してください。

【ルール】
- 1行目: プレスリリースのタイトルを短く要約（30文字以内）
- 2行目: 概要を1〜2文で簡潔にまとめる
- 3行目: アイスクリーム好きの視点から一言コメント（カジュアルなトーン）
- URLは絶対に含めない
- ハッシュタグは最大2つまで（#アイス #新商品 など）
- 全体で280文字（半角換算）以内に収める
- 絵文字は🍦のみ適度に使用可

【プレスリリース】
タイトル: ${pr.title}
内容: ${pr.description}

投稿文のみを出力してください。余計な説明は不要です。`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  return text.trim();
}
