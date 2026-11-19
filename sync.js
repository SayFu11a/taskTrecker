/* Синхронизация с Supabase: аккаунт через Google, данные на сервере.
   Пока ключи не вписаны — модуль молча выключен, сайт работает локально.
   Никакая ошибка сети не должна ломать трекер: всё в try/catch. */

const SUPABASE_URL = "https://dzgututxrglgvcvduqqx.supabase.co"; // например https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_iYTOoi7jGnBydA4yfbdivA_IWUs-PDb"; // anon public key из настроек проекта

const SYNC_PENDING_KEY = "vp-tracker-pending";

/* Куда Google возвращает после входа. Должно совпадать с Site URL в Supabase
   (Authentication → URL Configuration), иначе человека уводит на localhost.
   Пусто — берём текущий адрес страницы. */
const APP_URL = "https://profession-tracker.vercel.app/";

let sb = null; // клиент
let session = null;
let syncBusy = false;
let pushTimer = null;
let lastAuthError = null; // ошибка возврата после входа — показывается на экране аккаунта
let authPending = false; // SDK ещё грузится — чтобы блок не был пустым

/* ─────────── один вход для всех сигналов «пора синхронизироваться» ───────────
   Фокус, возврат во вкладку, online, SIGNED_IN и realtime раньше дёргали
   синхронизацию каждый сам по себе: за 6 секунд возврата набегало 6 запросов
   статуса таймера, а realtime переподключался дважды. Теперь все сигналы
   идут через requestSync(): не чаще одного запуска за SYNC_MIN_GAP мс,
   лишние вызовы схлопываются в один отложенный. */
const SYNC_MIN_GAP = 10000; // 10 секунд между запусками
/* Полная сверка дней — самый дорогой проход (select всех дней + settings).
   Сигналов «пора свериться» много, и они повторяются, поэтому сам проход
   тоже не чаще раза в минуту; экстренные случаи идут с force. */
const SYNC_MIN_FULL_GAP = 60000;
/* Сверка тянет за собой ещё сверку таймера, а та — ещё одну: без общей
   шины получалось 4–6 timer_status на одно «вернулся во вкладку».
   Счётчик в окне 10 с схлопывает всё это в один проход. */
const STATUS_MIN_GAP = 10000;
let statusLastAt = 0;
function syncTimerThrottled() {
  const now = Date.now();
  if (now - statusLastAt < STATUS_MIN_GAP) return false;
  statusLastAt = now;
  return true;
}
let syncLastRunAt = 0;
let syncQueuedTimer = null;
let syncQueuedAt = 0;
let syncLastSessionId = null; // чтобы SIGNED_IN на ту же сессию не стартовал заново

function syncCooldownLeft() {
  return Math.max(0, SYNC_MIN_GAP - (Date.now() - syncLastRunAt));
}

/* why — только для отладки в консоли, на поведение не влияет. */
let pullLastAt = 0;

function requestSync(why, { force = false } = {}) {
  if (!sb || !session) return;
  if (typeof syncBusy !== "undefined" && syncBusy) return;
  /* проход был меньше минуты назад и его не просят срочно — не повторяем */
  if (!force && pullLastAt && Date.now() - pullLastAt < SYNC_MIN_FULL_GAP) return;

  const left = force ? 0 : syncCooldownLeft();
  if (!left) {
    if (syncQueuedTimer) {
      clearTimeout(syncQueuedTimer);
      syncQueuedTimer = null;
    }
    syncLastRunAt = Date.now();
    if (typeof console !== "undefined") console.debug && console.debug("[sync]", why);
    pullLastAt = Date.now();
    pullThenPush();
    return;
  }
  /* уже запланировано раньше — второй таймер не заводим */
  if (syncQueuedTimer) return;
  syncQueuedAt = Date.now();
  syncQueuedTimer = setTimeout(() => {
    syncQueuedTimer = null;
    requestSync(why + ":догон", { force: true });
  }, left + 50);
}

function syncConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/* ─────────── загрузка SDK ─────────── */

