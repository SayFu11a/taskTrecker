/* Service worker: офлайн-кэш + приём push.
   Без сборки и зависимостей — файлы сайта кэшируются как есть. */

const VERSION = "vp-tracker-v35";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./namaz.js",
  "./app.js",
  "./glass.css",
  "./glass.js",
  "./sound.js",
  "./achievements.js",
  "./sync.js",
  "./timersync.js",
  "./tabsync.js",
  "./push.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
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
   - сам этот файл никогда не перехватываем: иначе исправленный воркер
     не подхватится, пока старый не решит обновиться;
   - навигация и код (html/js/css/json): сначала сеть, при офлайне — кэш.
     Кэш навсегда тут был ошибкой: правка sync.js не доезжала до устройства,
     пока вручную не поднимешь VERSION;
   - картинки и шрифты: сначала кэш (они не меняются, экономим трафик). */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase и шрифты не трогаем

  /* Сам воркер отдаёт браузер, не мы */
  if (url.pathname.endsWith("/sw.js")) return;

  /* Код и разметка меняются при каждом релизе — их всегда тянем из сети,
     а кэш держим только как офлайн-подстраховку. */
  const dynamic =
    req.mode === "navigate" ||
    /\.(?:html|js|css|json)$/.test(url.pathname) ||
    url.pathname === "/" ||
    url.pathname.endsWith("/");

  if (dynamic) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            const key = req.mode === "navigate" ? "./index.html" : req;
            caches.open(VERSION).then((c) => c.put(key, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((r) => r || caches.match("./index.html"))
            .then((r) => r || caches.match("./"))
        )
    );
    return;
  }

  /* Картинки и прочая статика — сначала кэш */
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
