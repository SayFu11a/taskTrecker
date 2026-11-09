/* ─────────────────────────────────────────────────────────────
   timersync.js — таймер и отметки намаза живут на сервере.

   ЧАСТЬ 1. Время таймера считает сервер.
   «Сколько прошло» считал браузер: now() − startedAt. Телефон со сбитыми
   часами на 5 часов вперёд открывал идущий таймер и честно показывал
   +5 часов. Теперь старт и стоп фиксирует Postgres (timer_start /
   timer_stop / timer_status) и возвращает своё «сейчас», по нему клиент
   считает поправку своих часов (srvOffsetMs).

   ЧАСТЬ 2. Один хозяин таймера (новое).
   timer_start больше не затирает идущий таймер: если он уже идёт на другом
   устройстве, сервер отвечает created=false, а клиент берёт серверный
   старт и убирает свой локальный.

   ЧАСТЬ 3. Намаз отдельными строками (новое).
   Отметки больше не едут одним JSON в settings.namaz (два устройства
   перезаписывали друг друга, снятая галочка «воскресала»). Каждая отметка —
   строка namaz_marks, правка с временем, побеждает более поздняя.
   pushSettings / pullSettings / syncSoon из sync.js переопределены ниже,
   чтобы намаз шёл по новой дороге, а остальные настройки — как раньше.

   ЧАСТЬ 4. Живая сверка (новое).
   Realtime-подписка на timers и namaz_marks + опрос раз в 30 секунд +
   сверка при фокусе и возврате сети. Событие realtime — только сигнал
   «перечитай»: истину всегда берём с сервера. В профиле есть кнопка
   «Синхронизировать сейчас».
   ───────────────────────────────────────────────────────────── */

let srvOffsetMs = 0; // серверное время − время устройства
let srvTimer = null; // { block, date, startedAtIso, baseMin, elapsedMin }
let srvStopInFlight = false;
let srvSyncing = false;
let srvPullScheduled = false;

/* «Сейчас» по серверным часам. Пока поправки нет (офлайн) — обычные часы. */
function srvNowMs() {
  return Date.now() + srvOffsetMs;
}

function srvReady() {
  return typeof sb !== "undefined" && !!sb && typeof session !== "undefined" && !!session;
}

/* Поправка часов по серверному времени. Считаем один раз на ответ:
   задержка сети даёт доли секунды, на минуты это не влияет. */
function noteServerNow(iso) {
  const ts = Date.parse(iso || "");
  if (!Number.isFinite(ts)) return;
  srvOffsetMs = ts - Date.now();
}

async function timerRpc(name, args) {
  const { data, error } = await sb.rpc(name, args || {});
  if (error) throw error;
  return data || null;
}

/* ─────────── старт ─────────── */

async function timerStartRemote(block, date, baseMin) {
  if (!srvReady()) return null;
  try {
    const res = await timerRpc("timer_start", {
      p_block: block,
      p_date: date,
      p_base_min: Math.max(0, Math.round(Number(baseMin) || 0)),
    });
    if (!res) return null;

    noteServerNow(res.now);
    srvTimer = {
      block: res.block,
      date: res.date,
      startedAtIso: res.started_at,
      baseMin: Number(res.base_min) || 0,
      elapsedMin: Number(res.elapsed_min) || 0,
    };

    if (res.created === false) {
      /* Таймер уже идёт (на другом устройстве или это повторное нажатие).
         Сервер его не тронул — берём его старт, а локальный, который
         startTimer успел поставить до ответа, убираем. */
      const sameBlock = res.block === block && res.date === date;
      if (!sameBlock) dropLocalTimer(date, block);
      adoptServerTimer(res);
      if (!sameBlock && typeof toast === "function") {
        toast("Таймер уже идёт на другом устройстве. Останови его, потом запускай новый.");
      }
    } else {
      /* Фиксируем серверный старт сразу, не дожидаясь следующей сверки */
      adoptServerTimer(res);
    }
    return res;
  } catch (e) {
    /* без сети таймер всё равно работает — по локальным часам */
    console.warn("Серверный таймер не запустился, считаем локально", e);
    return null;
  }
}

