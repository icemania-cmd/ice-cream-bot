"use client";

import { useCallback, useEffect, useState } from "react";

interface QueuedItem {
  guid: string;
  title: string;
  link: string;
  corp: string;
  publishedAt: string;
  imageUrl?: string;
  releaseDate: string;
  productName: string;
  maker: string;
  price: string;
  region: string;
  text: string;
  blocking: string[];
  warnings: string[];
  sourceExcerpt: string;
  createdAt: string;
}

interface PostedSummary {
  guid: string;
  title: string;
  link: string;
  text: string;
  tweetId?: string;
  postedAt: string;
  route: string;
}

interface RunLog {
  at: string;
  mode: string;
  fetched: number;
  newCount: number;
  candidates: number;
  classified: number;
  posted: number;
  queued: number;
  skipped: number;
  errors: string[];
  durationMs: number;
  notes: string[];
}

interface QueueData {
  review: QueuedItem[];
  ready: QueuedItem[];
  posted: PostedSummary[];
  runs: RunLog[];
  counts: { ready: number; review: number };
}

/** X の文字数カウント近似（全角2・半角1） */
function tweetWeight(text: string): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return w;
}

const C = {
  bg: "#0f1115",
  card: "#171a21",
  border: "#262b36",
  sub: "#9aa0a6",
  accent: "#7cc2ff",
  warn: "#f2c94c",
  danger: "#ff7b72",
  ok: "#7ee787",
};

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<QueueData | null>(null);
  const [tab, setTab] = useState<"review" | "ready" | "posted" | "runs">(
    "review"
  );
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("icebot_admin_secret");
      if (saved) {
        setSecret(saved);
        setAuthed(true);
      }
    } catch {
      /* プライベートブラウジング等では無視 */
    }
  }, []);

  const load = useCallback(
    async (key: string) => {
      setLoading(true);
      setMessage("");
      try {
        const res = await fetch("/api/admin/queue", {
          headers: { "x-admin-secret": key },
          cache: "no-store",
        });
        if (res.status === 401) {
          setAuthed(false);
          setMessage("パスワードが違います");
          return;
        }
        if (!res.ok) {
          setMessage(`読み込み失敗: ${res.status}`);
          return;
        }
        setData(await res.json());
        setAuthed(true);
        try {
          localStorage.setItem("icebot_admin_secret", key);
        } catch {
          /* noop */
        }
      } catch (e) {
        setMessage(`通信エラー: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (authed && secret) void load(secret);
  }, [authed, secret, load]);

  async function act(
    item: QueuedItem,
    queue: "review" | "ready",
    action: "approve" | "reject",
    text?: string,
    confirmDuplicate = false
  ) {
    if (!confirmDuplicate) {
      if (action === "reject" && !confirm(`却下します:\n${item.title}`)) return;
      if (action === "approve" && !confirm(`このままXへ投稿します:\n\n${text}`))
        return;
    }

    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secret,
        },
        body: JSON.stringify({
          guid: item.guid,
          queue,
          action,
          text,
          confirmDuplicate,
        }),
      });
      const json = await res.json();

      // 同じ商品を投稿済みの可能性。押した操作を握り潰さず、確認したうえで通す
      if (res.status === 409 && json.needsConfirm) {
        setLoading(false);
        if (confirm(json.error)) {
          await act(item, queue, action, text, true);
        } else {
          setMessage("投稿を取りやめました");
        }
        return;
      }

      setMessage(res.ok ? `✅ ${json.action} ${json.imageNote || ""}` : `❌ ${json.error}`);
      await load(secret);
    } catch (e) {
      setMessage(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  if (!authed) {
    return (
      <main style={{ maxWidth: 420, margin: "0 auto", padding: "80px 20px" }}>
        <h1 style={{ fontSize: 22 }}>🍦 管理画面</h1>
        <p style={{ color: C.sub, fontSize: 14 }}>
          ADMIN_SECRET（未設定の場合は CRON_SECRET）を入力してください。
        </p>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load(secret)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.card,
            color: "#e8eaed",
            fontSize: 15,
          }}
        />
        <button
          onClick={() => void load(secret)}
          disabled={loading || !secret}
          style={{
            marginTop: 12,
            width: "100%",
            padding: 12,
            borderRadius: 8,
            border: "none",
            background: C.accent,
            color: "#0f1115",
            fontWeight: 700,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          {loading ? "確認中..." : "開く"}
        </button>
        {message && (
          <p style={{ color: C.danger, fontSize: 14 }}>{message}</p>
        )}
      </main>
    );
  }

  const tabs: { key: typeof tab; label: string; count: number }[] = [
    { key: "review", label: "承認待ち", count: data?.review.length ?? 0 },
    { key: "ready", label: "投稿待ち", count: data?.ready.length ?? 0 },
    { key: "posted", label: "投稿済み", count: data?.posted.length ?? 0 },
    { key: "runs", label: "実行ログ", count: data?.runs.length ?? 0 },
  ];

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 16px 80px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>🍦 アイス速報Bot 管理</h1>
        <button
          onClick={() => void load(secret)}
          disabled={loading}
          style={{
            padding: "6px 14px",
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.card,
            color: C.accent,
            cursor: "pointer",
          }}
        >
          {loading ? "更新中..." : "再読み込み"}
        </button>
      </div>

      {message && (
        <p
          style={{
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 14,
          }}
        >
          {message}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, margin: "20px 0", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: `1px solid ${tab === t.key ? C.accent : C.border}`,
              background: tab === t.key ? "#1d2733" : C.card,
              color: tab === t.key ? C.accent : C.sub,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {t.label} {t.count}
          </button>
        ))}
      </div>

      {tab === "review" &&
        (data?.review.length ? (
          data.review.map((item) => (
            <ReviewCard
              key={item.guid}
              item={item}
              queue="review"
              onAct={act}
              busy={loading}
            />
          ))
        ) : (
          <Empty text="承認待ちはありません。" />
        ))}

      {tab === "ready" &&
        (data?.ready.length ? (
          data.ready.map((item) => (
            <ReviewCard
              key={item.guid}
              item={item}
              queue="ready"
              onAct={act}
              busy={loading}
            />
          ))
        ) : (
          <Empty text="投稿待ちはありません（次のスキャンで自動投稿されます）。" />
        ))}

      {tab === "posted" &&
        (data?.posted.length ? (
          data.posted.map((p) => (
            <div key={p.guid} style={cardStyle}>
              <div style={{ fontSize: 12, color: C.sub }}>
                {new Date(p.postedAt).toLocaleString("ja-JP")} ・{" "}
                {p.route === "auto" ? "自動投稿" : "承認して投稿"}
              </div>
              <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{p.text}</p>
              {p.tweetId && (
                <a
                  href={`https://x.com/icemania/status/${p.tweetId}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: C.accent, fontSize: 13 }}
                >
                  Xで開く
                </a>
              )}
            </div>
          ))
        ) : (
          <Empty text="まだ投稿はありません。" />
        ))}

      {tab === "runs" &&
        (data?.runs.length ? (
          data.runs.map((r, i) => (
            <div key={i} style={cardStyle}>
              <div style={{ fontSize: 12, color: C.sub }}>
                {new Date(r.at).toLocaleString("ja-JP")} ・ {r.mode} ・{" "}
                {(r.durationMs / 1000).toFixed(1)}秒
              </div>
              <div style={{ fontSize: 14, marginTop: 6 }}>
                取得 {r.fetched} / 新規 {r.newCount} / 候補 {r.candidates} / 判定{" "}
                {r.classified} / 投稿 {r.posted} / キュー {r.queued}
              </div>
              {r.notes.map((n, j) => (
                <div key={j} style={{ color: C.sub, fontSize: 13 }}>
                  ・{n}
                </div>
              ))}
              {r.errors.map((e, j) => (
                <div key={j} style={{ color: C.danger, fontSize: 13 }}>
                  ⚠ {e}
                </div>
              ))}
            </div>
          ))
        ) : (
          <Empty text="実行ログがありません。" />
        ))}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: 16,
  marginBottom: 14,
};

