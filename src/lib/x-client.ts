import crypto from "crypto";

/**
 * X API v2 で投稿する（OAuth 1.0a 署名を自前実装）
 * 外部ライブラリ不要でコストゼロ
 */

interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  credentials: XCredentials
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");

  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join("&");

  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(
    credentials.accessTokenSecret
  )}`;

  return crypto
    .createHmac("sha1", signingKey)
    .update(signatureBase)
    .digest("base64");
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function postTweet(text: string): Promise<{
  success: boolean;
  tweetId?: string;
  error?: string;
}> {
  const credentials: XCredentials = {
    apiKey: process.env.X_API_KEY!,
    apiSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  };

  const url = "https://api.twitter.com/2/tweets";
  const method = "POST";

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const signature = generateOAuthSignature(method, url, oauthParams, credentials);
  oauthParams["oauth_signature"] = signature;

  const authHeader =
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
      .join(", ");

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("X API エラー:", JSON.stringify(data));
      return {
        success: false,
        error: data.detail || data.title || "投稿に失敗しました",
      };
    }

    return {
      success: true,
      tweetId: data.data?.id,
    };
  } catch (error) {
    console.error("X API 通信エラー:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "通信エラー",
    };
  }
}