/* ─────────── стоп ─────────── */

async function timerStopRemote() {
  if (!srvReady()) return null;
  try {
    const res = await timerRpc("timer_stop", {});
    if (!res) return null;
    noteServerNow(res.now);
    if (res.stopped) srvTimer = null;
    return res;
  } catch (e) {
    console.warn("Серверный стоп не прошёл, считаем локально", e);
    return null;
  }
}

/* ─────────── слияние с состоянием ─────────── */

/* Поставить в состояние серверный таймер (его старт — единственно верный). */
function adoptServerTimer(res) {
  if (typeof state === "undefined" || !res || !res.block || !res.date) return false;
  const dateKey = res.date;
  const block = res.block;
  const startedIso = res.started_at;
  const startedMs = Date.parse(startedIso || "");
  if (!Number.isFinite(startedMs)) return false;

  state.hours = state.hours || {};
  const day = state.hours[dateKey] || (state.hours[dateKey] = {});
  const cur = day[block];
  const curTimer = cur && cur.timer;
  const same =
    curTimer &&
    curTimer.byServer &&
    Math.abs(Date.parse(curTimer.startedAt) - startedMs) < 2000;
  if (same) return false;

  /* минуты берём локальные, но не меньше тех, что сервер записал при старте */
  const localMin = typeof blockRecord === "function" ? blockRecord(dateKey, block).min : 0;
  const min = Math.max(localMin, Number(res.base_min) || 0);
  day[block] = { min, timer: { startedAt: new Date(startedMs).toISOString(), byServer: true } };

  if (typeof saveLocalOnly === "function") saveLocalOnly();
  if (typeof renderAll === "function") renderAll();
  return true;
}

/* Убрать локальный (не серверный) таймер блока: сервер сказал, что хозяин
   таймера — другой. Минуты не трогаем. */
function dropLocalTimer(date, block) {
  const rec = state.hours && state.hours[date] && state.hours[date][block];
  if (!rec || !rec.timer || rec.timer.byServer) return false;
  const min = typeof blockRecord === "function" ? blockRecord(date, block).min : Number(rec.min) || 0;
  state.hours[date][block] = { min, stoppedAt: new Date(srvNowMs()).toISOString() };
  if (typeof saveLocalOnly === "function") saveLocalOnly();
  return true;
}

/* Сервер говорит «таймера нет» — гасим тот, что мы взяли с сервера.
   Минуты не трогаем: их уже записала база в строку дня, они придут подтяжкой. */
