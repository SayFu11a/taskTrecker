// Поддельный Supabase + управляемые часы для проверки реального кода трекера.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";

/* Корень репозитория — рядом с этим файлом, чтобы тесты работали из любого места. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") + path.sep;
export const FILES = ["data.js","namaz.js","sound.js","achievements.js","sync.js","timersync.js","tabsync.js","push.js","app.js","diary.js","levels.js","glass.js"];

/* ───── сервер ───── */
export function makeServer(clockRef = null) {
  const S = {
    timers: null,          // { block, date, started_at, base_min }
    days: {},              // date -> { hours, mode, updated_at }
    settings: null,
    namaz: {},             // "date|prayer" -> { done, updated_at }
    subs: [],              // push_subscriptions
    calls: [],             // [{ name, at, args }]
    latency: 40,
    skewRef: clockRef || { skew: 0 },
    now: () => new Date(Date.now() + (S.skewRef ? S.skewRef.skew : 0)),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ts = () => S.now().toISOString();
  const el = (t) => Math.max(0, Math.min(720, Math.floor((S.now() - new Date(t)) / 60000)));

  function rpc(name, args = {}) {
    S.calls.push({ name, at: Date.now(), args });
    return sleep(S.latency).then(() => {
      if (name === "timer_start") {
        let created = false;
        if (!S.timers) { S.timers = { block: args.p_block, date: args.p_date, started_at: ts(), base_min: Math.max(args.p_base_min || 0, 0) }; created = true; }
        const t = S.timers;
        return { data: { created, block: t.block, date: t.date, started_at: t.started_at, base_min: t.base_min, now: ts(), elapsed_min: el(t.started_at) }, error: null };
      }
      if (name === "timer_status") {
        const t = S.timers;
        return { data: t ? { running: true, block: t.block, date: t.date, started_at: t.started_at, base_min: t.base_min, now: ts(), elapsed_min: el(t.started_at) } : { running: false, now: ts() }, error: null };
      }
      if (name === "timer_stop") {
        const t = S.timers;
        if (!t) return { data: { stopped: false, now: ts() }, error: null };
        const e = el(t.started_at);
        const row = S.days[t.date] || (S.days[t.date] = { hours: {}, mode: null, updated_at: ts() });
        const prev = row.hours[t.block];
        const prevMin = prev ? (typeof prev === "number" ? prev : Number(prev.min) || 0) : 0;
        const total = Math.max(prevMin, t.base_min) + e;
        const minAt = S.now().getTime();
        row.hours[t.block] = { min: total, minAt, stoppedAt: ts() };
        row.updated_at = ts();
        S.timers = null;
        return { data: { stopped: true, block: t.block, date: t.date, min: total, elapsed_min: e, now: ts(), min_at: minAt }, error: null };
      }
      if (name === "namaz_set") {
        const k = args.p_date + "|" + args.p_prayer;
        S.namaz[k] = { done: !!args.p_done, updated_at: args.p_at || ts() };
        return { data: { done: !!args.p_done, updated_at: S.namaz[k].updated_at }, error: null };
      }
      return { data: null, error: null };
    });
  }

  /* цепочечный query builder для .from(table) */
  function from(table) {
    const A = {
      _f: [], _order: [], _range: null, _single: false, _op: "select", _rows: null, _up: null, _onConflict: null,
      select() { this._op = "select"; return this; },
      eq(c, v) { this._f.push([c, v]); return this; },
      gt(c, v) { this._f.push([c, v, "gt"]); return this; },
      in(c, v) { this._f.push([c, v, "in"]); return this; },
      order() { return this; },
      range(a, b) { this._range = [a, b]; return this; },
      maybeSingle() { this._single = true; return this; },
      upsert(rows, opts) { this._op = "upsert"; this._rows = rows; this._onConflict = opts && opts.onConflict; return this; },
      delete() { this._op = "delete"; return this; },
      then(res, rej) { return this._run().then(res, rej); },
      async _run() {
        S.calls.push({ name: table + "." + this._op, at: Date.now(), rows: this._rows });
        await sleep(S.latency);
        if (this._op === "select") {
          if (table === "days") {
            let rows = Object.keys(S.days).map((d) => ({ user_id: "u1", date: d, hours: S.days[d].hours, blocks: null, mode: S.days[d].mode, updated_at: S.days[d].updated_at }));
            if (this._single) return { data: rows[0] || null, error: null };
            return { data: rows, error: null };
          }
          if (table === "settings") return { data: S.settings, error: null };
          if (table === "namaz_marks") {
            const rows = Object.keys(S.namaz).map((k) => { const [date, prayer] = k.split("|"); return { user_id: "u1", date, prayer, done: S.namaz[k].done, updated_at: S.namaz[k].updated_at }; });
            const since = (this._f.find((f) => f[0] === "updated_at") || [])[1];
            const out = since ? rows.filter((r) => r.updated_at > since) : rows;
            return { data: this._range ? out.slice(this._range[0], this._range[1] + 1) : out, error: null };
          }
          if (table === "push_subscriptions") return { data: S.subs, error: null };
          return { data: [], error: null };
        }
        if (this._op === "upsert") {
          if (table === "days") {
            const rows = Array.isArray(this._rows) ? this._rows : [this._rows];
            for (const r of rows) {
              const cur = S.days[r.date];
              // серверный триггер days_touch: updated_at = now() при любом UPDATE
              S.days[r.date] = { hours: r.hours, mode: r.mode, updated_at: ts(), _client: r.updated_at };
            }
          }
          if (table === "settings") S.settings = Array.isArray(this._rows) ? this._rows[0] : this._rows;
          if (table === "push_subscriptions") {
            const rows = Array.isArray(this._rows) ? this._rows : [this._rows];
            for (const r of rows) {
              const i = S.subs.findIndex((s) => s.endpoint === r.endpoint);
              if (i >= 0) S.subs[i] = r; else S.subs.push(r);
            }
          }
          return { error: null };
        }
        if (this._op === "delete") {
          if (table === "push_subscriptions") {
            const [c, v] = this._f[0] || [];
            if (c === "endpoint") S.subs = S.subs.filter((s) => s.endpoint !== v);
            if (c === "user_id") S.subs = S.subs.filter((s) => s.user_id !== v);
          }
          return { error: null };
        }
        return { error: null };
      },
    };
    return A;
  }

  return { S, rpc, from, sleep };
}

/* ───── браузер с реальным кодом ───── */
export function makeApp(server, { files = FILES, storage = null } = {}) {
  const dom = new JSDOM(readFileSync(ROOT + "index.html", "utf8"), { url: "http://localhost/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.scrollTo = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => null;
  if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  /* Сервер подставляем ДО кода: скрипты читают sb при загрузке.
     sb/session — это let-переменные синхронизации, объявленные в sync.js. */
  w.__sb = {
    rpc: server.rpc,
    from: server.from,
    channel: () => {
      const ch = { on() { return ch; }, subscribe(cb) { if (cb) setTimeout(() => cb("SUBSCRIBED"), 5); return ch; } };
      return ch;
    },
    removeChannel() {},
    auth: { onAuthStateChange() {}, getSession: async () => ({ data: { session: null } }) },
  };
  w.__session = { user: { id: "u1", email: "u@example.com" }, access_token: "tok" };
  /* jsdom не умеет import() с CDN, а initSync() при неудаче обнуляет sb.
     Поэтому gluesb() зовётся после каждой загрузки: он и подставляет сервер,
     и гасит повторный поход в сеть (initSync уже отработал с ошибкой). */
  w.__gluesb = () => { try { w.eval("sb = __sb; session = __session; initSync = async () => {};"); } catch {} };
  for (const f of files) {
    const s = w.document.createElement("script");
    s.textContent = readFileSync(ROOT + f, "utf8");
    w.document.body.appendChild(s);
    w.__gluesb();
  }
  w.__gluesb();
  /* холст для конфетти: без него падает showOverlay */
  w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {}, scale() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }), set fillStyle(v) {}, set globalAlpha(v) {}, measureText: () => ({ width: 10 }) });
  return w;
}
