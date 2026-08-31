import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "アイス速報Bot 管理",
  description: "PR TIMES のアイス発売情報を検出してXへ投稿するBotの管理画面",
  // スマホのホーム画面に追加したとき、ブラウザのUIなしで開くようにする
  appleWebApp: {
    capable: true,
    title: "アイス速報Bot",
    statusBarStyle: "black-translucent",
  },
  // 管理画面なので検索エンジンには載せない
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f1115",
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
          // iOSで横スクロールが出ないようにする
          overflowX: "hidden",
          WebkitTextSizeAdjust: "100%",
        }}
      >
        {children}
      </body>
    </html>
  );
}