function dropServerTimer(stoppedIso) {
  if (typeof runningTimers !== "function" || typeof state === "undefined") return false;
  const list = runningTimers().filter((t) => {
    const rec = state.hours[t.date] && state.hours[t.date][t.block];
    return rec && rec.timer && rec.timer.byServer;
  });
  if (!list.length) return false;

  /* отложенный пуш мог держать устаревшее число минут — снимаем его */
  if (typeof pushTimer !== "undefined" && pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  const stamp = Number.isFinite(Date.parse(stoppedIso || "")) ? stoppedIso : new Date(srvNowMs()).toISOString();
  list.forEach((t) => {
    const min = typeof blockRecord === "function" ? blockRecord(t.date, t.block).min : 0;
    state.hours[t.date][t.block] = { min, stoppedAt: stamp };
  });
  if (typeof saveLocalOnly === "function") saveLocalOnly();
  if (typeof renderAll === "function") renderAll();
  return true;
}

/* Догрузить день после серверного стопа: минуты записала база.
   Сначала тянем, только потом пушим — иначе локальное (меньшее) число
   минут уехало бы на сервер и затёрло записанное. */
function schedulePullAfterStop() {
  if (srvPullScheduled) return;
  srvPullScheduled = true;
  setTimeout(() => {
    srvPullScheduled = false;
    if (typeof pullThenPush === "function") pullThenPush();
  }, 300);
}

/* ─────────── сверка с сервером ─────────── */

/* Вызывается при входе, при возврате во вкладку и при открытии на телефоне.
   Возвращает ответ сервера или null, если сети нет. */
async function timerSyncFromServer() {
  if (!srvReady() || srvSyncing) return null;
  srvSyncing = true;
  let res = null;
  try {
    res = await timerRpc("timer_status", {});
    if (!res) return null;
    noteServerNow(res.now);

    if (res.running) {
      srvTimer = {
        block: res.block,
        date: res.date,
        startedAtIso: res.started_at,
        baseMin: Number(res.base_min) || 0,
        elapsedMin: Number(res.elapsed_min) || 0,
      };
      adoptServerTimer(res);
    } else {
      const had = !!srvTimer;
      srvTimer = null;
      const dropped = dropServerTimer(res.now);
      if (dropped || had) schedulePullAfterStop();
    }
    return res;
  } catch (e) {
    console.warn("Состояние таймера с сервера не пришло", e);
    return null;
  } finally {
    srvSyncing = false;
  }
}

/* Сколько прошло по серверному таймеру — для проверок и подписей. */
function srvElapsedMin() {
  if (!srvTimer) return 0;
  const started = Date.parse(srvTimer.startedAtIso || "");
  if (!Number.isFinite(started)) return Number(srvTimer.elapsedMin) || 0;
  return Math.max(0, Math.floor((srvNowMs() - started) / 60000));
}

/* ═════════════════════════════════════════════════════════════
   НАМАЗ ОТДЕЛЬНЫМИ СТРОКАМИ + ЖИВАЯ СВЕРКА
   Всё внутри функции, чтобы имена не пересеклись с app.js и sync.js.
   Наружу выходят только переопределённые функции sync.js и liveSyncNow().
   ═════════════════════════════════════════════════════════════ */
(function () {
  const SHADOW_KEY = "vp-tracker-namaz-shadow-v1"; // что лежит на сервере: { "дата|молитва": 1 }
  const PENDING_KEY = "vp-tracker-namaz-pending-v1"; // неотправленные правки: { "дата|молитва": { done, at } }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  /* Когда правку сделали на этом устройстве — по отметке «дата|молитва».
     Нужно, чтобы правка без сети не проигрывала серверной копии, которая
     старше по времени: сравнение «кто позже нажал», а не «что пришло позже». */
  const AT_KEY = "vp-tracker-namaz-at-v1";
  const POLL_MS = 30000;
  const PAGE = 1000; // сервер отдаёт максимум 1000 строк за запрос

  const hasWindow = typeof window !== "undefined";

  function readJson(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
  function split(k) {
    const i = k.indexOf("|");
    return [k.slice(0, i), k.slice(i + 1)];
  }

  /* Отметки из state.namaz плоским набором: { "дата|молитва": 1 } */
  function localMarks() {
    const out = {};
    const ns = (typeof state !== "undefined" && state && state.namaz) || {};
    Object.keys(ns).forEach((date) => {
      const day = ns[date];
      if (!DATE_RE.test(date) || !day || typeof day !== "object") return;
      Object.keys(day).forEach((id) => {
        if (day[id]) out[date + "|" + id] = 1;
      });
    });
    return out;
  }

  /* ─────────── замечаем правки ─────────── */

  /* Сравниваем то, что сейчас в приложении, с тем, что, как мы знаем, лежит
     на сервере (shadow). Расхождение = правка, ставим ей время по серверным
     часам. Работает и без сети: очередь переживает перезагрузку. */
  function stamp() {
    if (typeof state === "undefined" || !state) return;
    const shadow = readJson(SHADOW_KEY);
    const pending = readJson(PENDING_KEY);
    const local = localMarks();
    const at = new Date(srvNowMs()).toISOString();
    const marksAt = readJson(AT_KEY);
    let changed = false;

    const keys = new Set([...Object.keys(local), ...Object.keys(shadow), ...Object.keys(pending)]);
    keys.forEach((k) => {
      const want = !!local[k];
      const op = pending[k];
      if (op) {
        if (op.done !== want) {
          pending[k] = { done: want, at };
          marksAt[k] = at;
          changed = true;
        }
      } else if (want !== !!shadow[k]) {
        pending[k] = { done: want, at };
        marksAt[k] = at;
        changed = true;
      }
    });
    if (changed) {
      writeJson(PENDING_KEY, pending);
      writeJson(AT_KEY, marksAt);
    }
  }

  /* ─────────── отправка очереди ─────────── */

  let flushing = false;

  async function flush() {
    if (!srvReady() || flushing) return false;
    stamp();
    const pending = readJson(PENDING_KEY);
    const keys = Object.keys(pending);
    if (!keys.length) return true;

    flushing = true;
    try {
      for (const k of keys) {
        const op = pending[k];
        const [date, prayer] = split(k);
        const { data, error } = await sb.rpc("namaz_set", {
          p_date: date,
          p_prayer: prayer,
          p_done: !!op.done,
          p_at: op.at,
        });
        if (error) throw error;

        /* Убираем из очереди только если её не успели поменять, пока шёл запрос */
        const cur = readJson(PENDING_KEY);
        if (cur[k] && cur[k].at === op.at && cur[k].done === op.done) delete cur[k];
        writeJson(PENDING_KEY, cur);

        /* Решение сервера: если там правка новее нашей, done придёт другим */
        const finalDone = data && typeof data.done === "boolean" ? data.done : !!op.done;
        const sh = readJson(SHADOW_KEY);
        if (finalDone) sh[k] = 1;
        else delete sh[k];
        writeJson(SHADOW_KEY, sh);

        /* Сервер решил иначе (его копия новее) — подчиняемся и запоминаем
           это время, чтобы следующая сверка не спорила снова. */
        if (finalDone !== !!op.done) {
          const [fdate, fprayer] = split(k);
          if (fdate && typeof state !== "undefined" && state) {
            state.namaz = state.namaz || {};
            if (finalDone) {
              (state.namaz[fdate] = state.namaz[fdate] || {})[fprayer] = true;
            } else if (state.namaz[fdate]) {
              delete state.namaz[fdate][fprayer];
              if (!Object.keys(state.namaz[fdate]).length) delete state.namaz[fdate];
            }
          }
          const ats = readJson(AT_KEY);
          const srvAt = data && data.updated_at ? String(data.updated_at) : at;
          ats[k] = srvAt;
          writeJson(AT_KEY, ats);
        }
      }
      return true;
    } catch (e) {
      console.warn("Отметки намаза не ушли, попробуем позже", e);
      return false;
    } finally {
      flushing = false;
    }
  }

  /* ─────────── чтение с сервера ─────────── */

  function sameKeys(a, b) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => k in b);
  }

  async function pull() {
    if (!srvReady()) return false;
    try {
      stamp(); // правки, сделанные до запроса

      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from("namaz_marks")
          .select("date,prayer,done,updated_at")
          .eq("user_id", session.user.id)
          .order("date")
          .order("prayer")
          .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }

      stamp(); // и сделанные, пока шёл запрос: иначе перезапись их сотрёт

      const server = {};
      rows.forEach((r) => {
        if (r.done) server[r.date + "|" + r.prayer] = 1;
      });
      writeJson(SHADOW_KEY, server);

      /* Результат = сервер + ещё не ушедшие локальные правки поверх */
      const want = { ...server };
      const pending = readJson(PENDING_KEY);
      const marksAt = readJson(AT_KEY);
      Object.keys(pending).forEach((k) => {
        if (pending[k].done) want[k] = 1;
        else delete want[k];
      });

      /* Правка, которую уже отправили, но ответ сервера ещё не пришёл к нам
         в виде pending: если она сделана позже серверной, она тоже главнее.
         Иначе снятая галочка воскресала при каждой сверке. */
      Object.keys(marksAt).forEach((k) => {
        if (pending[k]) return; // уже учтено выше
        const [date, prayer] = split(k);
        const mine = Date.parse(marksAt[k]);
        if (!Number.isFinite(mine)) return;
        const srvRow = rows.find((r) => r.date === date && r.prayer === prayer);
        const srvAt = srvRow && srvRow.updated_at ? Date.parse(srvRow.updated_at) : 0;
        if (Number.isFinite(srvAt) && srvAt > mine) return; // сервер новее — его воля
        const localNow = localMarks()[k];
        if (localNow) want[k] = 1;
        else delete want[k];
      });

      if (sameKeys(localMarks(), want)) return true;

      /* Правим state.namaz на месте: лишнее булево убираем, недостающее ставим */
      state.namaz = state.namaz || {};
      Object.keys(state.namaz).forEach((date) => {
        const day = state.namaz[date];
        if (!day || typeof day !== "object") return;
        Object.keys(day).forEach((id) => {
          if (typeof day[id] === "boolean" && !want[date + "|" + id]) delete day[id];
        });
        if (!Object.keys(day).length) delete state.namaz[date];
      });
      Object.keys(want).forEach((k) => {
        const [date, id] = split(k);
        (state.namaz[date] = state.namaz[date] || {})[id] = true;
      });

      if (typeof saveLocalOnly === "function") saveLocalOnly();
      if (typeof renderAll === "function") renderAll();
      return true;
    } catch (e) {
      console.warn("Отметки намаза с сервера не пришли", e);
      return false;
    }
  }

  /* Сначала отправить своё, потом забрать чужое. Параллельные вызовы
     (событие realtime + опрос + кнопка) схлопываются в один повторный. */
  let busy = false;
  let again = false;
  async function namazSync() {
    if (!srvReady()) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await flush();
        await pull();
      } while (again);
    } finally {
      busy = false;
    }
  }

  /* ─────────── переопределяем функции sync.js ─────────── */

  /* syncSoon: перед отправкой замечаем правки намаза */
  if (typeof syncSoon === "function") {
    const origSyncSoon = syncSoon;
    syncSoon = function () {
      try {
        stamp();
      } catch (e) {
        console.warn("Не удалось заметить правки намаза", e);
      }
      return origSyncSoon.apply(this, arguments);
    };
  }

  /* pushSettings: то же, что в sync.js, но БЕЗ намаза (он едет через namaz_set).
     Колонка settings.namaz не указана в upsert — значит, не перезаписывается. */
  if (typeof pushSettings === "function") {
    pushSettings = async function () {
      if (!sb || !session) return;
      try {
        await flush();
        const { error } = await sb.from("settings").upsert(
          {
            user_id: session.user.id,
            week: state.week,
            schedule_view: state.scheduleView,
            achievements: state.achievements || {},
            leetcode: state.leetcode || [],
            namaz_on: state.namazOn !== false,
            gym: state.gym || {},
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
        if (error) {
          console.warn("Настройки не ушли", error);
          lastAuthError = "Настройки не сохранились на сервере: " + (error.message || "ошибка");
          renderAccount();
        }
      } catch (e) {
        console.warn("Настройки не ушли", e);
      }
    };
  }

  /* pullSettings: то же, что в sync.js, но намаз берём из namaz_marks, а не
     «объединением» JSON (оно не умело снимать галочки). */
  if (typeof pullSettings === "function") {
    pullSettings = async function () {
      if (!sb || !session) return;
      try {
        await namazSync();
      } catch (e) {
        console.warn("Намаз не сверился", e);
      }
      try {
        const { data } = await sb.from("settings").select("*").eq("user_id", session.user.id).maybeSingle();
        if (!data) {
          await pushSettings();
          return;
        }
        if (typeof data.week === "number") state.week = data.week;
        if (data.schedule_view) state.scheduleView = data.schedule_view;
        if (data.achievements && Object.keys(data.achievements).length) {
          state.achievements = { ...(state.achievements || {}), ...data.achievements };
        }
        if (Array.isArray(data.leetcode) && data.leetcode.length) state.leetcode = data.leetcode;
        if (typeof data.namaz_on === "boolean") state.namazOn = data.namaz_on;
        if (data.gym && typeof data.gym === "object" && !Array.isArray(data.gym)) {
          state.gym = mergeGym(state.gym || {}, data.gym);
        }
        saveLocalOnly();
        renderAll();
      } catch (e) {
        console.warn("Настройки не пришли", e);
      }
    };
  }

  /* ─────────── живая сверка ─────────── */

  let channel = null;
  let channelUser = null;
  let liveState = "off"; // SUBSCRIBED | CHANNEL_ERROR | TIMED_OUT | CLOSED | off
  let lastSyncAt = 0;
  let timerSoon = 0;
  let namazSoon = 0;

  function touch() {
    lastSyncAt = Date.now();
    paintStatus();
  }

  async function syncTimerNow() {
    await timerSyncFromServer();
    touch();
  }
  async function syncNamazNow() {
    await namazSync();
    touch();
  }

  function stopLive() {
    if (channel && typeof sb !== "undefined" && sb) {
      try {
        sb.removeChannel(channel);
      } catch {
        /* ignore */
      }
    }
    channel = null;
    channelUser = null;
    liveState = "off";
    paintStatus();
  }

  function ensureLive() {
    if (!srvReady()) {
      if (channel) stopLive();
      return;
    }
    const uid = session.user && session.user.id;
    if (channel && channelUser === uid) return;
    stopLive();
    try {
      channelUser = uid;
      channel = sb
        .channel("tracker-live-" + uid)
        .on("postgres_changes", { event: "*", schema: "public", table: "timers" }, () => {
          clearTimeout(timerSoon);
          timerSoon = setTimeout(syncTimerNow, 250);
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "namaz_marks" }, () => {
          clearTimeout(namazSoon);
          namazSoon = setTimeout(syncNamazNow, 250);
        })
        .subscribe((status) => {
          liveState = status;
          paintStatus();
        });
    } catch (e) {
      console.warn("Живая связь не поднялась, остаётся опрос", e);
      channel = null;
      channelUser = null;
    }
  }

  /* Опрос — страховка на случай, если websocket уснул (телефон в кармане) */
  function poll() {
    if (!srvReady()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    syncTimerNow();
    syncNamazNow();
  }

  /* ─────────── кнопка «Синхронизировать сейчас» ─────────── */

  async function liveSyncNow() {
    const btn = document.getElementById("liveSyncBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Синхронизирую…";
    }
    try {
      if (typeof pullThenPush === "function") await pullThenPush();
      await syncTimerNow();
      await syncNamazNow();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Синхронизировать сейчас";
      }
    }
  }
  if (hasWindow) window.liveSyncNow = liveSyncNow;

  function statusText() {
    const live = liveState === "SUBSCRIBED" ? "живая связь есть" : "живой связи нет, опрос раз в 30 с";
    let when = "";
    if (lastSyncAt) {
      const d = new Date(lastSyncAt);
      when = " · сверка в " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    return "Синхронизация v2: " + live + when;
  }

  function paintStatus() {
    if (typeof document === "undefined") return;
    const el = document.getElementById("liveSyncStatus");
    if (el) el.textContent = statusText();
  }

  /* Дописываем кнопку и статус под блок аккаунта (renderAccount перерисовывает
     его целиком, поэтому оборачиваем её, а не вставляем один раз) */
  function decorateAccount() {
    if (typeof session === "undefined" || !session) return;
    const root = document.getElementById("accountBox");
    if (!root || document.getElementById("liveSyncBox")) return;
    const box = document.createElement("div");
    box.id = "liveSyncBox";
    box.style.marginTop = "10px";
    box.innerHTML =
      '<button class="ghost-btn acc-btn acc-btn-second" id="liveSyncBtn">Синхронизировать сейчас</button>' +
      '<div class="acc-sub" id="liveSyncStatus" style="margin-top:6px"></div>';
    root.appendChild(box);
    box.querySelector("#liveSyncBtn").addEventListener("click", liveSyncNow);
    paintStatus();
  }

  if (typeof renderAccount === "function") {
    const origRenderAccount = renderAccount;
    renderAccount = function () {
      const r = origRenderAccount.apply(this, arguments);
      try {
        decorateAccount();
      } catch (e) {
        console.warn("Кнопка синхронизации не нарисовалась", e);
      }
      return r;
    };
  }

  /* ─────────── запуск ─────────── */

  if (hasWindow) {
    setInterval(ensureLive, 2500); // подписываемся, как только появится сессия
    setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    window.addEventListener("pageshow", poll);
    window.addEventListener("online", poll);
  }

  /* для проверок в тестах */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { stamp, flush, pull, namazSync, localMarks };
  }
})();
