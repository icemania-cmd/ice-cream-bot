import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "アイス速報Bot 管理",
  description: "PR TIMES のアイス新商品を検出してXへ投稿するBotの管理画面",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          background: "#0f1115",
          color: "#e8eaed",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', sans-serif",
          lineHeight: 1.7,
        }}
      >
        {children}
      </body>
    </html>
  );
}
