import { redis } from "./store";

/**
 * 承認制ワークフロー用の下書きキュー管理
 *
 * cron は X に直接投稿せず、下書きを Redis に保存する。
 * /admin で内容を確認・編集し、承認した瞬間に X へ投稿される。
 */

const DRAFT_PREFIX = "draft:";
const REJECTED_PREFIX = "draft_rejected:";
const DRAFT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14日で自動失効
const REJECTED_TTL_SECONDS = 60 * 60 * 24 * 30; // 却下記録は30日保持

export type DraftPostType = "new_product" | "day_before_reminder" | "release_day";

export interface DraftData {
  guid: string;
  title: string;
  /** ソース本文（RSS要約）。管理画面での照合用 */
  sourceText: string;
  link: string;
  imageUrl?: string;
  releaseDate: string | null;
  postType: DraftPostType;
  /** 生成された投稿文 */
  text: string;
  /** 事実チェックで検出した警告（空なら問題なし） */
  warnings: string[];
  createdAt: string; // ISO
}

export async function saveDraft(draft: DraftData): Promise<void> {
  await redis.set(`${DRAFT_PREFIX}${draft.guid}`, JSON.stringify(draft), {
    ex: DRAFT_TTL_SECONDS,
  });
  console.log(`📝 下書き保存: [${draft.postType}] ${draft.title}`);
}

export async function getDraft(guid: string): Promise<DraftData | null> {
  const raw = await redis.get(`${DRAFT_PREFIX}${guid}`);
  if (!raw) return null;
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as DraftData;
  } catch {
    return null;
  }
}

export async function deleteDraft(guid: string): Promise<void> {
  await redis.del(`${DRAFT_PREFIX}${guid}`);
}

/** 下書きが既に存在するか（cron の重複生成防止用） */
export async function hasDraft(guid: string): Promise<boolean> {
  return (await redis.exists(`${DRAFT_PREFIX}${guid}`)) === 1;
}

/** 却下済みか（cron が再生成しないように） */
export async function isRejected(guid: string): Promise<boolean> {
  return (await redis.exists(`${REJECTED_PREFIX}${guid}`)) === 1;
}

export async function markRejected(guid: string): Promise<void> {
  await redis.set(`${REJECTED_PREFIX}${guid}`, "1", { ex: REJECTED_TTL_SECONDS });
  await deleteDraft(guid);
}

/** 承認待ちの下書きを新しい順に取得する */
export async function listDrafts(): Promise<DraftData[]> {
  const keys = await redis.keys(`${DRAFT_PREFIX}*`);
  const drafts: DraftData[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      drafts.push((typeof raw === "string" ? JSON.parse(raw) : raw) as DraftData);
    } catch {
      console.error(`下書きデータ解析エラー: ${key}`);
    }
  }
  return drafts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ===== 事実チェック =====

/** "2026-05-02" → ソース内で使われうる日付表記のバリエーション */
function dateVariants(isoDate: string): string[] {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const [, , mm, dd] = m;
  const month = String(parseInt(mm, 10));
  const day = String(parseInt(dd, 10));
  return [
    `${month}月${day}日`,
    `${mm}月${dd}日`,
    `${month}/${day}`,
    `${mm}/${dd}`,
  ];
}

/**
 * 生成された投稿文をソース本文と照合し、警告リストを返す。
 * 警告があっても下書きは作成される（管理画面で目立たせて人間が判断する）。
 */
export function factCheckDraft(params: {
  text: string;
  sourceText: string;
  releaseDate: string | null;
}): string[] {
  const warnings: string[] = [];
  const source = params.sourceText;

  // 1. 抽出された発売日がソース本文で確認できるか
  if (params.releaseDate) {
    const found = dateVariants(params.releaseDate).some((v) => source.includes(v));
    if (!found) {
      warnings.push(
        `抽出された発売日 ${params.releaseDate} がソース本文で確認できません（AIの推定の可能性）`
      );
    }
  } else {
    warnings.push("発売日を抽出できていません");
  }

  // 2. 投稿文中の日付表記がソースに存在するか
  const textDates = params.text.match(/\d{1,2}月\d{1,2}日/g) || [];
  for (const d of Array.from(new Set(textDates))) {
    const dm = d.match(/(\d{1,2})月(\d{1,2})日/);
    if (!dm) continue;
    const padded = `${dm[1].padStart(2, "0")}月${dm[2].padStart(2, "0")}日`;
    if (!source.includes(d) && !source.includes(padded)) {
      warnings.push(`投稿文中の日付「${d}」がソース本文に見当たりません`);
    }
  }

  // 3. 投稿文中の価格がソースに存在するか
  const textPrices = params.text.match(/[\d,]+円/g) || [];
  for (const p of Array.from(new Set(textPrices))) {
    const bare = p.replace(/,/g, "");
    if (!source.includes(p) && !source.includes(bare)) {
      warnings.push(`投稿文中の価格「${p}」がソース本文に見当たりません`);
    }
  }

  // 4. 「全国」表記の捏造チェック
  if (params.text.includes("全国") && !source.includes("全国")) {
    warnings.push("「全国」という販売エリア表記がソース本文にありません");
  }

  return warnings;
}
