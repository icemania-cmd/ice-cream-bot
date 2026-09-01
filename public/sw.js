/*
 * 承認待ちの通知を受け取るための Service Worker。
 *
 * 管理画面を開いていなくても、ホーム画面のアイコンに通知が届く。
 * 通知をタップすると /admin を開く（既に開いていればそれを前面に出す）。
 */

self.addEventListener("install", () => {
  // 新しい sw.js をすぐ有効にする。通知の不具合を直したとき、
  // ユーザーがタブを全部閉じるまで反映されないのを避けるため。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "アイス速報Bot";
  const options = {
    body: data.body || "承認待ちが増えました",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    // 同じ tag の通知は積み上がらず置き換わる。
    // 10分おきに届いて通知欄が埋まるのを防ぐ。
    tag: data.tag || "ice-review",
    renotify: true,
    data: { url: data.url || "/admin" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/admin";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        if (client.url.includes("/admin") && "focus" in client) {
          await client.focus();
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
