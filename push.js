/* Push-уведомления. Ограничения платформ заложены в интерфейс:
   - на iOS push работают ТОЛЬКО у сайта, добавленного на экран «Домой»;
   - разрешение спрашивать можно только по тапу, не автоматически;
   - свой звук задать нельзя — играет системный. */

const PUSH_KEY = "vp-tracker-push";
/* Идентификатор устройства. Нужен, чтобы у аккаунта не копились чужие
   подписки: один iPhone, подписавшийся заново, оставлял старую строку,
   и сервер слал одно уведомление дважды. */
const DEVICE_KEY = "vp-tracker-device-id";
const HEADERS_COL = "device_id"; // колонка в push_subscriptions (миграция 20261117)

/* Состояние уведомлений складывается из трёх независимых вещей:
   разрешение в браузере, подписка в браузере и строка на сервере.
   Телефон мог сохранить старую подписку, а строку на сервере удалили —
   тогда напоминания молча не приходят. Объявлено здесь, до первого
   renderPushBox(): иначе обращение к ещё не инициализированной переменной
   уронило бы весь профиль. */
let pushServerState = null; // null — не спрашивали; true/false — знаем
let pushHasBrowserSub = null; // есть ли подписка в самом браузере

/* Устройство — случайный id, он же переживает перезагрузку и обновление. */
function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (id && /^[a-z0-9-]{8,64}$/i.test(id)) return id;
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    /* приватный режим без хранилища: id на одну сессию, лучше чем ничего */
    return "dev-" + Math.random().toString(36).slice(2, 12);
  }
}

/* Публичный VAPID-ключ. Пара ключей лежит в Supabase → Edge Functions → Secrets
   (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Публичный можно показывать — он и должен
   быть в коде; приватный в репозиторий не попадает никогда.
   Пусто — уведомления не включатся, интерфейс честно об этом скажет. */