function Empty({ text }: { text: string }) {
  return (
    <div style={{ ...cardStyle, color: C.sub, textAlign: "center" }}>{text}</div>
  );
}

function ReviewCard({
  item,
  queue,
  onAct,
  busy,
}: {
  item: QueuedItem;
  queue: "review" | "ready";
  onAct: (
    item: QueuedItem,
    queue: "review" | "ready",
    action: "approve" | "reject",
    text?: string
  ) => void;
  busy: boolean;
}) {
  const [text, setText] = useState(item.text);
  const [showSource, setShowSource] = useState(false);
  const weight = tweetWeight(text);
  const over = weight > 280;

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12, color: C.sub }}>
        {item.corp} ・ 配信 {new Date(item.publishedAt).toLocaleString("ja-JP")}
        {item.releaseDate && ` ・ 発売 ${item.releaseDate}`}
      </div>
      <a
        href={item.link}
        target="_blank"
        rel="noreferrer"
        style={{ color: C.accent, fontSize: 14, wordBreak: "break-all" }}
      >
        {item.title}
      </a>

      {item.blocking.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {item.blocking.map((b, i) => (
            <div key={i} style={{ color: C.danger, fontSize: 13 }}>
              🛑 {b}
            </div>
          ))}
        </div>
      )}
      {item.warnings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {item.warnings.map((w, i) => (
            <div key={i} style={{ color: C.warn, fontSize: 13 }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      )}

      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt=""
          style={{
            maxWidth: "100%",
            maxHeight: 220,
            borderRadius: 8,
            marginTop: 12,
            display: "block",
          }}
        />
      )}

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          marginTop: 12,
          padding: 12,
          borderRadius: 8,
          border: `1px solid ${over ? C.danger : C.border}`,
          background: "#0f1115",
          color: "#e8eaed",
          fontSize: 15,
          lineHeight: 1.7,
          fontFamily: "inherit",
          boxSizing: "border-box",
          resize: "vertical",
        }}
      />
      <div style={{ fontSize: 12, color: over ? C.danger : C.sub }}>
        {weight} / 280
      </div>

      <button
        onClick={() => setShowSource((v) => !v)}
        style={{
          marginTop: 8,
          background: "none",
          border: "none",
          color: C.sub,
          cursor: "pointer",
          padding: 0,
          fontSize: 13,
        }}
      >
        {showSource ? "▼ 原文を隠す" : "▶ 原文と突き合わせる"}
      </button>
      {showSource && (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 12,
            color: C.sub,
            background: "#0f1115",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: 12,
            maxHeight: 260,
            overflow: "auto",
          }}
        >
          {item.sourceExcerpt}
        </pre>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button
          onClick={() => onAct(item, queue, "approve", text)}
          disabled={busy || over}
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 8,
            border: "none",
            background: over ? "#3a3f4b" : C.ok,
            color: "#0f1115",
            fontWeight: 700,
            cursor: over ? "not-allowed" : "pointer",
          }}
        >
          承認してXへ投稿
        </button>
        <button
          onClick={() => onAct(item, queue, "reject")}
          disabled={busy}
          style={{
            padding: "12px 20px",
            borderRadius: 8,
            border: `1px solid ${C.border}`,
            background: C.card,
            color: C.danger,
            cursor: "pointer",
          }}
        >
          却下
        </button>
      </div>
    </div>
  );
}