async function initSync() {
  if (!syncConfigured()) {
    renderAccount();
    return;
  }

  authPending = true;
  renderAccount(); // сразу показываем «подключаю», а не пустую плашку
  let clientCreated = false;

  try {
    /* SDK грузим динамически: без настроенного Supabase лишних запросов нет.
       Таймаут обязателен: если CDN заблокирован блокировщиком, промис
       может висеть вечно, и экран аккаунта останется пустым. */
    const mod = await Promise.race([
      import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SDK не загрузился за 10 секунд")), 10000)),
    ]);
    sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    clientCreated = true;

    /* Подписку ставим ДО обмена кода: иначе SIGNED_IN от обмена
       пройдёт мимо обработчика и синхронизация не запустится. */
    sb.auth.onAuthStateChange((event, newSession) => {
      session = newSession;
      renderAccount();
      if (typeof renderPushBox === "function") renderPushBox();
      if (event === "SIGNED_IN") {
        /* Supabase присылает SIGNED_IN и при каждом возврате во вкладку,
           и при обновлении токена. Если человек тот же — синхронизация уже
           идёт или только что прошла, второй раз не нужно. */
        const uid = newSession && newSession.user ? newSession.user.id : null;
        const sameSession = uid && uid === syncLastSessionId;
        syncLastSessionId = uid;
        if (!sameSession) requestSync("signed-in", { force: true });
      }
      if (event === "SIGNED_OUT") {
        syncLastSessionId = null;
        syncLastRunAt = 0;
      }
    });

    await reportOauthError();

    /* Если в адресе остался code — довершаем вход сами: автообмен
       мог сорваться, а повторный запрос со свежим состоянием проходит. */
    await exchangeCodeManually();

    const { data } = await sb.auth.getSession();
    session = data.session || null;

    if (session) {
      await pullThenPush();
      /* окно 10 с — внутри timerSyncFromServer: каждый сигнал раньше
         приносил свой timer_status */
      if (typeof timerSyncFromServer === "function") await timerSyncFromServer();
    }
    else if (hasLocalData()) await maybeOfferMigration();
  } catch (e) {
    console.warn("Синхронизация недоступна", e);
    /* Обнуляем только НЕудавшуюся попытку. Если клиент уже создан, а
       сорвалось что-то после (обмен кода, первый проход), обнулять его
       нельзя: серверный таймер и намаз молча уходят в локальный режим до
       перезагрузки — то есть «синхронизация недоступна» на живой связи. */
    if (!clientCreated) sb = null;
  } finally {
    authPending = false;
    renderAccount();
    if (typeof renderPushBox === "function") renderPushBox();
  }
}

/* ─────────── вход / выход ─────────── */

async function signInWithGoogle() {
  if (!sb) {
    toast("Ключи не загрузились. Обнови страницу — если не помогло, проверь sync.js.");
    return;
  }

  /* Явный адрес возврата. Без него Supabase подставляет Site URL,
     а он по умолчанию localhost:3000 — вход «проходит» и уводит в никуда. */
  const redirectTo = APP_URL || window.location.origin + window.location.pathname;

  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo, skipBrowserRedirect: false },
  });

  if (error) {
    console.warn("Вход не удался", error);
    toast("Не получилось войти: " + error.message);
  }
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  session = null;
  renderAccount();
  if (typeof renderPushBox === "function") renderPushBox();
  toast("Вышел из аккаунта. Данные остались на этом устройстве.");
}

/* ─────────── чтение / запись ─────────── */

function hasLocalData() {
  const h = state.hours || {};
  return Object.keys(h).length > 0 || (state.leetcode || []).length > 0;
}

/* Разложить состояние на строки dto для таблиц.
   В поле hours уходит { блок: { min, timer: { startedAt } } } — записанные
   минуты и, если таймер идёт, время его запуска. Тогда таймер переживает
   перезагрузку и виден на других устройствах. */
