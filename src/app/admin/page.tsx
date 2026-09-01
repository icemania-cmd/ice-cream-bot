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

interface RateStatus {
  canPost: boolean;
  reason?: string;
  todayCount: number;
  limit: number;
  autoPost: boolean;
}

interface QueueData {
  review: QueuedItem[];
  ready: QueuedItem[];
  posted: PostedSummary[];
  runs: RunLog[];
  counts: { ready: number; review: number };
  rate: RateStatus;
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

/**
 * VAPID公開鍵（base64url）を、pushManager.subscribe が受け取れる形に変える。
 */
function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  // Uint8Array で返すと TypeScript の版によって BufferSource として
  // 受け取ってもらえないことがあるため、ArrayBuffer をそのまま返す。
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

type PushState =
  | "checking"
  | "unsupported"
  | "unconfigured"
  | "off"
  | "on"
  | "denied";

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [data, setData] = useState<QueueData | null>(null);
  const [tab, setTab] = useState<"review" | "ready" | "posted" | "runs">(
    "review"
  );
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [pushState, setPushState] = useState<PushState>("checking");
  const [pushDevices, setPushDevices] = useState(0);

  useEffect(() => {
    // URLのフラグメント（#k=…）から鍵を受け取る。
    // スマホのホーム画面にこのリンクを置けば、タップだけで開ける。
    //
    // クエリ（?k=…）ではなくフラグメントを使うのは、フラグメントが
    // サーバーに送信されないため。クエリだとVercelのアクセスログに
    // 鍵がそのまま残ってしまう。
    let key: string | null = null;
    try {
      const m = window.location.hash.match(/[#&]k=([^&]+)/);
      if (m) {
        key = decodeURIComponent(m[1]);
        // アドレスバーと履歴から鍵を消す（画面を見せた・共有した時の事故防止）
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch {
      /* noop */
    }

    if (!key) {
      try {
        key = localStorage.getItem("icebot_admin_secret");
      } catch {
        /* プライベートブラウジング等では無視 */
      }
    }

    if (key) {
      setSecret(key);
      setAuthed(true);
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

  /**
   * 通知の状態を調べる。
   * ブラウザ側（許可・購読の有無）とサーバ側（登録済み端末）の両方を見ないと、
   * 「ONのつもりで届かない」状態に気づけない。
   */
  const checkPush = useCallback(async (key: string) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushState("unsupported");
      return;
    }
    try {
      const res = await fetch("/api/admin/push", {
        headers: { "x-admin-secret": key },
      });
      const json = await res.json();
      setPushDevices(json.devices ?? 0);
      if (!json.configured) {
        setPushState("unconfigured");
        return;
      }
      if (Notification.permission === "denied") {
        setPushState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const known: string[] = json.endpoints || [];
      setPushState(sub && known.includes(sub.endpoint) ? "on" : "off");
    } catch {
      setPushState("off");
    }
  }, []);

  /** この端末を通知先として登録する */
  async function enablePush() {
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPushState(perm === "denied" ? "denied" : "off");
        setMessage(
          "❌ 通知が許可されませんでした。ブラウザの設定から通知を許可してください"
        );
        return;
      }
      const keyRes = await fetch("/api/admin/push", {
        headers: { "x-admin-secret": secret },
      });
      const keyJson = await keyRes.json();
      if (!keyJson.configured) {
        setPushState("unconfigured");
        setMessage("❌ サーバ側のVAPID鍵が未設定です");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(keyJson.publicKey),
        });
      }
      const res = await fetch("/api/admin/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secret,
        },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          label: navigator.userAgent.slice(0, 60),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(`❌ ${json.error}`);
        return;
      }
      setPushState("on");
      setPushDevices(json.devices ?? 1);
      setMessage("✅ この端末に通知を送るよう登録しました");
    } catch (e) {
      setMessage(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  /** この端末への通知を止める */
  async function disablePush() {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch("/api/admin/push", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-admin-secret": secret,
          },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setPushState("off");
      setMessage("この端末への通知を止めました");
      await checkPush(secret);
    } catch (e) {
      setMessage(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  /** 実際に1通送ってみる。届かない原因の切り分けはこれが一番早い。 */
  async function testPush() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secret,
        },
        body: JSON.stringify({ test: true }),
      });
      const json = await res.json();
      setMessage(res.ok ? `📨 ${json.message}` : `❌ ${json.error}`);
    } catch (e) {
      setMessage(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authed && secret) {
      void load(secret);
      void checkPush(secret);
    }
  }, [authed, secret, load, checkPush]);

  /**
   * 自動投稿のON/OFFを切り替える。
   * ONにすると投稿待ちに溜まっている分から順に出ていくため、確認を挟む。
   */
  async function toggleAutoPost(next: boolean) {
    const waiting = data?.ready.length ?? 0;
    if (next) {
      const warn =
        waiting > 0
          ? `\n\n投稿待ちの${waiting}件が、次のスキャンから順に自動投稿されます。`
          : "";
      if (!confirm(`自動投稿をONにします。${warn}`)) return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secret,
        },
        body: JSON.stringify({ autoPost: next }),
      });
      const json = await res.json();
      setMessage(res.ok ? `✅ ${json.message}` : `❌ ${json.error}`);
      await load(secret);
    } catch (e) {
      setMessage(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  function homeLink(): string {
    return `${window.location.origin}/admin#k=${encodeURIComponent(secret)}`;
  }

  /**
   * ホーム画面に置くためのリンクをクリップボードにコピーする。
   * このリンクを開けばパスワード入力なしで管理画面に入れる。
   */
  async function copyHomeLink() {
    const url = homeLink();
    try {
      await navigator.clipboard.writeText(url);
      setMessage(
        "リンクをコピーしました。スマホに送って開き、ブラウザの共有メニューから「ホーム画面に追加」してください"
      );
    } catch {
      window.prompt("このリンクをコピーしてください", url);
    }
  }

  /**
   * アドレスバーに一時的に鍵を戻す。
   *
   * PCのブラウザには「ホーム画面に追加」が無いため、リンクをスマホへ
   * 渡す必要がある。鍵を戻しておけば、ブラウザ標準の「QRコード」や
   * 「デバイスに送信」がそのまま使える（スマホでQRを読めば鍵つきで開く）。
   *
   * 出しっぱなしは危険なので3分で自動的に消す。
   */
  function exposeLinkForQr() {
    window.history.replaceState(null, "", `/admin#k=${encodeURIComponent(secret)}`);
    setMessage(
      "アドレスバーに鍵つきURLを戻しました。ブラウザのメニュー（⋮ または共有）から「QRコードを作成」を選び、スマホで読み取ってください。読み取った先で共有メニュー →「ホーム画面に追加」。3分で自動的にURLから鍵を消します"
    );
    window.setTimeout(() => {
      window.history.replaceState(null, "", "/admin");
      setMessage("URLから鍵を消しました");
    }, 180000);
  }

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
          ADMIN_SECRET または CRON_SECRET を入力してください。
          <br />
          一度入れればこの端末に保存されます。ログイン後に「ホーム画面用リンク」を
          コピーしておくと、次からタップだけで開けます。
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
            padding: 14,
            minHeight: 48,
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={copyHomeLink}
            style={{
              padding: "8px 14px",
              minHeight: 40,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.card,
              color: C.sub,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            リンクをコピー
          </button>
          {pushState !== "unsupported" && (
            <button
              onClick={() =>
                pushState === "on" ? void disablePush() : void enablePush()
              }
              disabled={loading || pushState === "checking"}
              title={
                pushState === "unconfigured"
                  ? "サーバ側のVAPID鍵が未設定です"
                  : "承認待ちが増えたら、この端末に通知します"
              }
              style={{
                padding: "8px 14px",
                minHeight: 40,
                borderRadius: 8,
                border: `1px solid ${pushState === "on" ? C.accent : C.border}`,
                background: C.card,
                color: pushState === "on" ? C.accent : C.sub,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {pushState === "on"
                ? `🔔 通知ON（${pushDevices}台）`
                : pushState === "denied"
                  ? "🔕 通知がブロック中"
                  : pushState === "unconfigured"
                    ? "🔕 通知は未設定"
                    : "🔔 通知をオンにする"}
            </button>
          )}
          {pushState === "on" && (
            <button
              onClick={() => void testPush()}
              disabled={loading}
              style={{
                padding: "8px 14px",
                minHeight: 40,
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.sub,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              テスト送信
            </button>
          )}
          <button
            onClick={exposeLinkForQr}
            style={{
              padding: "8px 14px",
              minHeight: 40,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.card,
              color: C.sub,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            QR用に鍵を表示
          </button>
          <button
            onClick={() => void load(secret)}
            disabled={loading}
            style={{
              padding: "8px 16px",
              minHeight: 40,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: C.card,
              color: C.accent,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {loading ? "更新中..." : "再読み込み"}
          </button>
        </div>
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

      {data?.rate && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            background: C.card,
            border: `1px solid ${data.rate.autoPost ? C.ok : C.border}`,
            borderRadius: 12,
            padding: "14px 18px",
            marginTop: 18,
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              自動投稿{" "}
              <span style={{ color: data.rate.autoPost ? C.ok : C.warn }}>
                {data.rate.autoPost ? "ON" : "OFF"}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.6 }}>
              {data.rate.autoPost
                ? `本日 ${data.rate.todayCount} / ${data.rate.limit} 件。判定を全部通ったものは自動でXへ出ます`
                : "判定と投稿文の生成は動いています。Xへは出さず、投稿待ちに溜まります"}
            </div>
          </div>
          <button
            onClick={() => void toggleAutoPost(!data.rate.autoPost)}
            disabled={loading}
            style={{
              padding: "12px 22px",
              minHeight: 48,
              borderRadius: 999,
              border: "none",
              background: data.rate.autoPost ? C.card : C.ok,
              color: data.rate.autoPost ? C.warn : "#0f1115",
              boxShadow: data.rate.autoPost ? `inset 0 0 0 1px ${C.warn}` : "none",
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {data.rate.autoPost ? "OFFにする" : "ONにする"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, margin: "20px 0", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "10px 18px",
              minHeight: 42,
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
            padding: 14,
            minHeight: 48,
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
            padding: "14px 22px",
            minHeight: 48,
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
