/* Push-уведомления. Ограничения платформ заложены в интерфейс:
   - на iOS push работают ТОЛЬКО у сайта, добавленного на экран «Домой»;
   - разрешение спрашивать можно только по тапу, не автоматически;
   - свой звук задать нельзя — играет системный. */

const PUSH_KEY = "vp-tracker-push";

/* Публичный VAPID-ключ из Supabase (Edge Function → generate-vapid), формат base64url.
   Пусто — уведомления не включатся, интерфейс честно об этом скажет. */
const VAPID_PUBLIC_KEY = "";

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/* Открыт ли сайт как установленное приложение (а не во вкладке Safari). */
function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function pushEnabledLocally() {
  try {
    return localStorage.getItem(PUSH_KEY) === "on";
  } catch {
    return false;
  }
}

/* ─────────── подписка ─────────── */

async function enablePush() {
  if (!pushSupported()) {
    toast("Этот браузер не поддерживает уведомления.");
    return;
  }

  if (!VAPID_PUBLIC_KEY) {
    toast("Уведомления ещё не настроены на сервере. Инструкция — в README.");
    return;
  }

  if (isIOS() && !isStandalone()) {
    toast("На iPhone сначала добавь сайт на экран «Домой» — иначе Apple не разрешит уведомления.");
    return;
  }

  if (Notification.permission === "denied") {
    toast("Уведомления запрещены в настройках браузера. Разреши их для этого сайта.");
    return;
  }

  /* Разрешение — строго по тапу пользователя. */
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("Без разрешения уведомления не придут.");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    localStorage.setItem(PUSH_KEY, "on");

    /* Отправляем подписку на сервер, если он настроен. */
    if (typeof sb !== "undefined" && sb && typeof session !== "undefined" && session) {
      await sb.from("push_subscriptions").upsert(
        {
          user_id: session.user.id,
          endpoint: sub.endpoint,
          subscription: sub.toJSON(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" }
      );
    }

    renderPushBox();
    toast("Уведомления включены.");
  } catch (e) {
    console.warn("Подписка не удалась", e);
    toast("Не получилось подписаться на уведомления.");
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (typeof sb !== "undefined" && sb && typeof session !== "undefined" && session) {
        sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint).then(() => {}, () => {});
      }
      await sub.unsubscribe();
    }
    localStorage.setItem(PUSH_KEY, "off");
    renderPushBox();
    toast("Уведомления выключены.");
  } catch (e) {
    console.warn(e);
  }
}

/* VAPID-ключ приходит строкой base64url, Push API ждёт Uint8Array. */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ─────────── интерфейс ─────────── */

function renderPushBox() {
  const root = document.getElementById("pushBox");
  if (!root) return;

  if (!pushSupported()) {
    root.innerHTML = `<div class="acc-sub">Браузер не поддерживает уведомления. На iPhone нужно iOS 16.4 или новее.</div>`;
    return;
  }

  const enabled = pushEnabledLocally() && Notification.permission === "granted";

  if (isIOS() && !isStandalone()) {
    root.innerHTML = `
      <div class="hint-card">
        <div class="hint-title">📲 На iPhone — сначала на экран «Домой»</div>
        <ol class="hint-steps">
          <li>Открой сайт в <b>Safari</b></li>
          <li>Нажми <b>«Поделиться»</b> (квадрат со стрелкой)</li>
          <li>Выбери <b>«На экран Домой»</b></li>
          <li>Запусти трекер с иконки и вернись на эту вкладку</li>
        </ol>
        <p class="acc-sub">Без этого Apple не показывает уведомления для сайтов — так устроен iOS.</p>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="acc-row">
      <span class="acc-dot ${enabled ? "on" : "off"}"></span>
      <div>
        <div class="acc-title">${enabled ? "Уведомления включены" : "Уведомления выключены"}</div>
        <div class="acc-sub">${
          enabled
            ? "Напомню, когда подойдёт время блока. Звук — системный, свой в вебе задать нельзя."
            : "Напоминание о блоке приходит на телефон, даже если трекер закрыт."
        }</div>
      </div>
    </div>
    <button class="${enabled ? "ghost-btn" : "primary-btn"} acc-btn" id="pushToggle">
      ${enabled ? "Выключить" : "Включить уведомления"}
    </button>`;

  const btn = document.getElementById("pushToggle");
  if (btn) btn.addEventListener("click", () => (enabled ? disablePush() : enablePush()));
}

/* ─────────── регистрация service worker ─────────── */

async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });

    /* Если пришло новое обновление и оно активировалось — мягко сообщаем */
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      const hadController = sessionStorage.getItem("vp-sw-ready");
      if (hadController) toast("Обновлено. Перезагрузи, чтобы применить.");
      else sessionStorage.setItem("vp-sw-ready", "1");
    });
  } catch (e) {
    console.warn("Service worker не зарегистрирован", e);
  }
}

/* Подхватить уже существующую подписку без повторного запроса разрешения. */
async function refreshPushState() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) localStorage.setItem(PUSH_KEY, "on");
  } catch {
    /* ignore */
  }
  renderPushBox();
}