/* Отправляем только изменённые дни. Раньше на сервер уходили ВСЕ дни при
   каждой отправке, и триггер days_touch переписывал updated_at у всех строк —
   по этой отметке потом не понять, что реально менялось. now=false (по
   умолчанию) — забираем список грязных дат и очищаем его; now=true —
   отдаём вообще все дни (нужно для разовой миграции/первой загрузки). */
function stateToRows(userId, { all = false } = {}) {
  const meta = state.meta || {};
  const dates = Object.keys(state.hours || {}).filter((d) => {
    const day = state.hours[d] || {};
    return Object.keys(day).length > 0;
  });
  const dirty = typeof takeDirtyDates === "function" ? takeDirtyDates() : null;
  const picked = all || !dirty ? dates : dates.filter((d) => dirty.has(d));

  return picked.map((date) => ({
    user_id: userId,
    date,
    hours: normalizeDayForDb(state.hours[date], (state.minAt || {})[date]),
    mode: (state.modes || {})[date] || null,
    updated_at: new Date(meta[date] || Date.now()).toISOString(),
  }));
}

/* Число минут → { min } — один формат в базе, чтобы слияние было предсказуемым. */
function normalizeDayForDb(day, minAtFallback) {
  const out = {};
  Object.keys(day || {}).forEach((id) => {
    const rec = day[id];
    if (typeof rec === "number") {
      if (rec > 0) out[id] = { min: rec };
      return;
    }
    if (!rec) return;
    const min = Number(rec.min) || 0;
    const startedAt = rec.timer && rec.timer.startedAt;
    /* Ноль минут — это тоже правка («удалил часы»): её нельзя выбрасывать,
       иначе удаление не доедет до сервера и вернётся с другого устройства.
       Если отметки нет в самой записи, берём её из state.minAt: иначе при
       остановке таймера запись оставалась без minAt, и слияние не знало,
       чья правка новее. */
    const minAt = Number(rec.minAt) || Number((minAtFallback || {})[id]) || 0;
    if (!min && !startedAt && !minAt && !rec.stoppedAt) return;
    /* Ноль минут без отметки и с идущим серверным таймером — это «ещё не
       пришли минуты с сервера», а не правка. Отправили бы min: 0 и затёрли
       записанное. Ждём ответа timer_stop, он и принесёт минуты и minAt. */
    if (!min && !minAt && startedAt && rec.timer && rec.timer.byServer) return;
    out[id] = { min };
    /* Серверный таймер не отправляем: он уже на сервере, а локальная копия
       минус минуты после стопа (min: 0) затёрла бы записанное. */
    if (startedAt && !(rec.timer && rec.timer.byServer)) {
      out[id].timer = { startedAt };
    }
    /* когда меняли минуты — по этому полю договариваются устройства */
    if (minAt) out[id].minAt = minAt;
    if (rec.stoppedAt) out[id].stoppedAt = rec.stoppedAt;
  });
  return out;
}

/* Слить день с сервера с локальным ПО БЛОКАМ, а не целиком:
   если на телефоне отмечали LeetCode, а на ПК — Ulbi, оба сохранятся. */
/* Слияние тренировок.
   Формат: { "<неделя>": { mon: true, wed: false, fri: true, updatedAt: ISO } }.
   Правило простое: у недели есть updatedAt — чья запись новее, та и права
   целиком (поэтому снятая галочка не «воскресает» с другого устройства).
   Записи без updatedAt (старые данные) объединяем: отметка остаётся,
   если она есть хотя бы с одной стороны. */
function mergeGym(localGym, remoteGym) {
  const out = {};
  const weeks = new Set([...Object.keys(localGym || {}), ...Object.keys(remoteGym || {})]);
  weeks.forEach((week) => {
    const a = (localGym || {})[week] || {};
    const b = (remoteGym || {})[week] || {};
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;

    if (ta || tb) {
      const winner = tb > ta ? b : a;
      const merged = { ...winner };
      if (winner.updatedAt) merged.updatedAt = winner.updatedAt;
      out[week] = merged;
      return;
    }

    const days = new Set([...Object.keys(a), ...Object.keys(b)]);
    const merged = {};
    days.forEach((day) => {
      merged[day] = !!(a[day] || b[day]);
    });
    out[week] = merged;
  });
  return out;
}

