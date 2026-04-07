export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>🍦 Ice Cream Bot</h1>
      <p>PR TIMESのアイスクリーム情報を自動でXに投稿するBot</p>
      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        Cron: 3時間ごとに自動実行
      </p>
    </main>
  );
}
