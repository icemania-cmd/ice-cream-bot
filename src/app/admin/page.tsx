"use client";

import { useCallback, useEffect, useState } from "react";

interface Draft {
  guid: string;
  title: string;
  sourceText: string;
  link: string;
  imageUrl?: string;
  releaseDate: string | null;
  postType: "new_product" | "day_before_reminder" | "release_day";
  text: string;
  warnings: string[];
  createdAt: string;
}

const POST_TYPE_LABEL: Record<Draft["postType"], string> = {
  new_product: "新商品",
  day_before_reminder: "前日リマインド",
  release_day: "本日発売",
};

/** X の文字数カウント近似: 全角2・半角1 */
function tweetWeight(text: string): number {
  let weight = 0;
  for (const ch of text) {
    weight += ch.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return weight;
}

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [inputSecret, setInputSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showSource, setShowSource] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const loadDrafts = useCallback(async (sec: string) => {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/drafts", {
        headers: { Authorization: `Bearer ${sec}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        setAuthed(false);
        setMessage("パスワードが違います");
        return;
      }
      const data = await res.json();
      setDrafts(data.drafts || []);
      setAuthed(true);
      setSecret(sec);
    } catch {
      setMessage("読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ページ再訪時の再入力を省略（タブを閉じると消える）
    const saved = sessionStorage.getItem("admin_secret");
    if (saved) loadDrafts(saved);
  }, [loadDrafts]);

  const handleLogin = () => {
    if (!inputSecret.trim()) return;
    sessionStorage.setItem("admin_secret", inputSecret.trim());
    loadDrafts(inputSecret.trim());
  };

  const handleAction = async (guid: string, action: "approve" | "reject") => {
    setBusy(guid);
    setMessage("");
    try {
      const draft = drafts.find((d) => d.guid === guid);
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          guid,
          action,
          text: edits[guid] ?? draft?.text,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`エラー: ${data.error || res.status}`);
        return;
      }
      if (data.action === "posted") {
        setMessage(`✅ 投稿しました${data.tweetId ? ` (tweet ${data.tweetId})` : ""}`);
      } else {
        setMessage("🗑️ 却下しました（この記事は再生成されません）");
      }
      setDrafts((prev) => prev.filter((d) => d.guid !== guid));
    } catch {
      setMessage("通信エラーが発生しました");
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  if (!authed) {
    return (
      <main style={styles.page}>
        <h1 style={styles.h1}>🍦 投稿承認</h1>
        <div style={styles.card}>
          <p style={{ marginTop: 0 }}>管理パスワードを入力してください。</p>
          <input
            type="password"
            value={inputSecret}
            onChange={(e) => setInputSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            style={styles.input}
            placeholder="ADMIN_SECRET"
          />
          <button onClick={handleLogin} style={styles.primaryBtn} disabled={loading}>
            {loading ? "確認中..." : "ログイン"}
          </button>
          {message && <p style={styles.error}>{message}</p>}
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={styles.h1}>🍦 投稿承認（{drafts.length}件）</h1>
        <button onClick={() => loadDrafts(secret)} style={styles.secondaryBtn} disabled={loading}>
          {loading ? "更新中..." : "更新"}
        </button>
      </div>

      {message && <p style={styles.notice}>{message}</p>}

      {drafts.length === 0 && !loading && (
        <div style={styles.card}>
          <p style={{ margin: 0 }}>承認待ちの下書きはありません。</p>
        </div>
      )}

      {drafts.map((draft) => {
        const text = edits[draft.guid] ?? draft.text;
        const weight = tweetWeight(text);
        const over = weight > 280;
        const isBusy = busy === draft.guid;
        const isConfirming = confirming === draft.guid;

        return (
          <div key={draft.guid} style={styles.card}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={styles.badge}>{POST_TYPE_LABEL[draft.postType]}</span>
              {draft.releaseDate && <span style={styles.badgeGray}>発売日 {draft.releaseDate}</span>}
              <a href={draft.link} target="_blank" rel="noreferrer" style={styles.srcLink}>
                元記事を開く ↗
              </a>
            </div>

            <p style={styles.title}>{draft.title}</p>

            {draft.warnings.length > 0 && (
              <div style={styles.warnBox}>
                <strong>⚠️ 要確認</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {draft.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {draft.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.imageUrl} alt="" style={styles.thumb} />
            )}

            <textarea
              value={text}
              onChange={(e) => setEdits((prev) => ({ ...prev, [draft.guid]: e.target.value }))}
              rows={5}
              style={{ ...styles.textarea, borderColor: over ? "#d33" : "#ccc" }}
            />
            <div style={{ fontSize: 12, color: over ? "#d33" : "#888", textAlign: "right" }}>
              {weight}/280
            </div>

            <button
              onClick={() =>
                setShowSource((prev) => ({ ...prev, [draft.guid]: !prev[draft.guid] }))
              }
              style={styles.linkBtn}
            >
              {showSource[draft.guid] ? "▲ ソース本文を閉じる" : "▼ ソース本文と照合する"}
            </button>
            {showSource[draft.guid] && <pre style={styles.source}>{draft.sourceText}</pre>}

            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {isConfirming ? (
                <>
                  <button
                    onClick={() => handleAction(draft.guid, "approve")}
                    style={{ ...styles.primaryBtn, background: "#c9302c" }}
                    disabled={isBusy || over}
                  >
                    {isBusy ? "投稿中..." : "本当に投稿する"}
                  </button>
                  <button onClick={() => setConfirming(null)} style={styles.secondaryBtn} disabled={isBusy}>
                    やめる
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setConfirming(draft.guid)}
                    style={styles.primaryBtn}
                    disabled={isBusy || over}
                  >
                    Xに投稿する
                  </button>
                  <button
                    onClick={() => handleAction(draft.guid, "reject")}
                    style={styles.dangerBtn}
                    disabled={isBusy}
                  >
                    却下
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 640,
    margin: "0 auto",
    padding: "24px 16px 80px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif',
    color: "#222",
  },
  h1: { fontSize: 22, margin: "8px 0 16px" },
  card: {
    border: "1px solid #e0e0e0",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
  },
  badge: {
    background: "#0070f3",
    color: "#fff",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
  },
  badgeGray: {
    background: "#f0f0f0",
    color: "#555",
    borderRadius: 6,
    padding: "2px 8px",
    fontSize: 12,
  },
  srcLink: { fontSize: 12, marginLeft: "auto" },
  title: { fontSize: 13, color: "#666", margin: "10px 0" },
  warnBox: {
    background: "#fff3cd",
    border: "1px solid #ffe08a",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 13,
    marginBottom: 10,
  },
  thumb: { maxWidth: "100%", maxHeight: 200, borderRadius: 8, marginBottom: 10, display: "block" },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    fontSize: 15,
    lineHeight: 1.6,
    padding: 10,
    borderRadius: 8,
    border: "1px solid #ccc",
    fontFamily: "inherit",
    resize: "vertical",
  },
  source: {
    whiteSpace: "pre-wrap",
    fontSize: 12,
    background: "#f8f8f8",
    borderRadius: 8,
    padding: 12,
    maxHeight: 240,
    overflow: "auto",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "#0070f3",
    fontSize: 13,
    padding: 0,
    cursor: "pointer",
    marginTop: 6,
  },
  primaryBtn: {
    background: "#0070f3",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  secondaryBtn: {
    background: "#f0f0f0",
    color: "#333",
    border: "none",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  dangerBtn: {
    background: "#fff",
    color: "#c9302c",
    border: "1px solid #c9302c",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    fontSize: 15,
    padding: 10,
    borderRadius: 8,
    border: "1px solid #ccc",
    marginBottom: 12,
  },
  error: { color: "#c9302c", fontSize: 14 },
  notice: {
    background: "#e8f4ff",
    border: "1px solid #b8ddff",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 14,
  },
};
