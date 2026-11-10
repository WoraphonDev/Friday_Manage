// Service worker ของ Web Push (O25) · เสิร์ฟจาก route เพื่อให้อยู่ที่ราก (scope "/") โดยไม่ต้องมีโฟลเดอร์ public ใน image
const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: "Friday Ops", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "Friday Ops", { body: m.body || "", tag: m.tag, data: { url: m.url || "/m" }, icon: "/icon.svg", badge: "/icon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // เปิดได้เฉพาะหน้าใน origin เดียวกัน
  const url = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : "/m", self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if ("focus" in c && new URL(c.url).origin === url.origin) { await c.navigate(url.href); return c.focus(); }
    return self.clients.openWindow(url.href);
  })());
});
`;

export function GET() {
  return new Response(SW, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
}
