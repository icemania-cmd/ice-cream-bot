import { NextRequest, NextResponse } from "next/server";
import { scanAllCvs } from "@/lib/cvs-scraper";
import {
  isCvsProductKnown,
  isDuplicateWithPrTimes,
  saveCvsProduct,
  type CvsProductData,
} from "@/lib/store";

/**
 * CVSコンビニ商品スキャン API
 * 2時間おきに全コンビニサイトを巡回し、新商品をRedisに保存する
 */
export async function GET(request: NextRequest) {
  // Vercel Cronからの呼び出しを認証
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    console.log("🏪 CVSスキャンCron開始");

    // 全コンビニサイトをスキャン
    const products = await scanAllCvs();
    console.log(`スキャン結果: 全${products.length}件の商品を検出`);

    let newCount = 0;
    let duplicateCount = 0;
    let prTimesSkipCount = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        // 商品名が空・不正な場合はスキップ
        if (!product.name || product.name.length < 2) {
          console.log(`商品名不正スキップ: ${product.name}`);
          continue;
        }

        // 既知の商品かチェック
        const known = await isCvsProductKnown(product.productId);
        if (known) {
          duplicateCount++;
          continue;
        }

        // PR TIMESで既に投稿済みの商品かチェック（商品名の部分一致）
        const prTimesDup = await isDuplicateWithPrTimes(product.name);
        if (prTimesDup) {
          prTimesSkipCount++;
          console.log(`PR TIMES重複スキップ: ${product.name}`);
          continue;
        }

        // 新商品として保存
        const productData: CvsProductData = {
          store: product.store,
          name: product.name,
          maker: product.maker,
          price: product.price,
          releaseDate: product.releaseDate,
          region: product.region,
          description: product.description,
          imageUrl: product.imageUrl,
          productId: product.productId,
          detectedAt: new Date().toISOString(),
        };

        await saveCvsProduct(productData);
        newCount++;
        console.log(`✅ 新商品保存: ${product.store} - ${product.name}`);
      } catch (error) {
        const errMsg = `${product.store}/${product.name}: ${error instanceof Error ? error.message : "不明なエラー"}`;
        errors.push(errMsg);
        console.error(`商品処理エラー: ${errMsg}`);
      }
    }

    const summary = {
      message: `CVSスキャン完了`,
      total: products.length,
      new: newCount,
      duplicate: duplicateCount,
      prTimesSkip: prTimesSkipCount,
      errors: errors.length > 0 ? errors : undefined,
    };

    console.log(`📊 スキャン結果: 新規${newCount}件 / 既知${duplicateCount}件 / PR TIMES重複${prTimesSkipCount}件`);

    return NextResponse.json(summary);
  } catch (error) {
    console.error("CVSスキャンCronエラー:", error);
    return NextResponse.json(
      { error: "CVSスキャン実行中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
