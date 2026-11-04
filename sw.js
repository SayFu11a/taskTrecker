/* Service worker: офлайн-кэш + приём push.
   Без сборки и зависимостей — файлы сайта кэшируются как есть. */

const VERSION = "vp-tracker-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./app.js",
  "./sound.js",
  "./sync.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      /* по одному, чтобы один отсутствующий файл не сорвал всю установку */
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Стратегии:
   - навигация: сначала сеть, при офлайне — кэш (чтобы обновления прилетали сразу);
   - остальное: сначала кэш, потом сеть (мгновенный запуск). */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase и шрифты не трогаем

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit)
    )
  );
});

/* ─────────── push-уведомления ─────────── */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "Пора вернуться к плану" };
  }

  const title = data.title || "Возвращение в профессию";
  const options = {
    body: data.body || "Загляни в трекер — там всё по плану.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: data.tag || "vp-tracker",
    data: { url: data.url || "./" },
    /* звук выбирает система — задать свой в вебе нельзя */
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.registration.scope) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
