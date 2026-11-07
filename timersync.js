/* ─────────────────────────────────────────────────────────────
   timersync.js — время таймера считает сервер.

   Что было не так. «Сколько прошло» считал браузер: now() − startedAt.
   startedAt приходил с сервера (там же, где его поставил компьютер), а
   now() — это часы устройства. Телефон со сбитыми часами на 5 часов вперёд
   открывал уже идущий таймер и честно показывал +5 часов. Это время потом
   записывалось в минуты навсегда.

   Как теперь. Старт и стоп фиксирует Postgres: timer_start / timer_stop /
   timer_status. Сервер возвращает и своё «сейчас», поэтому клиент знает
   поправку своих часов (srvOffsetMs) и показывает верное время, даже если
   часы устройства врут. Минуты при остановке считает база и сама пишет их
   в строку дня — клиент получает готовое число.
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
    if (res) {
      noteServerNow(res.now);
      srvTimer = {
        block: res.block,
        date: res.date,
        startedAtIso: res.started_at,
        baseMin: Number(res.base_min) || 0,
        elapsedMin: Number(res.elapsed_min) || 0,
      };
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
