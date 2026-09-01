/*
 * Web Push 用の VAPID 鍵を作る。
 *
 *   node scripts/gen-vapid.mjs
 *
 * 依存パッケージを入れる前でも動くよう、Node 標準の crypto だけで作る。
 * 出力した3つを Vercel の環境変数（Production / Preview / Development）に
 * 登録する。Sensitive は付けないこと（あとで読めなくなる）。
 *
 * 公開鍵はブラウザに配るものなので秘密ではない。
 * 秘密鍵は誰にも渡さないこと。チャットに貼るのもやめること。
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

const pub = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("base64url");

console.log("");
console.log("Vercel の環境変数に、この3つを登録してください（Sensitive は付けない）");
console.log("--------------------------------------------------------------");
console.log("VAPID_PUBLIC_KEY  =", pub);
console.log("VAPID_PRIVATE_KEY =", jwk.d);
console.log("VAPID_SUBJECT     = mailto:あなたのメールアドレス");
console.log("--------------------------------------------------------------");
console.log("");
