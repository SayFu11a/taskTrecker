/* ⚠ Это стенд ИСХОДНОГО бага: ниже дословно скопирован СТАРЫЙ код
   app.js/timersync.js (до исправления). Он нужен, чтобы показать, как баг
   выглядел (0 минут на экране, воскресание таймера). Текущий код проверяет
   `node tests/run-tests.mjs` — там настоящие файлы из корня репозитория. */

/* Прогон реального кода таймера (app.js + timersync.js + sync.js) против поддельного сервера.
   Код функций скопирован дословно, заглушены только DOM, звук, сеть и часы. */
const RealDate = Date; let skew = 0;
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + skew); } static now() { return RealDate.now() + skew; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = []; const t0 = RealDate.now();
const log = (...a) => LOG.push(((RealDate.now() - t0) + "").padStart(5) + " мс  " + a.join(" "));

/* ── localStorage / окружение ── */
global.localStorage = { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
global.window = global; global.document = { hidden: false, getElementById: () => null, addEventListener() {} };

/* ── поддельный сервер: SQL timer_* перенесён один в один ── */
const SRV = { timers: null, days: {}, latency: 150, calls: [] };
const pg = () => new RealDate(RealDate.now() + skew);
function rpc(name, args) {
  return new Promise((resolve) => setTimeout(() => {
    const now = pg(); let out;
    if (name === "timer_start") {
      let created = false;
      if (!SRV.timers) { SRV.timers = { block: args.p_block, date: args.p_date, started_at: now.toISOString(), base_min: Math.max(args.p_base_min || 0, 0) }; created = true; }
      const t = SRV.timers; out = { created, block: t.block, date: t.date, started_at: t.started_at, base_min: t.base_min, now: now.toISOString(), elapsed_min: Math.floor((now - new RealDate(t.started_at)) / 60000) };
    } else if (name === "timer_status") {
      const t = SRV.timers; out = t ? { running: true, block: t.block, date: t.date, started_at: t.started_at, base_min: t.base_min, now: now.toISOString(), elapsed_min: Math.floor((now - new RealDate(t.started_at)) / 60000) } : { running: false, now: now.toISOString() };
    } else if (name === "timer_stop") {
      const t = SRV.timers; if (!t) out = { stopped: false, now: now.toISOString() };
      else {
        let el = Math.max(0, Math.min(720, Math.floor((now - new RealDate(t.started_at)) / 60000)));
        const stored = ((SRV.days[t.date] || {}).hours || {})[t.block]; const total = Math.max((stored && stored.min) || 0, t.base_min) + el;
        const minAt = now.getTime();
        SRV.days[t.date] = { hours: Object.assign({}, (SRV.days[t.date] || {}).hours || {}, { [t.block]: { min: total, minAt } }) };
        SRV.timers = null; out = { stopped: true, block: t.block, date: t.date, min: total, elapsed_min: el, now: now.toISOString(), min_at: minAt };
      }
    }
    SRV.calls.push(name); resolve({ data: out, error: null });
  }, SRV.latency));
}
const q = (table) => { const api = { select() { return api; }, eq() { return api; }, then(res) { return new Promise((r) => setTimeout(() => r({ data: Object.keys(SRV.days).map((d) => ({ date: d, hours: SRV.days[d].hours, blocks: null, mode: null, updated_at: pg().toISOString() })), error: null }), SRV.latency)).then(res); } }; return api; };
global.sb = { rpc, from: (t) => ({ select: () => q(t), upsert: (rows) => new Promise((r) => setTimeout(() => { rows.forEach((row) => { SRV.days[row.date] = { hours: row.hours }; }); SRV.calls.push("days.upsert"); r({ error: null }); }, SRV.latency)) }) };
global.session = { user: { id: "u1" } };

/* ───────── app.js (дословно, кроме load/render) ───────── */
const STORE_KEY = "vp-tracker-v1";
const cloneDeep = (o) => JSON.parse(JSON.stringify(o));
global.state = { days: {}, modes: {}, gym: {}, hours: {}, minAt: {}, namaz: {}, meta: {}, leetcode: [] };
function blockRecord(dateKey, blockId) {
  const day = (state.hours || {})[dateKey];
  const rec = day ? day[blockId] : null;
  if (rec === undefined || rec === null) return { min: 0, timer: null, stoppedAt: null, minAt: 0 };
  if (typeof rec === "number") return { min: rec, timer: null, stoppedAt: null, minAt: 0 };
  const at = Number(rec.minAt) || (typeof state !== "undefined" && state.minAt ? Number((state.minAt[dateKey] || {})[blockId]) : 0) || 0;
  return { min: Number(rec.min) || 0, timer: rec.timer || null, stoppedAt: rec.stoppedAt || null, minAt: at };
}
function timerFor(dateKey, blockId) { const t = blockRecord(dateKey, blockId).timer; if (!t || !t.startedAt) return null; const ts = new Date(t.startedAt).getTime(); if (!Number.isFinite(ts)) return null; return { startedAt: ts, startedAtIso: new Date(ts).toISOString() }; }
function runningTimers() { const out = []; Object.keys(state.hours || {}).forEach((dateKey) => { const day = state.hours[dateKey] || {}; Object.keys(day).forEach((blockId) => { const t = timerFor(dateKey, blockId); if (t) out.push({ date: dateKey, block: blockId, startedAt: t.startedAt, startedAtIso: t.startedAtIso }); }); }); return out; }
function writeMinutes(dateKey, blockId, minutes, opts) {
  if (!state.hours) state.hours = {};
  const day = state.hours[dateKey] || (state.hours[dateKey] = {});
  const next = Math.max(0, Math.round(minutes || 0));
  const prev = blockRecord(dateKey, blockId);
  const timer = prev.timer;
  const prevAt = prev.minAt || 0;
  let at = opts && Number.isFinite(opts.at) ? opts.at : stampNow();
  if (at <= prevAt) at = prevAt + 1;
  touchMinutes(dateKey, blockId, at);
  if (timer) day[blockId] = { min: next, timer, minAt: at };
  else if (prev.stoppedAt) day[blockId] = { min: next, stoppedAt: prev.stoppedAt, minAt: at };
  else day[blockId] = { min: next, minAt: at };
  if (!Object.keys(day).length) delete state.hours[dateKey];
  if (!opts || !opts.quiet) touchDay(dateKey);
  save();
}
function touchMinutes(dateKey, blockId, atMs) { if (!state.minAt) state.minAt = {}; const day = state.minAt[dateKey] || (state.minAt[dateKey] = {}); const at = Number.isFinite(atMs) ? atMs : stampNow(); day[blockId] = at; return at; }
function setBlockTimer(dateKey, blockId, startedAtIso) {
  if (!state.hours) state.hours = {};
  const day = state.hours[dateKey] || (state.hours[dateKey] = {});
  const prev = blockRecord(dateKey, blockId); const min = prev.min;
  const mark = prev.timer && prev.timer.byServer;
  if (!min && !startedAtIso) day[blockId] = { min: 0, stoppedAt: new Date().toISOString() };
  else day[blockId] = startedAtIso ? { min, timer: mark ? { startedAt: startedAtIso, byServer: true } : { startedAt: startedAtIso } } : { min, stoppedAt: new Date().toISOString() };
  if (!Object.keys(day).length) delete state.hours[dateKey];
  touchDay(dateKey); save();
}
const TIMER_MAX_MIN = 12 * 60; var booting = false;
function saveLocalOnly() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function stampNow() { return typeof srvNowMs === "function" ? srvNowMs() : Date.now(); }
function save() { saveLocalOnly(); if (booting) return; if (typeof syncSoon === "function") syncSoon(); }
const keyOf = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const todayKey = () => keyOf(new Date());
const fmtMinutes = (m) => `${Math.round(m)} мин`;
function blockMinutes(rec) { if (rec === undefined || rec === null) return 0; if (typeof rec === "number") return rec; return Number(rec.min) || 0; }
function savedMinutesFor(dateKey, blockId) { const day = (state.hours || {})[dateKey] || {}; if (!blockId) return Object.keys(day).reduce((s, id) => s + blockMinutes(day[id]), 0); return blockMinutes(day[blockId]); }
function runningMinutesFor(dateKey, blockId) { const t = timerFor(dateKey, blockId); if (!t) return 0; const rec = blockRecord(dateKey, blockId); const byServer = rec.timer && rec.timer.byServer && typeof srvNowMs === "function"; const now = byServer ? srvNowMs() : Date.now(); return Math.max(0, Math.floor((now - t.startedAt) / 60000)); }
function hoursFor(dateKey, blockId) { const saved = savedMinutesFor(dateKey, blockId); if (!blockId) { const day = (state.hours || {})[dateKey] || {}; return saved + Object.keys(day).reduce((s, id) => s + runningMinutesFor(dateKey, id), 0); } return saved + runningMinutesFor(dateKey, blockId); }
function touchDay(key) { if (!state.meta) state.meta = {}; state.meta[key] = stampNow(); }
var selectedDate = todayKey();
const blockName = (id) => id; const toast = (m) => log("TOAST:", m); const play = () => {}; const tabAnnounce = () => {};
let UI = null; /* что сейчас нарисовано на экране в карточке блока */
function renderAll() { UI = hoursFor(selectedDate, "jobs"); log("renderAll → на экране:", UI, "мин"); }

function startTimer(blockId) {
  const running = runningTimers(); if (running.length) { toast("Уже идёт таймер"); return; }
  const baseMin = savedMinutesFor(selectedDate, blockId);
  if (typeof timerStartRemote === "function") timerStartRemote(blockId, selectedDate, baseMin);
  setBlockTimer(selectedDate, blockId, new Date().toISOString());
  renderAll();
}
function stopTimer(dateKey, blockId) {
  const targets = []; if (blockId) targets.push({ date: dateKey || selectedDate, block: blockId }); else runningTimers().forEach((t) => targets.push({ date: t.date, block: t.block }));
  if (!targets.length) return;
  const isServer = ({ date, block }) => { const rec = blockRecord(date, block); return !!(rec.timer && rec.timer.byServer); };
  const serverTargets = targets.filter(isServer); const localTargets = targets.filter((t) => !isServer(t));
  if (serverTargets.length && typeof timerStopRemote === "function") {
    timerStopRemote().then((res) => {
      if (!res || !res.stopped) { log("stop: ответ без stopped →", JSON.stringify(res)); return; }
      if (Number.isFinite(Number(res.min))) {
        const at = Number(res.min_at) || (typeof srvNowMs === "function" ? srvNowMs() : Date.now());
        touchMinutes(res.date, res.block, at);
        writeMinutes(res.date, res.block, Number(res.min), { at });
      }
      if (Number(res.elapsed_min) >= 1) toast(`Записано ${fmtMinutes(res.elapsed_min)}.`);
    });
    serverTargets.forEach(({ date, block }) => setBlockTimer(date, block, null));
  }
  let total = 0;
  localTargets.forEach(({ date, block }) => { const t = timerFor(date, block); if (!t) return; let min = Math.round((Date.now() - t.startedAt) / 60000); const rec = blockRecord(date, block); setBlockTimer(date, block, null); if (min >= 1) { writeMinutes(date, block, rec.min + min); total += min; } else writeMinutes(date, block, rec.min); });
  renderAll();
}

/* ───────── timersync.js, часть 1 (дословно) ───────── */
let srvOffsetMs = 0; let srvTimer = null; let srvStopInFlight = false; let srvSyncing = false; let srvPullScheduled = false;
function srvNowMs() { return Date.now() + srvOffsetMs; }
function srvReady() { return typeof sb !== "undefined" && !!sb && typeof session !== "undefined" && !!session; }
function noteServerNow(iso) { const ts = Date.parse(iso || ""); if (!Number.isFinite(ts)) return; srvOffsetMs = ts - Date.now(); }
async function timerRpc(name, args) { const { data, error } = await sb.rpc(name, args || {}); if (error) throw error; return data || null; }
async function timerStartRemote(block, date, baseMin) {
  if (!srvReady()) return null;
  try {
    const res = await timerRpc("timer_start", { p_block: block, p_date: date, p_base_min: Math.max(0, Math.round(Number(baseMin) || 0)) });
    if (!res) return null;
    noteServerNow(res.now);
    srvTimer = { block: res.block, date: res.date, startedAtIso: res.started_at, baseMin: Number(res.base_min) || 0, elapsedMin: Number(res.elapsed_min) || 0 };
    if (res.created === false) { const sameBlock = res.block === block && res.date === date; if (!sameBlock) dropLocalTimer(date, block); adoptServerTimer(res); } else { adoptServerTimer(res); }
    return res;
  } catch (e) { return null; }
}
async function timerStopRemote() {
  if (!srvReady()) return null;
  try { const res = await timerRpc("timer_stop", {}); if (!res) return null; noteServerNow(res.now); if (res.stopped) srvTimer = null; return res; } catch (e) { return null; }
}
function adoptServerTimer(res) {
  if (typeof state === "undefined" || !res || !res.block || !res.date) return false;
  const dateKey = res.date; const block = res.block; const startedIso = res.started_at; const startedMs = Date.parse(startedIso || "");
  if (!Number.isFinite(startedMs)) return false;
  state.hours = state.hours || {}; const day = state.hours[dateKey] || (state.hours[dateKey] = {}); const cur = day[block]; const curTimer = cur && cur.timer;
  const same = curTimer && curTimer.byServer && Math.abs(Date.parse(curTimer.startedAt) - startedMs) < 2000;
  if (same) return false;
  const localMin = typeof blockRecord === "function" ? blockRecord(dateKey, block).min : 0; const min = Math.max(localMin, Number(res.base_min) || 0);
  day[block] = { min, timer: { startedAt: new Date(startedMs).toISOString(), byServer: true } };
  log("adoptServerTimer: взял серверный таймер в state");
  saveLocalOnly(); renderAll(); return true;
}
function dropLocalTimer(date, block) { const rec = state.hours && state.hours[date] && state.hours[date][block]; if (!rec || !rec.timer || rec.timer.byServer) return false; const min = blockRecord(date, block).min; state.hours[date][block] = { min, stoppedAt: new Date(srvNowMs()).toISOString() }; saveLocalOnly(); return true; }
function dropServerTimer(stoppedIso) {
  const list = runningTimers().filter((t) => { const rec = state.hours[t.date] && state.hours[t.date][t.block]; return rec && rec.timer && rec.timer.byServer; });
  if (!list.length) return false;
  if (typeof pushTimer !== "undefined" && pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const stamp = Number.isFinite(Date.parse(stoppedIso || "")) ? stoppedIso : new Date(srvNowMs()).toISOString();
  list.forEach((t) => { const min = blockRecord(t.date, t.block).min; state.hours[t.date][t.block] = { min, stoppedAt: stamp }; });
  log("dropServerTimer: погасил таймер, min в state =", blockRecord(selectedDate, "jobs").min);
  saveLocalOnly(); renderAll(); return true;
}
function schedulePullAfterStop() { if (srvPullScheduled) return; srvPullScheduled = true; setTimeout(() => { srvPullScheduled = false; if (typeof pullThenPush === "function") pullThenPush(); }, 300); }
async function timerSyncFromServer() {
  if (!srvReady() || srvSyncing) return null; srvSyncing = true; let res = null;
  try {
    res = await timerRpc("timer_status", {}); if (!res) return null; noteServerNow(res.now);
    if (res.running) { srvTimer = { block: res.block, date: res.date, startedAtIso: res.started_at, baseMin: Number(res.base_min) || 0, elapsedMin: Number(res.elapsed_min) || 0 }; adoptServerTimer(res); }
    else { const had = !!srvTimer; srvTimer = null; const dropped = dropServerTimer(res.now); if (dropped || had) schedulePullAfterStop(); }
    return res;
  } catch (e) { return null; } finally { srvSyncing = false; }
}

/* ───────── sync.js (дословно) ───────── */
let syncBusy = false; let pushTimer = null;
function stateToRows(userId) {
  const meta = state.meta || {};
  const dates = Object.keys(state.hours || {}).filter((d) => Object.keys(state.hours[d] || {}).length > 0);
  return dates.map((date) => ({ user_id: userId, date, hours: normalizeDayForDb(state.hours[date]), mode: null, updated_at: new Date(meta[date] || Date.now()).toISOString() }));
}
function normalizeDayForDb(day) {
  const out = {};
  Object.keys(day || {}).forEach((id) => {
    const rec = day[id]; if (typeof rec === "number") { if (rec > 0) out[id] = { min: rec }; return; } if (!rec) return;
    const min = Number(rec.min) || 0; const startedAt = rec.timer && rec.timer.startedAt; const minAt = Number(rec.minAt) || 0;
    if (!min && !startedAt && !minAt && !rec.stoppedAt) return;
    out[id] = { min }; if (startedAt) { out[id].timer = { startedAt }; if (rec.timer && rec.timer.byServer) out[id].timer.byServer = true; }
    if (minAt) out[id].minAt = minAt; if (rec.stoppedAt) out[id].stoppedAt = rec.stoppedAt;
  });
  return out;
}
function mergeDay(localDay, remoteDay, localAt, remoteAt) {
  const out = {}; const local = localDay || {}; const remote = remoteDay || {}; const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  ids.forEach((id) => {
    const a = local[id]; const b = remote[id];
    const aMin = typeof a === "number" ? a : (a && Number(a.min)) || 0; const bMin = typeof b === "number" ? b : (b && Number(b.min)) || 0;
    const aAt = Number(a && a.minAt) || Number((localAt || {})[id]) || 0; const bAt = Number(b && b.minAt) || Number((remoteAt || {})[id]) || 0;
    let min; if (aAt && bAt && aAt !== bAt) min = aAt > bAt ? aMin : bMin; else min = aAt || bAt ? (aAt >= bAt ? aMin : bMin) : Math.max(aMin, bMin);
    const minAt = Math.max(aAt, bAt) || 0;
    const aTimer = a && a.timer && a.timer.startedAt; const bTimer = b && b.timer && b.timer.startedAt;
    const timers = [aTimer, bTimer].filter(Boolean).map((x) => new Date(x).getTime()).filter(Number.isFinite);
    const startedAt = timers.length ? Math.min(...timers) : null;
    const byServer = Boolean((a && a.timer && a.timer.byServer) || (b && b.timer && b.timer.byServer));
    const stops = [a && a.stoppedAt, b && b.stoppedAt].filter(Boolean).map((x) => new Date(x).getTime()).filter(Number.isFinite);
    const stoppedAt = stops.length ? Math.max(...stops) : null; const isOff = stoppedAt && (!startedAt || stoppedAt >= startedAt);
    if (!min && !startedAt && !stoppedAt && !minAt) return;
    if (isOff) out[id] = { min, stoppedAt: new Date(stoppedAt).toISOString() };
    else if (startedAt) { out[id] = { min, timer: { startedAt: new Date(startedAt).toISOString() } }; if (byServer) out[id].timer.byServer = true; }
    else out[id] = { min };
    if (minAt) out[id].minAt = minAt;
  });
  return out;
}
function mergeRowsIntoState(rows) {
  state.modes = state.modes || {}; state.meta = state.meta || {}; state.hours = state.hours || {};
  rows.forEach((row) => {
    const remoteTs = new Date(row.updated_at).getTime() || 0; const localTs = state.meta[row.date] || 0;
    let remoteHours = row.hours;
    const merged = mergeDay(state.hours[row.date], remoteHours, (state.minAt || {})[row.date], null);
    if (Object.keys(merged).length) {
      state.hours[row.date] = merged;
      if (!state.minAt) state.minAt = {}; const dayAt = state.minAt[row.date] || (state.minAt[row.date] = {});
      Object.keys(merged).forEach((id) => { const at = Number(merged[id] && merged[id].minAt) || 0; if (at > (Number(dayAt[id]) || 0)) dayAt[id] = at; });
      if (!Object.keys(dayAt).length) delete state.minAt[row.date];
    }
    if (remoteTs > localTs) state.meta[row.date] = remoteTs;
  });
}
async function pullSettings() {} async function pushSettings() {}
async function pullThenPush() {
  if (!sb || !session) return; if (syncBusy) { log("pullThenPush: пропущен (syncBusy)"); return; } syncBusy = true;
  try {
    log("pullThenPush: старт");
    const { data } = await sb.from("days").select();
    if (data && data.length) { mergeRowsIntoState(data); saveLocalOnly(); renderAll(); }
    await pushAll(); await pullSettings();
    if (typeof timerSyncFromServer === "function") await timerSyncFromServer();
  } finally { syncBusy = false; }
}
async function pushAll() {
  if (!sb || !session) return;
  if (typeof timerSyncFromServer === "function" && typeof srvTimer === "object") { try { await timerSyncFromServer(); } catch {} }
  const rows = stateToRows(session.user.id); if (!rows.length) return;
  log("push days: min на отправку =", JSON.stringify(rows[0].hours.jobs));
  await sb.from("days").upsert(rows);
}
function syncSoon() {
  if (!sb || !session) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => { try { await pushAll(); await pushSettings(); } catch (e) {} }, 1200);
}

/* ───────── сценарий ───────── */
async function scenario(name, { latency, pullDuringStop }) {
  LOG.length = 0; SRV.latency = latency; SRV.timers = null; SRV.days = {}; state.hours = {}; state.minAt = {}; state.meta = {}; srvTimer = null; srvOffsetMs = 0; skew = 0; syncBusy = false; pushTimer = null;
  console.log("\n═══ " + name + " (задержка сети " + latency + " мс) ═══");
  startTimer("jobs"); await sleep(latency * 3 + 50);
  skew += 40 * 60000; log("— прошло 40 минут —"); await sleep(10);
  log("перед стопом на экране:", hoursFor(selectedDate, "jobs"), "мин");
  if (pullDuringStop) pullThenPush(); /* вернулись во вкладку: идёт синк */
  await sleep(pullDuringStop ? 20 : 0);
  log(">>> КЛИК «СТОП»");
  stopTimer(selectedDate, "jobs");
  await sleep(latency * 8 + 2500);
  log("итог: state =", JSON.stringify(blockRecord(selectedDate, "jobs")), "| на экране последний раз:", UI, "мин | на сервере:", JSON.stringify((SRV.days[selectedDate] || {}).hours));
  console.log(LOG.join("\n"));
}
(async () => {
  await scenario("А. обычная сеть", { latency: 150, pullDuringStop: false });
  await scenario("Б. медленная сеть (телефон)", { latency: 900, pullDuringStop: false });
  await scenario("В. стоп во время фоновой синхронизации", { latency: 400, pullDuringStop: true });
  process.exit(0);
})();
