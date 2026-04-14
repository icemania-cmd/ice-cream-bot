import { NextRequest, NextResponse } from "next/server";
import { scanAllCvs } from "@/lib/cvs-scraper";
import {
  isCvsProductKnown,
  isDuplicateWithPrTimes,
  findPrTimesImage,
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

    // 今日の日付（JST）を取得
    const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const todayStr = nowJst.toISOString().split("T")[0]; // YYYY-MM-DD

    let newCount = 0;
    let duplicateCount = 0;
    let prTimesSkipCount = 0;
    let dateSkipCount = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        // 商品名が空・不正な場合はスキップ
        if (!product.name || product.name.length < 2) {
          console.log(`商品名不正スキップ: ${product.name}`);
          continue;
        }

        // 発売日チェック：不明・空・パース不能はスキップ（正確な情報のみ発信）
        if (!product.releaseDate || product.releaseDate === "不明" || product.releaseDate.trim() === "") {
          dateSkipCount++;
          console.log(`発売日不明スキップ: ${product.name}`);
          continue;
        }

        // 発売日が今日より前（既発売）はスキップ
        const releaseDateMatch = product.releaseDate.match(/\d{4}-\d{2}-\d{2}/);
        if (!releaseDateMatch) {
          dateSkipCount++;
          console.log(`発売日フォーマット不正スキップ: ${product.name} (${product.releaseDate})`);
          continue;
        }
        if (releaseDateMatch[0] <= todayStr) {
          dateSkipCount++;
          console.log(`既発売スキップ: ${product.name} (発売日: ${releaseDateMatch[0]})`);
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

        // PRTimes投稿済み記事の画像があればCVSサイト画像より優先して使用
        const prTimesImage = await findPrTimesImage(product.name);
        if (prTimesImage) {
          console.log(`🖼️ PRTimes画像使用: ${product.name}`);
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
          imageUrl: prTimesImage || product.imageUrl,
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
      dateSkip: dateSkipCount,
      errors: errors.length > 0 ? errors : undefined,
    };

    console.log(`📊 スキャン結果: 新規${newCount}件 / 既知${duplicateCount}件 / PR TIMES重複${prTimesSkipCount}件 / 日付スキップ${dateSkipCount}件`);

    return NextResponse.json(summary);
  } catch (error) {
    console.error("CVSスキャンCronエラー:", error);
    return NextResponse.json(
      { error: "CVSスキャン実行中にエラーが発生しました" },
      { status: 500 }
    );
  }
}