function mergeDay(localDay, remoteDay, localAt, remoteAt) {
  const out = {};
  const local = localDay || {};
  const remote = remoteDay || {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);

  ids.forEach((id) => {
    const a = local[id]; // локальный
    const b = remote[id]; // серверный
    const aMin = typeof a === "number" ? a : (a && Number(a.min)) || 0;
    const bMin = typeof b === "number" ? b : (b && Number(b.min)) || 0;

    /* Минуты: побеждает ПОСЛЕДНЯЯ правка, а не большее число.
       Раньше стояло Math.max, и удаление («−» или «своё: -120») не могло
       доехать до сервера: телефон отдавал старое большее число, оно
       возвращалось, и стёртые часы появлялись снова при каждой синхронизации.
       Отметки нет только у старых записей — для них оставляем max. */
    const aAt = Number(a && a.minAt) || Number((localAt || {})[id]) || 0;
    const bAt = Number(b && b.minAt) || Number((remoteAt || {})[id]) || 0;
    let min;
    if (aAt && bAt && aAt !== bAt) min = aAt > bAt ? aMin : bMin;
    else min = aAt || bAt ? (aAt >= bAt ? aMin : bMin) : Math.max(aMin, bMin);
    const minAt = Math.max(aAt, bAt) || 0;
    const aTimer = a && a.timer && a.timer.startedAt;
    const bTimer = b && b.timer && b.timer.startedAt;
    /* если таймер идёт на двух устройствах — берём тот, что раньше начался */
    const timers = [aTimer, bTimer].filter(Boolean).map((x) => new Date(x).getTime()).filter(Number.isFinite);
    const startedAt = timers.length ? Math.min(...timers) : null;
    const byServer = Boolean((a && a.timer && a.timer.byServer) || (b && b.timer && b.timer.byServer));

    /* Остановка — это тоже событие со своим временем. Если таймер погасили
       позже, чем он был запущен на другом устройстве, гасим его везде:
       иначе «остановил — а он возобновился» на соседней вкладке. */
    const stops = [a && a.stoppedAt, b && b.stoppedAt]
      .filter(Boolean).map((x) => new Date(x).getTime()).filter(Number.isFinite);
    const stoppedAt = stops.length ? Math.max(...stops) : null;
    const isOff = stoppedAt && (!startedAt || stoppedAt >= startedAt);

    if (!min && !startedAt && !stoppedAt && !minAt) return;
    if (isOff) out[id] = { min, stoppedAt: new Date(stoppedAt).toISOString() };
    else if (startedAt) {
      out[id] = { min, timer: { startedAt: new Date(startedAt).toISOString() } };
      if (byServer) out[id].timer.byServer = true;
    } else out[id] = { min };
    if (minAt) out[id].minAt = minAt;
  });

  return out;
}

