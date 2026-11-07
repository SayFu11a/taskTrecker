/* ─────────────────────────────────────────────────────────────
   tabsync.js — одна правда для всех вкладок одного браузера.

   Зачем: таймер живёт в общем localStorage, но каждая вкладка держит
   свою копию state в памяти. Вкладка A останавливала таймер и писала
   в хранилище, вкладка B об этом не знала и через 30 секунд
   перерисовывалась по своей старой копии — таймер «возобновлялся».
   Здесь вкладки договариваются: кто изменил state, тот рассылает
   событие, остальные перечитывают хранилище.

   Механики две, обе без сервера:
   1) BroadcastChannel — мгновенно и с данными;
   2) событие storage — работает, даже если BroadcastChannel закрыт;
      используется как «звонок», данные берутся из localStorage.
   Сервера для этого не нужно: правки между устройствами идут через sync.js.
   ───────────────────────────────────────────────────────────── */

const TAB_CHANNEL = "vp-tracker-tabs";
const TAB_PING_KEY = "vp-tracker-tabs-ping";
const TAB_HELLO_KEY = "vp-tracker-tabs-hello";
const TAB_ECHO_MS = 400; // свои же рассылки не должны будить вкладку

let tabChannel = null;
let tabId = Math.random().toString(36).slice(2);
let tabSeq = 0; // номер изменений этой вкладки
let tabSeenSeq = 0; // последний принятый номер
let tabBusy = false;
let tabLastPing = 0;
let tabStoppedNotice = ""; // чтобы не повторять тост дважды

try {
  if (typeof BroadcastChannel === "function") tabChannel = new BroadcastChannel(TAB_CHANNEL);
} catch {
  tabChannel = null;
}

function tabIsForeign(msg) {
  return !!msg && !!msg.from && msg.from !== tabId;
}

/* Перечитать состояние из localStorage и перерисовать.
   force=true — применяем всегда (вкладку разбудило событие хранилища,
   а не наша же рассылка). */
function tabApplyState(msg, force) {
  if (!force && !tabIsForeign(msg)) return false;
  if (tabBusy) return false;
  if (typeof state === "undefined" || typeof load !== "function") return false;

  /* порядок важен: старое событие не должно вернуть погашенный таймер */
  if (msg && Number.isFinite(msg.seq)) {
    if (msg.seq <= tabSeenSeq) return false;
    tabSeenSeq = msg.seq;
  }

  tabBusy = true;
  try {
    /* своя отложенная отправка уже неактуальна — данные только что сменились */
    if (typeof pushTimer !== "undefined" && pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }

    const keepDate = typeof selectedDate !== "undefined" ? selectedDate : null;
    state = load();
    if (typeof booting !== "undefined") booting = false;
    if (typeof renderAll === "function") renderAll();
    else if (typeof renderNow === "function") renderNow();

    if (msg && msg.kind === "stop") {
      const key = String(msg.block || "") + "@" + String(msg.date || "");
      if (key !== tabStoppedNotice && typeof toast === "function") {
        tabStoppedNotice = key;
        toast("Таймер остановлен в другой вкладке");
      }
      if (typeof play === "function") play("tick");
    }
    if (keepDate && typeof selectedDate !== "undefined" && typeof state !== "undefined") {
      selectedDate = keepDate; // выбранный день — это настройка вкладки, не данные
    }
    return true;
  } catch (e) {
    console.warn("Не удалось принять состояние из другой вкладки", e);
    return false;
  } finally {
    tabBusy = false;
  }
}

/* Разослать «я изменил state». kind: "save" | "start" | "stop" | "hello" */
function tabAnnounce(kind, extra) {
  tabSeq = Math.max(tabSeq, tabSeenSeq) + 1;
  const msg = Object.assign(
    { from: tabId, kind: kind || "save", seq: tabSeq, at: Date.now() },
    extra || {}
  );

  if (tabChannel) {
    try {
      tabChannel.postMessage(msg);
    } catch {
      /* ignore */
    }
  }

  const now = Date.now();
  /* storage пишет только для «звонка»: throttle, чтобы не молотить диск */
  if (now - tabLastPing > TAB_ECHO_MS) {
    tabLastPing = now;
    try {
      localStorage.setItem(TAB_PING_KEY, JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }
  return msg;
}

if (tabChannel) {
  tabChannel.addEventListener("message", (ev) => tabApplyState(ev && ev.data, false));
}

/* storage-событие приходит только в ДРУГИЕ вкладки — то, что нужно.
   Ключ своего состояния ловим тоже: старые версии сайта и запасной путь. */
window.addEventListener("storage", (ev) => {
  if (!ev || !ev.key) return;

  if (ev.key === TAB_PING_KEY) {
    let msg = null;
    try {
      msg = JSON.parse(ev.newValue || "null");
    } catch {
      msg = null;
    }
    if (msg && !tabIsForeign(msg)) return;
    tabApplyState(msg, true);
    return;
  }

  /* запасной путь: вкладка дописала состояние напрямую (смена дня, настройки) */
  const storeKey = typeof STORE_KEY !== "undefined" ? STORE_KEY : "vp-tracker-v1";
  if (ev.key === storeKey) {
    tabApplyState(null, true);
    return;
  }

  /* новая вкладка открылась и просит свежее состояние */
  if (ev.key === TAB_HELLO_KEY && ev.newValue) {
    tabApplyState(null, true);
    tabAnnounce("hello");
  }
});

/* Привет соседям: у них может быть правка, ещё не ушедшая на сервер. */
try {
  localStorage.setItem(TAB_HELLO_KEY, tabId + ":" + Date.now());
} catch {
  /* ignore */
}
