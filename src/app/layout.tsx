export const metadata = {
  title: "Ice Cream Bot",
  description: "PR TIMESのアイスクリーム情報を自動投稿",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