const VAPID_PUBLIC_KEY =
  "BPc_LP9adolrmzAKmPrTR5sBRiOgJ903LG6-rpcF_oP9NorStA6uSTwTB-j6UzEeMS70cHK9xJlYyk9OHIgsJkg";

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

    /* Без входа подписка останется только на этом устройстве:
       сервер не знает, кому слать, поэтому напоминания не придут. */
    if (!(typeof sb !== "undefined" && sb && typeof session !== "undefined" && session)) {
      await sub.unsubscribe();
      toast("Сначала войди через Google — без аккаунта сервер не знает, кому отправлять напоминания.");
      return;
    }

    /* Одна строка на устройство: сначала убираем прежние подписки этого же
       устройства (переустановка, смена endpoint), потом пишем текущую.
       Чужие устройства не трогаем — по ним фильтр device_id. */
    try {
      await sb
        .from("push_subscriptions")
        .delete()
        .eq("user_id", session.user.id)
        .eq(HEADERS_COL, deviceId())
        .neq("endpoint", sub.endpoint);
    } catch (e) {
      console.warn("Старые подписки этого устройства не убрались", e);
    }

    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: session.user.id,
        endpoint: sub.endpoint,
        subscription: sub.toJSON(),
        device_id: deviceId(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );

    if (error) {
      console.warn("Подписка не сохранилась на сервере", error);
      await sub.unsubscribe();
      toast("Подписка не сохранилась на сервере: " + error.message);
      return;
    }

    localStorage.setItem(PUSH_KEY, "on");
    renderPushBox();
    toast("Уведомления включены. Напомню в начале следующего блока.");
  } catch (e) {
    console.warn("Подписка не удалась", e);
    /* Самая частая причина — ключ и сервер не совпадают (например, ключи перегенерировали). */
    toast("Не получилось подписаться: " + (e && e.message ? e.message : "неизвестная ошибка"));
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (typeof sb !== "undefined" && sb && typeof session !== "undefined" && session) {
        await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sb.from("push_subscriptions").delete().eq("user_id", session.user.id).eq(HEADERS_COL, deviceId());
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

  /* Пока Supabase-клиент не готов — не пугаем человека «выключено»,
     просто ждём: состояние зависит от входа в аккаунт. */
  if (typeof authPending !== "undefined" && authPending) {
    root.innerHTML = `<div class="acc-sub">Проверяю уведомления…</div>`;
    return;
  }

  if (!pushSupported()) {
    root.innerHTML = `<div class="acc-sub">Браузер не поддерживает уведомления. На iPhone нужно iOS 16.4 или новее.</div>`;
    return;
  }

  const enabled = pushEnabledLocally() && Notification.permission === "granted";
  /* Подписка в браузере есть, но сервер её не знает: напоминания не придут,
     хотя «разрешение выдано». Показываем это прямо, иначе человек ждёт пуш
     и не понимает, почему тихо. */
  const linked = pushServerState !== false;

  /* Ключ не вписан — честно говорим, что настраивать нечего. */
  if (!VAPID_PUBLIC_KEY) {
    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">Уведомления не настроены</div>
          <div class="acc-sub">В коде нет VAPID-ключа — сервер не может отправлять напоминания.</div>
        </div>
      </div>`;
    return;
  }

  /* Разрешение запрещено в браузере — кнопка «включить» тут бессильна. */
  if (Notification.permission === "denied") {
    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">Уведомления запрещены</div>
          <div class="acc-sub">В настройках сайта в браузере стоит «блокировать». Разреши уведомления для ${location.host} — и нажми «Проверить снова».</div>
        </div>
      </div>
      <button class="ghost-btn acc-btn" id="pushRetry">Проверить снова</button>`;

    const retry = document.getElementById("pushRetry");
    if (retry) retry.addEventListener("click", () => location.reload());
    return;
  }

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

  /* Без входа подписка не дойдёт до сервера — говорим это до нажатия, а не после. */
  const signedIn = typeof session !== "undefined" && Boolean(session);

  /* Отвязанное состояние описываем отдельно и до общего блока. */
  if (!enabled && pushServerState === false && pushHasBrowserSub) {
    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">Подписка не привязана к серверу</div>
          <div class="acc-sub">В браузере подписка есть, но сервер о ней не знает — напоминания не придут. Привяжи заново: разрешение спрашивать не будут.</div>
        </div>
      </div>
      <div class="push-actions">
        <button class="primary-btn acc-btn" id="pushRelink">Привязать это устройство</button>
      </div>`;
    const relink = document.getElementById("pushRelink");
    if (relink) relink.addEventListener("click", () => relinkPush());
    return;
  }

  root.innerHTML = `
    <div class="acc-row">
      <span class="acc-dot ${enabled && linked ? "on" : "off"}"></span>
      <div>
        <div class="acc-title">${enabled ? "Уведомления включены" : "Уведомления выключены"}</div>
        <div class="acc-sub">${
          enabled
            ? "Напомню, когда подойдёт время блока. Звук — системный, свой в вебе задать нельзя."
            : signedIn
              ? "Напоминание о блоке приходит на телефон, даже если трекер закрыт."
              : "Сначала войди через Google выше — напоминания отправляются на аккаунт."
        }</div>
      </div>
    </div>
    <div class="push-actions">
      <button class="${enabled ? "ghost-btn" : "primary-btn"} acc-btn" id="pushToggle" ${!enabled && !signedIn ? "disabled" : ""}>
        ${enabled ? "Выключить" : "Включить уведомления"}
      </button>
      ${enabled ? '<button class="ghost-btn acc-btn" id="pushTest">Проверить</button>' : ""}
    </div>`;

  const btn = document.getElementById("pushToggle");
  if (btn) btn.addEventListener("click", () => (enabled ? disablePush() : enablePush()));

  const test = document.getElementById("pushTest");
  if (test) test.addEventListener("click", () => sendTestPush(test));
}

/* Тестовое уведомление: дёргаем функцию с токеном пользователя —
   сервер проверит токен и отправит push только этому аккаунту. */
async function sendTestPush(button) {
  button.disabled = true;
  button.textContent = "Отправляю…";
  try {
    if (!(typeof sb !== "undefined" && sb && session)) {
      toast("Сначала войди через Google — без аккаунта тестовое уведомление не отправить.");
      return;
    }
    const { data } = await sb.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) {
      toast("Сессия истекла. Войди заново.");
      return;
    }

    const url = `${SUPABASE_URL}/functions/v1/send-reminders?force=1&test=1`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });

    const text = await res.text();
    if (!res.ok) {
      toast(`Сервер ответил ${res.status}: ${text.slice(0, 120)}`);
      return;
    }
    toast("Отправил. Если уведомление не пришло — проверь системные настройки уведомлений для браузера.");
  } catch (e) {
    console.warn("Тестовый push не ушёл", e);
    toast("Не удалось отправить тестовое уведомление: " + (e && e.message ? e.message : "ошибка сети"));
  } finally {
    button.disabled = false;
    button.textContent = "Проверить";
  }
}

/* ─────────── регистрация service worker ─────────── */

async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });

    /* Раз в загрузку и при возврате во вкладку — узнать, нет ли новой версии.
       Иначе исправленный воркер может ждать сутки. */
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => {});
    });

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
/* Состояние уведомлений: локально включено, подписка есть в браузере и
   подписка есть на сервере. Три вещи независимы: телефон мог сохранить
   старую подписку, а строку на сервере удалили (например, при очистке
   устройств) — тогда напоминания молча не приходят, и человек не понимает
   почему. В этом случае не включаем «on» сами, а показываем «не привязано»
   и даём переподключить одной кнопкой. */
async function pushSubscriptionExists() {
  try {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}

async function refreshPushState() {
  if (!pushSupported()) return;
  const sub = await pushSubscriptionExists();
  pushHasBrowserSub = sub;

  if (!sub) {
    /* подписки в браузере нет — и на сервере быть не должно */
    pushServerState = false;
    try {
      localStorage.setItem(PUSH_KEY, "off");
    } catch {}
    renderPushBox();
    return;
  }

  /* Подписка в браузере есть. Спрашиваем сервер, знает ли он её. */
  let onServer = null;
  try {
    if (typeof sb !== "undefined" && sb && typeof session !== "undefined" && session) {
      const { data, error } = await sb
        .from("push_subscriptions")
        .select("endpoint")
        .eq("user_id", session.user.id)
        .eq(HEADERS_COL, deviceId())
        .limit(1);
      if (!error) onServer = Array.isArray(data) && data.length > 0;
    }
  } catch {
    /* не смогли спросить — не врём ни в ту, ни в другую сторону */
  }

  pushServerState = onServer;
  /* «on» ставим только когда сервер действительно знает это устройство.
     onServer === null (спросить не удалось, офлайн) — оставляем как было. */
  if (onServer === true) {
    try {
      localStorage.setItem(PUSH_KEY, "on");
    } catch {}
  } else if (onServer === false) {
    try {
      localStorage.setItem(PUSH_KEY, "off");
    } catch {}
  }
  renderPushBox();
}

/* Перепривязать текущую подписку браузера к серверу, не спрашивая разрешение
   заново: право уже выдано, нужна только строка в базе. */
async function relinkPush() {
  if (!(typeof sb !== "undefined" && sb && session)) {
    toast("Сначала войди через Google — без аккаунта сервер не знает, кому отправлять напоминания.");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) {
      toast("В браузере нет подписки — включи уведомления заново.");
      renderPushBox();
      return;
    }
    const { error } = await sb.from("push_subscriptions").upsert(
      {
        user_id: session.user.id,
        endpoint: sub.endpoint,
        subscription: sub.toJSON(),
        device_id: deviceId(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );
    if (error) throw error;
    localStorage.setItem(PUSH_KEY, "on");
    pushServerState = true;
    renderPushBox();
    toast("Уведомления снова привязаны к этому устройству.");
  } catch (e) {
    toast("Не удалось привязать: " + (e && e.message ? e.message : "неизвестная ошибка"));
  }
}
