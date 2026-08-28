export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>🍦 アイス速報Bot</h1>
      <p style={{ color: "#9aa0a6", marginTop: 0 }}>
        PR TIMES の全リリースからアイスの新商品発売告知だけを検出し、要約と画像を付けて X
        へ投稿します。
      </p>

      <div
        style={{
          background: "#171a21",
          border: "1px solid #262b36",
          borderRadius: 12,
          padding: 20,
          marginTop: 28,
        }}
      >
        <h2 style={{ fontSize: 16, marginTop: 0 }}>運用の入口</h2>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            <a href="/admin" style={{ color: "#7cc2ff" }}>
              /admin
            </a>
            … 承認待ちの確認・編集・投稿
          </li>
          <li>
            <code style={{ color: "#f2c94c" }}>/api/selftest</code>
            … 依存先（RSS・Redis・Claude・X）の疎通診断
          </li>
          <li>
            <code style={{ color: "#f2c94c" }}>/api/scan</code>
            … 収集から投稿までの本処理（cronが叩く）
          </li>
          <li>
            <code style={{ color: "#f2c94c" }}>/api/scan?dry=1</code>
            … 投稿せず、何が起きるかだけ確認
          </li>
        </ul>
        <p style={{ color: "#9aa0a6", fontSize: 13, marginBottom: 0 }}>
          /api/ 配下はすべて <code>Authorization: Bearer CRON_SECRET</code> が必要です。
        </p>
      </div>
    </main>
  );
}