/* Собрать состояние из строк сервера, слив с локальным. */
function mergeRowsIntoState(rows) {
  state.modes = state.modes || {};
  state.meta = state.meta || {};
  state.hours = state.hours || {};

  /* Если слияние оставило локальное значение (например, стоп с другого
     устройства ещё не уехал), день надо отправить обратно — но только
     такой день, а не все пришедшие: иначе пуш раздувался до всего списка. */
  const localWins = new Set();

  rows.forEach((row) => {
    const remoteTs = new Date(row.updated_at).getTime() || 0;
    const localTs = state.meta[row.date] || 0;

    if (row.mode) state.modes[row.date] = row.mode;

    /* Часы — единственный источник. Старые строки (до перехода на минуты)
       содержат только blocks с уровнями: переводим их в минуты. */
    let remoteHours = row.hours;
    if ((!remoteHours || !Object.keys(remoteHours).length) && row.blocks && typeof hoursFromLegacyLevels === "function") {
      remoteHours = hoursFromLegacyLevels(row.blocks);
    }

    /* отметки правок передаём отдельно: сервер держит их в hours[*].minAt,
       а старые записи — вне «hours», тогда сработает max */
    const merged = mergeDay(state.hours[row.date], remoteHours, (state.minAt || {})[row.date], null);
    if (Object.keys(merged).length) {
      state.hours[row.date] = merged;
      /* поднимаем отметки в state.minAt — по ним решается, чья правка свежее */
      if (!state.minAt) state.minAt = {};
      const dayAt = state.minAt[row.date] || (state.minAt[row.date] = {});
      Object.keys(merged).forEach((id) => {
        const at = Number(merged[id] && merged[id].minAt) || 0;
        if (at > (Number(dayAt[id]) || 0)) dayAt[id] = at;
      });
      if (!Object.keys(dayAt).length) delete state.minAt[row.date];

      const remoteNorm = remoteHours || {};
      Object.keys(merged).forEach((id) => {
        const mine = Number(merged[id] && merged[id].min) || 0;
        const srvRec = remoteNorm[id];
        if (srvRec === undefined) return; // блока нет на сервере — это пусто, не расхождение
        const srvMin = typeof srvRec === "number" ? srvRec : Number(srvRec && srvRec.min) || 0;
        if (mine !== srvMin) localWins.add(row.date);
      });
    }

    /* meta двигаем только если сервер реально новее — иначе локальная
       правка перетрёт следующую отправку своим «старым» временем */
    if (remoteTs > localTs) state.meta[row.date] = remoteTs;
  });

  if (localWins.size && typeof markDayDirty === "function") {
    localWins.forEach((d) => markDayDirty(d));
  }
}

async function pullThenPush() {
  if (!sb || !session) return;
  if (syncBusy) return;
  syncBusy = true;
  pullLastAt = Date.now();

  let ok = false;
  try {
    const { data, error } = await sb
      .from("days")
      .select("date,blocks,hours,mode,updated_at")
      .eq("user_id", session.user.id);

    if (error) throw error;

    if (data && data.length) {
      mergeRowsIntoState(data);
      saveLocalOnly();
      renderAll();
    }

    await pushAll();
    await pullSettings();
    /* Таймер — серверный: именно он решает, идёт он или уже погашен */
    /* окно 10 с — внутри timerSyncFromServer: каждый сигнал раньше
       приносил свой timer_status */
    if (typeof timerSyncFromServer === "function") await timerSyncFromServer();
    if (session && session.user) syncLastSessionId = session.user.id;
    toast("Синхронизировано");
    ok = true;
  } catch (e) {
    console.warn("Не удалось синхронизировать", e);
    toast("Нет связи с сервером — работаем локально.");
  } finally {
    syncBusy = false;
    /* Проход сорвался (нет сети) — окно «не чаще раза в минуту» снимаем:
       иначе вернувшаяся сеть упрётся в него, и правки будут ждать. */
    if (!ok) pullLastAt = 0;
  }
}

async function pushAll({ all = false } = {}) {
  if (!sb || !session) return;
  /* Идёт timer_stop: локальные минуты ещё не пришли, а серверный таймер
     уже не наш. Отправили бы min: 0 с идущим таймером и затёрли запись.
     Отложим — writeMinutes после ответа сам вызовет syncSoon(). */
  if (typeof srvStopInFlight !== "undefined" && srvStopInFlight) return;

  /* Если таймер только что остановила база, она уже записала минуты в день.
     Пуш со старым (меньшим) числом затёр бы их — поэтому сначала забираем
     день с сервера, потом отправляем. */
  if (typeof timerSyncFromServer === "function" && typeof srvTimer === "object") {
    try {
      await timerSyncFromServer();
    } catch {
      /* не критично: ниже отправим то, что есть */
    }
  }

  /* Только изменённые дни. Пустую отправку не делаем: раньше каждый клик
     отправлял все дни, триггер days_touch переписывал updated_at у всех строк,
     и по отметке нельзя было понять, что реально менялось.
     Исключение — all: разовая выгрузка всех дней при входе/миграции. */
  const rows = stateToRows(session.user.id, { all });
  if (!rows.length) return;
  /* версии «кто правил день» на момент сборки строк: без них ответ сервера
     снимал бы отметку и с дня, который успели изменить, пока запрос летел */
  const sentVersions = typeof dirtyDaysVersion === "function" ? dirtyDaysVersion() : null;

  const { error } = await sb.from("days").upsert(rows, { onConflict: "user_id,date" });
  if (error) {
    /* не ушло — дни снова считаются изменёнными, иначе правка потеряется */
    if (typeof markDayDirty === "function") rows.forEach((r) => markDayDirty(r.date));
    throw error;
  }
  if (typeof clearDirtyDays === "function") clearDirtyDays(rows.map((r) => r.date), sentVersions);
}

