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

function getCredentials(): XCredentials {
  return {
    apiKey: process.env.X_API_KEY!,
    apiSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  };
}

function buildAuthHeader(
  method: string,
  url: string,
  credentials: XCredentials,
  extraParams?: Record<string, string>
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  // OAuth署名にはoauthパラメータ＋追加パラメータ（あれば）を含める
  const allParams = { ...oauthParams, ...extraParams };
  const signature = generateOAuthSignature(method, url, allParams, credentials);
  oauthParams["oauth_signature"] = signature;

  return (
    "OAuth " +
    Object.keys(oauthParams)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
      .join(", ")
  );
}

/**
 * 画像URLからダウンロードしてX Media Upload API (v1.1) でアップロード
 * media_id を返す
 */
export async function uploadImageToX(imageUrl: string): Promise<string | null> {
  const credentials = getCredentials();

  try {
    // 1. 画像をダウンロード
    console.log(`画像ダウンロード: ${imageUrl}`);
    const imgRes = await fetch(imageUrl, {
      headers: { "User-Agent": "IceCreamBot/1.0" },
    });
    if (!imgRes.ok) {
      console.error(`画像ダウンロード失敗: ${imgRes.status}`);
      return null;
    }

    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    // 5MB制限チェック
    if (imgBuffer.length > 5 * 1024 * 1024) {
      console.error(`画像サイズが5MBを超えています: ${imgBuffer.length} bytes`);
      return null;
    }

    console.log(`画像サイズ: ${imgBuffer.length} bytes, type: ${contentType}`);

    // 2. X Media Upload API (v1.1) にアップロード
    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
    const base64Data = imgBuffer.toString("base64");

    // multipart/form-data でアップロード
    const boundary = `----FormBoundary${crypto.randomBytes(8).toString("hex")}`;
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="media_data"\r\n\r\n`,
      `${base64Data}\r\n`,
      `--${boundary}--\r\n`,
    ];
    const body = bodyParts.join("");

    const authHeader = buildAuthHeader("POST", uploadUrl, credentials);

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const uploadData = await uploadRes.json();

    if (!uploadRes.ok) {
      console.error("画像アップロードエラー:", JSON.stringify(uploadData));
      return null;
    }

    const mediaId = uploadData.media_id_string;
    console.log(`画像アップロード成功: media_id=${mediaId}`);
    return mediaId;
  } catch (error) {
    console.error("画像アップロード通信エラー:", error);
    return null;
  }
}

/**
 * X API v2 でツイートを投稿（画像添付オプション対応）
 */
export async function postTweet(
  text: string,
  mediaIds?: string[]
): Promise<{
  success: boolean;
  tweetId?: string;
  error?: string;
}> {
  const credentials = getCredentials();
  const url = "https://api.twitter.com/2/tweets";
  const authHeader = buildAuthHeader("POST", url, credentials);

  // リクエストボディ（画像がある場合はmedia.media_idsを追加）
  const body: Record<string, unknown> = { text };
  if (mediaIds && mediaIds.length > 0) {
    body.media = { media_ids: mediaIds };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("X API エラー:", JSON.stringify(data));
      return {
        success: false,
        error: `${response.status} ${JSON.stringify(data)}`,
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