/* Настройки — отдельная строка. Отправляем, только если они реально
   менялись с прошлой удачной отправки: раньше каждый проход сверки слал
   settings.upsert с тем же содержимым, и триггер двигал updated_at. */
const SETTINGS_PUSH_KEY = "vp-tracker-settings-pushed-v1";
let settingsPushedSnapshot = null;

function settingsSnapshot() {
  return JSON.stringify({
    week: state.week,
    schedule_view: state.scheduleView,
    achievements: state.achievements || {},
    leetcode: state.leetcode || [],
    namaz_on: state.namazOn !== false,
    gym: state.gym || {},
  });
}

function settingsPushedBefore() {
  if (settingsPushedSnapshot === null) {
    try {
      settingsPushedSnapshot = localStorage.getItem(SETTINGS_PUSH_KEY) || "";
    } catch {
      settingsPushedSnapshot = "";
    }
  }
  return settingsPushedSnapshot === settingsSnapshot();
}

function noteSettingsPushed() {
  settingsPushedSnapshot = settingsSnapshot();
  try {
    localStorage.setItem(SETTINGS_PUSH_KEY, settingsPushedSnapshot);
  } catch {
    /* ignore */
  }
}

async function pushSettings({ force = false } = {}) {
  if (!sb || !session) return;
  if (!force && settingsPushedBefore()) return;
  try {
    const { error } = await sb.from("settings").upsert(
      {
        user_id: session.user.id,
        week: state.week,
        schedule_view: state.scheduleView,
        achievements: state.achievements || {},
        leetcode: state.leetcode || [],
        namaz: state.namaz || {},
        namaz_on: state.namazOn !== false,
        /* Тренировки жили только в localStorage — на телефоне их не было. */
        gym: state.gym || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    /* ошибку нельзя молча глотать: иначе «настройки не сохраняются» выглядит
       как будто всё в порядке */
    if (error) {
      console.warn("Настройки не ушли", error);
      lastAuthError = "Настройки не сохранились на сервере: " + (error.message || "ошибка");
      renderAccount();
      return;
    }
    noteSettingsPushed();
  } catch (e) {
    console.warn("Настройки не ушли", e);
  }
}

async function pullSettings() {
  if (!sb || !session) return;
  try {
    const { data } = await sb.from("settings").select("*").eq("user_id", session.user.id).maybeSingle();
    if (!data) {
      await pushSettings({ force: true });
      return;
    }
    if (typeof data.week === "number") state.week = data.week;
    if (data.schedule_view) state.scheduleView = data.schedule_view;
    if (data.achievements && Object.keys(data.achievements).length) {
      state.achievements = { ...(state.achievements || {}), ...data.achievements };
    }
    if (Array.isArray(data.leetcode) && data.leetcode.length) state.leetcode = data.leetcode;
    /* отметки намаза сливаем: выполненные на любом устройстве остаются выполненными */
    if (data.namaz && typeof data.namaz === "object") {
      const local = state.namaz || {};
      const merged = { ...data.namaz };
      Object.keys(local).forEach((date) => {
        merged[date] = { ...(merged[date] || {}), ...local[date] };
      });
      state.namaz = merged;
    }
    if (typeof data.namaz_on === "boolean") state.namazOn = data.namaz_on;
    /* Тренировки: отметка одна и та же на всех устройствах, поэтому
       объединяем — отмеченное где-то ещё не должно пропасть здесь.
       Формат: { "<неделя>": { mon: true, wed: false, fri: true } }. */
    if (data.gym && typeof data.gym === "object" && !Array.isArray(data.gym)) {
      state.gym = mergeGym(state.gym || {}, data.gym);
    }
    /* то, что пришло с сервера, повторно отправлять не нужно */
    noteSettingsPushed();
    saveLocalOnly();
    renderAll();
  } catch (e) {
    console.warn("Настройки не пришли", e);
  }
}

/* ─────────── очередь изменений ─────────── */

/* Вызывается из save(): отложенная отправка, чтобы не дёргать сервер на каждый клик. */
function syncSoon() {
  if (!sb || !session) return;
  try {
    localStorage.setItem(SYNC_PENDING_KEY, "1");
  } catch {
    /* ignore */
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await pushAll();
      await pushSettings();
      localStorage.removeItem(SYNC_PENDING_KEY);
    } catch (e) {
      console.warn("Отправка не удалась, попробуем позже", e);
    }
  }, 1200);
}

/* Вернулась сеть — досылаем то, что накопилось. */
window.addEventListener("online", () => {
  if (!sb || !session) return;
  let pending = false;
  try {
    pending = localStorage.getItem(SYNC_PENDING_KEY) === "1";
  } catch {
    /* ignore */
  }
  /* force: сеть вернулась — это редкое и важное событие. Через обычное окно
     его отбрасывало «проход был меньше минуты назад», и правки, сделанные
     без сети, ждали следующего сигнала. */
  if (pending) requestSync("online", { force: true });
});

/* Вернулись во вкладку — подтягиваем изменения с других устройств.
   Через планировщик: иначе на каждое возвращение уходило до 6 запросов. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  requestSync("visibility");
});

/* ─────────── ошибки возврата после входа ─────────── */

/* Supabase присылает проблему в адресе: #error=access_denied&error_description=…
   Без этого человек видит «ничего не произошло» и не понимает, что делать. */
async function reportOauthError() {
  /* Supabase кладёт ошибку в query (?error=…), старые версии — в хэш (#error=…).
     Проверяем оба, иначе причина молча теряется. */
  const fromSearch = new URLSearchParams(window.location.search || "");
  const fromHash = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));

  const pick = (key) => fromSearch.get(key) || fromHash.get(key) || "";
  const code = pick("error");           // server_error, access_denied, …
  const errorCode = pick("error_code"); // unexpected_failure, … — точнее
  const desc = pick("error_description");

  if (!code && !desc) return false;

  const readable = {
    access_denied: "Вход отменён на стороне Google.",
    server_error: "Supabase не смог завершить обмен кода с Google.",
    unauthorized_client: "Google-клиент настроен неверно: адрес возврата не разрешён.",
    invalid_request: "Некорректный запрос к Supabase — чаще всего из-за Site URL.",
  };

  let hint = readable[code] || desc.replace(/\+/g, " ") || code;

  /* Обмен кода не удался — это почти всегда несовпадение Client Secret
     или адреса возврата в Google Console. Подсказываем, где смотреть. */
  if (/exchange external code/i.test(desc)) {
    hint =
      "Supabase не смог обменять код с Google. Проверь в Supabase → Providers → Google: " +
      "Client ID и Client Secret скопированы без пробелов и от того же OAuth-клиента, " +
      "и что в Google Console среди Authorized redirect URIs есть адрес вида " +
      "https://dzgututxrglgvcvduqqx.supabase.co/auth/v1/callback";
  }

  lastAuthError = { code, errorCode, desc: desc.replace(/\+/g, " ") };
  toast("Вход не удался: " + hint);

  /* Чистим адрес, чтобы ошибка не всплывала при каждой перезагрузке — но
     никогда не трогаем code: Supabase может отдать его вместе с ошибкой,
     и вычистив адрес мы теряем единственный способ довершить вход. */
  const params = new URLSearchParams(window.location.search || "");
  if (!params.get("code") && window.history && window.history.replaceState) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  return true;
}

/* ─────────── ручной обмен кода (если автообмен сорвался) ─────────── */

/* Supabase вернул code в адрес, но сам сессию не создал — например обмен
   сорвался на сервере. Клиент умеет обменять его сам, со свежим запросом. */
async function exchangeCodeManually() {
  const params = new URLSearchParams(window.location.search || "");
  const code = params.get("code");
  if (!code || !sb) return false;

  try {
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) throw error;

    window.history.replaceState({}, document.title, window.location.pathname);
    toast("Вошёл. Синхронизация включается.");
    return true;
  } catch (e) {
    console.warn("Ручной обмен кода не удался", e);
    return false;
  }
}

/* ─────────── интерфейс ─────────── */

function renderAccount() {
  const root = document.getElementById("accountBox");
  if (!root) return;

  if (!syncConfigured()) {
    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">Аккаунт не подключён</div>
          <div class="acc-sub">Данные хранятся только в этом браузере. Чтобы открывать трекер с телефона и с ПК — подключи Supabase, инструкция в README.</div>
        </div>
      </div>`;
    return;
  }

  if (!session) {
    /* если ключи есть, но клиент не создался — показываем причину, а не молчим */
    const broken = !sb && !authPending;

    if (authPending) {
      root.innerHTML = `
        <div class="acc-row">
          <span class="acc-dot off"></span>
          <div>
            <div class="acc-title">Подключаю аккаунт…</div>
            <div class="acc-sub">Загружаю библиотеку Supabase с CDN.</div>
          </div>
        </div>
        <button class="primary-btn acc-btn" disabled>Войти через Google</button>`;
      return;
    }
    const errorNote = lastAuthError
      ? `<div class="acc-error">Предыдущая попытка не удалась: ${
          lastAuthError.errorCode || lastAuthError.code || "ошибка"
        }${lastAuthError.desc ? " — " + lastAuthError.desc : ""}</div>`
      : "";

    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">${broken ? "Не удалось загрузить Supabase" : "Войди, чтобы синхронизировать"}</div>
          <div class="acc-sub">${
            broken
              ? "Ключи вписаны, но SDK не загрузился. Обычно это блокировщик рекламы или офлайн."
              : "Один аккаунт — телефон и компьютер видят одни и те же отметки."
          }</div>
        </div>
      </div>
      ${errorNote}
      <button class="primary-btn acc-btn" id="googleSignIn" ${broken ? "disabled" : ""}>Войти через Google</button>
      ${broken ? `<button class="ghost-btn acc-btn acc-btn-second" id="retrySdk">Попробовать снова</button>` : ""}`;

    const btn = document.getElementById("googleSignIn");
    if (btn) btn.addEventListener("click", signInWithGoogle);

    const retry = document.getElementById("retrySdk");
    if (retry) retry.addEventListener("click", () => initSync());
    return;
  }

  const email = (session.user && session.user.email) || "аккаунт";
  root.innerHTML = `
    <div class="acc-row">
      <span class="acc-dot on"></span>
      <div>
        <div class="acc-title">${email}</div>
        <div class="acc-sub">Синхронизация включена. Изменения уходят на сервер автоматически.</div>
      </div>
    </div>
    <button class="ghost-btn acc-btn" id="signOutBtn">Выйти</button>`;
  document.getElementById("signOutBtn").addEventListener("click", signOut);
}

/* Если на устройстве уже есть отметки, а человек только что вошёл —
   предлагаем залить их, а не молча перезаписать. */
async function maybeOfferMigration() {
  if (!hasLocalData()) return;
  const ok = confirm("На этом устройстве уже есть отметки. Загрузить их в аккаунт?");
  if (ok) await pushAll();
}
