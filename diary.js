/* ИИ-дневник: записи дня, цели, анализ через Gemini (Supabase Edge Function).

   Живёт отдельно от остального трекера: своё хранилище (vp-diary-v1), свои таблицы
   в Supabase и своя построчная синхронизация. Отметки, таймер, намаз и расписание
   не затрагиваются. Без входа в аккаунт дневник и цели работают локально и офлайн.

   Синхронизация: у каждой записи есть updatedAt; при слиянии побеждает более свежая
   правка по этой записи (а не вся база целиком). Удаления — «надгробия» (deletedAt),
   чтобы они доезжали до других устройств. База сама отбрасывает устаревшие записи. */
(function () {
  "use strict";

  const KEY = "vp-diary-v1";
  const FN = "analyze-diary";
  const MAX_BODY = 20000;
  const MAX_FIELD = 2000;
  const MIN_ANALYZE = 20;
  const PAGE = 500;
  const CHUNK = 100;
  const EPOCH = "1970-01-01T00:00:00.000Z";

  const FIELD_DEFS = [
    ["plan", "Что я планировал сделать сегодня"],
    ["done", "Что фактически сделал"],
    ["failed", "Что не получилось"],
    ["why", "Почему откладывал задачи"],
    ["blockers", "Что мешало начать"],
    ["circumstances", "Какие обстоятельства повлияли"],
    ["tomorrow", "Что хочу изменить завтра"],
  ];
  const FIELD_KEYS = FIELD_DEFS.map((d) => d[0]);

  const PRIORITY = { main: "Главная", secondary: "Второстепенная", unknown: "Приоритет не определён" };
  const CATEGORY = { learning: "Учёба", career: "Карьера", health: "Здоровье", finance: "Финансы", personal: "Личное", other: "Другое" };
  const STATUS = { not_started: "Не начата", in_progress: "В процессе", postponed: "Отложена", done: "Выполнена", cancelled: "Отменена" };
  const CONF = { low: "низкая уверенность", medium: "средняя уверенность", high: "высокая уверенность" };

  const FN_MESSAGES = {
    unauthorized: "Нужен вход через Google (вкладка «Профиль»).",
    rate_limited: "Суточный лимит анализов исчерпан. Он обновится завтра.",
    not_configured: "ИИ на сервере ещё не настроен: добавь GEMINI_API_KEY в Secrets Supabase.",
    not_deployed: "Edge Function analyze-diary не задеплоена в Supabase.",
    entry_not_found: "Запись ещё не дошла до сервера. Проверь соединение и повтори.",
    entry_too_short: "В записи слишком мало текста для анализа.",
    timeout: "ИИ не ответил вовремя. Повтори.",
    upstream_busy: "ИИ сейчас перегружен или исчерпан лимит Google. Попробуй через минуту.",
    invalid_output: "ИИ вернул ответ в неверном формате. Повтори — запрос не списан.",
    blocked: "ИИ отказался обрабатывать этот текст.",
    network: "Нет связи с сервером. Запись сохранена на устройстве — повтори позже.",
    client_timeout: "Сервер долго не отвечает. Повтори чуть позже.",
    not_synced: "Запись не отправилась на сервер. Проверь соединение и повтори.",
    no_tables: "Таблицы дневника ещё не созданы в Supabase: примени миграцию 20261114_diary.sql.",
  };

  /* ───────── утилиты ───────── */

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (m) => { try { if (typeof toast === "function") toast(m); } catch { /* ignore */ } };
  const sfx = (n) => { try { if (typeof play === "function") play(n); } catch { /* ignore */ } };
  const nowMs = () => { try { if (typeof stampNow === "function") return stampNow(); } catch { /* ignore */ } return Date.now(); };
  const iso = (t) => new Date(t).toISOString();
  const toMs = (v) => { const t = v ? new Date(v).getTime() : 0; return Number.isFinite(t) ? t : 0; };
  const pad = (n) => String(n).padStart(2, "0");
  const keyOfDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayK = () => keyOfDate(new Date());
  const parseK = (k) => { const p = k.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const shiftK = (k, n) => { const d = parseK(k); d.setDate(d.getDate() + n); return keyOfDate(d); };
  const validK = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || "") && keyOfDate(parseK(k)) === k;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const FMT_LONG = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long" });
  const FMT_SHORT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  const FMT_TIME = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtDate = (k, f) => (validK(k) ? (f || FMT_SHORT).format(parseK(k)) : String(k || ""));

  function uid() {
    try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* ignore */ }
    const b = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const norm = (s) =>
    String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  function similar(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const tx = new Set(x.split(" ")), ty = new Set(y.split(" "));
    let inter = 0;
    tx.forEach((t) => { if (ty.has(t)) inter++; });
    const uni = tx.size + ty.size - inter;
    return uni > 0 && inter / uni >= 0.75;
  }

  const withTimeout = (p, t) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "client_timeout" })), t))]);

  /* ───────── хранилище ───────── */

  function emptyDb() {
    return { v: 1, entries: {}, goals: {}, subtasks: {}, analyses: {}, cursor: {}, del: { analyses: [] } };
  }
  function loadDb() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyDb();
      const p = JSON.parse(raw);
      const db = Object.assign(emptyDb(), p && typeof p === "object" ? p : {});
      ["entries", "goals", "subtasks", "analyses", "cursor"].forEach((k) => { if (!db[k] || typeof db[k] !== "object") db[k] = {}; });
      if (!db.del || !Array.isArray(db.del.analyses)) db.del = { analyses: [] };
      return db;
    } catch {
      return emptyDb();
    }
  }
  let DB = loadDb();
  let persistFailed = false;
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(DB)); persistFailed = false; return true; }
    catch (e) { persistFailed = true; console.warn("Дневник: не удалось сохранить локально", e); return false; }
  }

  const V = {
    sub: "entry",
    date: todayK(),
    q: "",
    shown: 30,
    analyzing: null, // { date }
    aerr: null, // { date, text, code }
    signedIn: false,
    noTables: false,
    syncError: "",
    status: "local",
  };
  try { const s = localStorage.getItem(KEY + ":view"); if (s === "goals" || s === "entry") V.sub = s; } catch { /* ignore */ }

  function touch(rec) {
    rec.updatedAt = Math.max(nowMs(), (rec.updatedAt || 0) + 1);
    rec.dirty = true;
    return rec;
  }

  /* ───────── записи ───────── */

  const liveEntry = (d) => { const e = DB.entries[d]; return e && !e.deletedAt ? e : null; };
  const cleanFields = (f) => {
    const out = {};
    FIELD_KEYS.forEach((k) => { const v = f && typeof f[k] === "string" ? f[k].trim().slice(0, MAX_FIELD) : ""; if (v) out[k] = v; });
    return out;
  };
  function entryText(e) {
    const parts = [];
    if (e.body && e.body.trim()) parts.push(e.body.trim());
    FIELD_DEFS.forEach(([k, label]) => { const v = e.fields && e.fields[k]; if (v && v.trim()) parts.push(`${label}: ${v.trim()}`); });
    return parts.join("\n");
  }
  const entrySnippet = (e) => entryText(e).replace(/\s+/g, " ").slice(0, 140);

  /* true — запись изменилась */
  function saveEntry(date, body, fields) {
    body = String(body || "").slice(0, MAX_BODY);
    fields = cleanFields(fields);
    const has = body.trim().length > 0 || Object.keys(fields).length > 0;
    let e = DB.entries[date];
    if (!e && !has) return false;
    if (!e) e = DB.entries[date] = { date, body: "", fields: {}, updatedAt: 0, deletedAt: null, dirty: false };
    const same = e.body === body && JSON.stringify(cleanFields(e.fields)) === JSON.stringify(fields) && !!e.deletedAt === !has;
    if (same) return false;
    e.body = body;
    e.fields = fields;
    touch(e);
    e.deletedAt = has ? null : e.updatedAt;
    return true;
  }

  const analysesFor = (d) => Object.values(DB.analyses).filter((a) => a.entryDate === d).sort((a, b) => b.createdAt - a.createdAt);

  function deleteEntry(date) {
    const e = DB.entries[date];
    if (e && !e.deletedAt) { touch(e); e.deletedAt = e.updatedAt; e.body = ""; e.fields = {}; }
    /* Разбор дня — производная от записи: удаляем вместе с ней */
    analysesFor(date).forEach((a) => {
      delete DB.analyses[a.id];
      if (!DB.del.analyses.includes(a.id)) DB.del.analyses.push(a.id);
    });
  }

  /* ───────── цели ───────── */

  const liveGoals = () => Object.values(DB.goals).filter((g) => !g.deletedAt);
  const subsOf = (gid) =>
    Object.values(DB.subtasks).filter((s) => s.goalId === gid && !s.deletedAt).sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);

  function progressOf(g) {
    const subs = subsOf(g.id);
    if (subs.length) {
      const d = subs.filter((s) => s.done).length;
      return { done: d, total: subs.length, pct: Math.round((d / subs.length) * 100) };
    }
    return { done: g.status === "done" ? 1 : 0, total: 0, pct: g.status === "done" ? 100 : 0 };
  }

  function createGoal(d) {
    const t = nowMs();
    const g = {
      id: uid(),
      title: String(d.title).trim().slice(0, 200),
      description: String(d.description || "").trim().slice(0, 2000),
      priority: PRIORITY[d.priority] ? d.priority : "unknown",
      urgent: !!d.urgent,
      category: CATEGORY[d.category] ? d.category : "other",
      deadline: validK(d.deadline) ? d.deadline : null,
      status: STATUS[d.status] ? d.status : "not_started",
      reason: String(d.reason || "").slice(0, 1000),
      recommendations: Array.isArray(d.recommendations) ? d.recommendations.slice(0, 6).map((x) => String(x).slice(0, 300)) : [],
      sourceDates: Array.isArray(d.sourceDates) ? d.sourceDates.filter(validK).slice(0, 30) : [],
      sourceAnalysisId: d.sourceAnalysisId || null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      dirty: true,
    };
    DB.goals[g.id] = g;
    return g;
  }

  function createSub(goalId, title, est, position) {
    const t = nowMs();
    const s = {
      id: uid(), goalId,
      title: String(title).trim().slice(0, 300),
      est: est ? clamp(Math.round(est), 1, 1440) : null,
      done: false, position: position || 0,
      createdAt: t, updatedAt: t, deletedAt: null, dirty: true,
    };
    DB.subtasks[s.id] = s;
    return s;
  }

  function removeGoal(g) {
    touch(g);
    g.deletedAt = g.updatedAt;
    subsOf(g.id).forEach((s) => { touch(s); s.deletedAt = s.updatedAt; });
  }

  const findSimilarGoal = (title) => liveGoals().find((g) => g.status !== "cancelled" && similar(g.title, title)) || null;

  function parseSubLines(text) {
    return String(text || "").split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 30).map((l) => {
      const m = l.match(/^(.*?)\s*\|\s*(\d{1,4})\s*(?:мин\w*|m)?$/i);
      const title = (m ? m[1] : l).trim().slice(0, 300);
      return title ? { title, est: m ? clamp(parseInt(m[2], 10), 1, 1440) : null } : null;
    }).filter(Boolean);
  }

  /* ───────── разбор ИИ: решения пользователя ───────── */

  function touchAnalysis(a) { a.updatedAt = Math.max(nowMs(), (a.updatedAt || 0) + 1); a.dirty = true; }
  function setFeedback(a, key, value) {
    if (value == null || value === "") delete a.feedback[key]; else a.feedback[key] = value;
    touchAnalysis(a);
  }

  function acceptProposal(a, i, vals) {
    const p = (a.result.goals || [])[i] || {};
    const g = createGoal({
      title: vals.title, description: vals.description, priority: vals.priority, urgent: vals.urgent,
      category: vals.category, deadline: vals.deadline, reason: p.reason,
      recommendations: p.recommendations, sourceDates: [a.entryDate], sourceAnalysisId: a.id,
    });
    vals.subtasks.forEach((s, idx) => createSub(g.id, s.title, s.est, idx));
    setFeedback(a, "goal:" + i, "accepted:" + g.id);
    return g;
  }

  function mergeProposal(a, i, gid) {
    const g = DB.goals[gid];
    const p = (a.result.goals || [])[i];
    if (!g || g.deletedAt || !p) return null;
    const have = new Set(subsOf(g.id).map((s) => norm(s.title)));
    let pos = subsOf(g.id).reduce((m, s) => Math.max(m, s.position), -1) + 1;
    (p.subtasks || []).forEach((s) => {
      if (have.has(norm(s.title))) return;
      createSub(g.id, s.title, s.estimated_minutes, pos++);
      have.add(norm(s.title));
    });
    (p.recommendations || []).forEach((r) => {
      if (g.recommendations.length < 6 && !g.recommendations.some((x) => norm(x) === norm(r))) g.recommendations.push(String(r).slice(0, 300));
    });
    if (!g.sourceDates.includes(a.entryDate) && g.sourceDates.length < 30) g.sourceDates.push(a.entryDate);
    if (!g.reason && p.reason) g.reason = String(p.reason).slice(0, 1000);
    if (!g.deadline && validK(p.deadline)) g.deadline = p.deadline;
    if (g.status === "done" && subsOf(g.id).some((s) => !s.done)) g.status = "in_progress";
    touch(g);
    setFeedback(a, "goal:" + i, "merged:" + g.id);
    return g;
  }

  /* ───────── синхронизация ───────── */

  const client = () => (typeof sb !== "undefined" && sb ? sb : null);
  async function getSessionSafe() {
    const c = client();
    if (!c) return null;
    try { const r = await c.auth.getSession(); return (r && r.data && r.data.session) || null; } catch { return null; }
  }
  const missingTable = (e) =>
    !!e && (e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(e.message || ""));

  const rowEntry = (u, e) => ({
    user_id: u, entry_date: e.date, body: e.body, fields: cleanFields(e.fields),
    updated_at: iso(e.updatedAt), deleted_at: e.deletedAt ? iso(e.deletedAt) : null,
  });
  const rowGoal = (u, g) => ({
    id: g.id, user_id: u, title: g.title, description: g.description, priority: g.priority, urgent: !!g.urgent,
    category: g.category, deadline: g.deadline || null, status: g.status, reason: g.reason,
    recommendations: g.recommendations, source_dates: g.sourceDates, source_analysis_id: g.sourceAnalysisId || null,
    created_at: iso(g.createdAt), updated_at: iso(g.updatedAt), deleted_at: g.deletedAt ? iso(g.deletedAt) : null,
  });
  const rowSub = (u, s) => ({
    id: s.id, goal_id: s.goalId, user_id: u, title: s.title, estimated_minutes: s.est || null, done: !!s.done,
    position: s.position, created_at: iso(s.createdAt), updated_at: iso(s.updatedAt), deleted_at: s.deletedAt ? iso(s.deletedAt) : null,
  });

  const fromEntry = (r) => ({
    date: r.entry_date, body: r.body || "", fields: r.fields && typeof r.fields === "object" ? r.fields : {},
    updatedAt: toMs(r.updated_at), deletedAt: r.deleted_at ? toMs(r.deleted_at) : null, dirty: false,
  });
  const fromGoal = (r) => ({
    id: r.id, title: r.title, description: r.description || "", priority: r.priority, urgent: !!r.urgent, category: r.category,
    deadline: r.deadline || null, status: r.status, reason: r.reason || "",
    recommendations: Array.isArray(r.recommendations) ? r.recommendations : [],
    sourceDates: Array.isArray(r.source_dates) ? r.source_dates : [], sourceAnalysisId: r.source_analysis_id || null,
    createdAt: toMs(r.created_at), updatedAt: toMs(r.updated_at), deletedAt: r.deleted_at ? toMs(r.deleted_at) : null, dirty: false,
  });
  const fromSub = (r) => ({
    id: r.id, goalId: r.goal_id, title: r.title, est: r.estimated_minutes || null, done: !!r.done, position: r.position || 0,
    createdAt: toMs(r.created_at), updatedAt: toMs(r.updated_at), deletedAt: r.deleted_at ? toMs(r.deleted_at) : null, dirty: false,
  });
  const fromAnalysis = (r) => ({
    id: r.id, entryDate: r.entry_date, model: r.model || "", result: r.result || {},
    feedback: r.feedback && typeof r.feedback === "object" ? r.feedback : {},
    createdAt: toMs(r.created_at), updatedAt: toMs(r.updated_at), dirty: false,
  });

  /* Побеждает более свежая правка этой записи. true — локальная запись заменена. */
  function mergeRec(store, key, remote) {
    const local = store[key];
    if (!local || remote.updatedAt > local.updatedAt) { store[key] = remote; return true; }
    return false;
  }
  function mergeAnalysis(remote) {
    if (DB.del.analyses.includes(remote.id)) return false;
    const local = DB.analyses[remote.id];
    if (!local) { DB.analyses[remote.id] = remote; return true; }
    if (local.dirty) {
      local.feedback = Object.assign({}, remote.feedback, local.feedback);
      local.updatedAt = Math.max(local.updatedAt, remote.updatedAt + 1);
      return true;
    }
    if (remote.updatedAt > local.updatedAt) { local.feedback = remote.feedback; local.updatedAt = remote.updatedAt; return true; }
    return false;
  }

  const TABLES = [
    { name: "diary_entries", order: "entry_date", apply: (r) => mergeRec(DB.entries, r.entry_date, fromEntry(r)) },
    { name: "goals", order: "id", apply: (r) => mergeRec(DB.goals, r.id, fromGoal(r)) },
    { name: "goal_subtasks", order: "id", apply: (r) => mergeRec(DB.subtasks, r.id, fromSub(r)) },
    { name: "ai_analyses", order: "id", apply: (r) => mergeAnalysis(fromAnalysis(r)) },
  ];

  async function pullAll(u) {
    const c = client();
    let changed = false;
    for (const t of TABLES) {
      const since = DB.cursor[t.name] || EPOCH;
      let offset = 0, maxMs = toMs(since);
      for (;;) {
        const { data, error } = await c.from(t.name).select("*").eq("user_id", u).gte("server_at", since)
          .order("server_at", { ascending: true }).order(t.order, { ascending: true }).range(offset, offset + PAGE - 1);
        if (error) throw error;
        (data || []).forEach((r) => { if (t.apply(r)) changed = true; maxMs = Math.max(maxMs, toMs(r.server_at)); });
        if (!data || data.length < PAGE) break;
        offset += PAGE;
      }
      DB.cursor[t.name] = iso(maxMs || 0);
    }
    return changed;
  }

  /* Отправить изменённые строки. Строки, которые база пропустила как устаревшие
     (кто-то успел записать более свежую правку), забираем обратно и сливаем. */
  async function pushTable(table, recs, toRow, conflict, keyOf) {
    const c = client();
    for (let i = 0; i < recs.length; i += CHUNK) {
      const chunk = recs.slice(i, i + CHUNK);
      const sent = chunk.map((r) => r.updatedAt);
      const { data, error } = await c.from(table).upsert(chunk.map(toRow), { onConflict: conflict }).select(keyOf.col);
      if (error) throw error;
      const ok = new Set((data || []).map((r) => r[keyOf.col]));
      const stale = [];
      chunk.forEach((r, idx) => {
        if (ok.has(keyOf.get(r))) { if (r.updatedAt === sent[idx]) r.dirty = false; } else stale.push(keyOf.get(r));
      });
      if (stale.length) await refetch(table, keyOf.col, stale);
    }
  }
  async function refetch(table, col, keys) {
    const t = TABLES.find((x) => x.name === table);
    const { data, error } = await client().from(table).select("*").in(col, keys);
    if (error) throw error;
    (data || []).forEach((r) => t.apply(r));
  }

  async function pushAll(u) {
    const c = client();
    const dirty = (obj) => Object.values(obj).filter((r) => r.dirty);
    await pushTable("diary_entries", dirty(DB.entries), (e) => rowEntry(u, e), "user_id,entry_date", { col: "entry_date", get: (e) => e.date });
    await pushTable("goals", dirty(DB.goals), (g) => rowGoal(u, g), "id", { col: "id", get: (g) => g.id });
    const goalsOk = (s) => DB.goals[s.goalId] && !DB.goals[s.goalId].dirty;
    await pushTable("goal_subtasks", dirty(DB.subtasks).filter(goalsOk), (s) => rowSub(u, s), "id", { col: "id", get: (s) => s.id });

    for (const a of dirty(DB.analyses)) {
      const sent = a.updatedAt;
      const { error } = await c.from("ai_analyses").update({ feedback: a.feedback, updated_at: iso(a.updatedAt) }).eq("id", a.id).eq("user_id", u);
      if (error) throw error;
      if (a.updatedAt === sent) a.dirty = false;
    }
    if (DB.del.analyses.length) {
      const ids = DB.del.analyses.slice();
      const { error } = await c.from("ai_analyses").delete().in("id", ids).eq("user_id", u);
      if (error) throw error;
      DB.del.analyses = DB.del.analyses.filter((x) => !ids.includes(x));
    }
  }

  const anyDirty = () =>
    [DB.entries, DB.goals, DB.subtasks, DB.analyses].some((o) => Object.values(o).some((r) => r.dirty)) || DB.del.analyses.length > 0;

  let syncP = null, syncAgain = false, syncTimer = null;
  function syncSoon(delay) { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, delay == null ? 1500 : delay); }
  function runSync() {
    if (syncP) { syncAgain = true; return syncP; }
    syncP = (async () => {
      try { return await doSync(); }
      finally { syncP = null; if (syncAgain) { syncAgain = false; setTimeout(runSync, 50); } }
    })();
    return syncP;
  }
  async function doSync() {
    const s = await getSessionSafe();
    V.signedIn = !!s;
    if (!s) { setStatus(anyDirty() ? "pending" : "local"); return false; }
    try {
      setStatus("sync");
      const u = s.user.id;
      const changed = await pullAll(u);
      await pushAll(u);
      persist();
      V.noTables = false;
      V.syncError = "";
      setStatus(anyDirty() ? "pending" : "synced");
      if (changed) renderAll(isTyping());
      return true;
    } catch (e) {
      console.warn("Дневник: синхронизация не удалась", e);
      persist();
      if (missingTable(e)) { V.noTables = true; V.syncError = FN_MESSAGES.no_tables; }
      else V.syncError = (e && e.message) || "ошибка";
      setStatus("error");
      renderBanner();
      return false;
    }
  }

  function hookAuth() {
    let tries = 0;
    const t = setInterval(() => {
      const c = client();
      if (c) {
        clearInterval(t);
        try {
          c.auth.onAuthStateChange((ev, s) => {
            V.signedIn = !!s;
            if (s) setTimeout(runSync, 0); else setStatus(anyDirty() ? "pending" : "local");
          });
        } catch (e) { console.warn("Дневник: подписка на вход не удалась", e); }
        setTimeout(runSync, 800);
        return;
      }
      if (++tries > 120) clearInterval(t);
    }, 500);
  }

  /* Пользователь сейчас печатает (или правка ещё не сохранена) — форму не перерисовываем */
  function isTyping() {
    const a = document.activeElement;
    return !!saveTimer || !!(a && (a.id === "dyBody" || (a.dataset && a.dataset.field)));
  }

  /* ───────── индикатор ───────── */

  function setStatus(kind) {
    V.status = kind;
    const el = $("dyStatus");
    if (!el) return;
    const text = {
      saving: "Сохраняю…",
      local: V.signedIn ? "Сохранено на устройстве" : "Сохранено на этом устройстве · вход в «Профиле» включит синхронизацию",
      pending: "Сохранено · ждёт отправки",
      sync: "Синхронизирую…",
      synced: "Синхронизировано",
      error: persistFailed ? "Не удалось сохранить: память браузера переполнена" : "Не отправлено: " + (V.syncError || "нет связи") + " · повторю позже",
    }[kind] || "";
    el.className = "dy-status " + (kind === "sync" ? "saving" : kind === "local" ? "" : kind);
    el.textContent = text;
  }

  /* ───────── каркас ───────── */

  function buildShell() {
    const root = $("panel-diary");
    if (!root || $("dyRoot")) return false;
    root.innerHTML = `
      <div class="section-head">
        <h2>Дневник</h2>
        <p>Пиши день своими словами. ИИ предложит цели и найдёт возможные причины откладывания — решаешь всегда ты.</p>
      </div>
      <div id="dyRoot">
        <div class="dy-sub" role="tablist">
          <button class="dy-sub-btn" type="button" data-act="sub" data-sub="entry" role="tab">Дневник</button>
          <button class="dy-sub-btn" type="button" data-act="sub" data-sub="goals" role="tab">Цели <span class="dy-count-badge" id="dyGoalsCount"></span></button>
        </div>
        <div id="dyBanner"></div>
        <div id="dyEntryView">
          <div id="dyForm"></div>
          <div id="dyAnalysis"></div>
          <div id="dyHistory"></div>
        </div>
        <div id="dyGoalsView" hidden></div>
      </div>`;
    return true;
  }

  function renderSubTabs() {
    document.querySelectorAll("#dyRoot .dy-sub-btn").forEach((b) => b.classList.toggle("on", b.dataset.sub === V.sub));
    const open = liveGoals().filter((g) => g.status !== "done" && g.status !== "cancelled").length;
    const badge = $("dyGoalsCount");
    if (badge) badge.textContent = open ? String(open) : "";
    $("dyEntryView").hidden = V.sub !== "entry";
    $("dyGoalsView").hidden = V.sub !== "goals";
  }

  function renderBanner() {
    const el = $("dyBanner");
    if (!el) return;
    el.innerHTML = V.noTables ? `<div class="dy-warn">${esc(FN_MESSAGES.no_tables)} Пока всё сохраняется только на этом устройстве.</div>` : "";
  }

  function renderAll(keepForm) {
    renderSubTabs();
    renderBanner();
    if (V.sub === "entry") {
      if (!keepForm || !$("dyBody")) renderForm();
      renderAnalysis();
      renderHistory();
    } else {
      renderGoals();
    }
  }

  /* ───────── форма записи ───────── */

  function renderForm() {
    const root = $("dyForm");
    if (!root) return;
    const date = V.date;
    const e = liveEntry(date);
    const isToday = date === todayK();
    root.innerHTML = `
      <div class="card">
        <div class="dy-datebar">
          <button class="ghost-btn" type="button" data-act="date-prev" aria-label="Предыдущий день">‹</button>
          <input type="date" id="dyDate" value="${esc(date)}" max="${esc(todayK())}" aria-label="Дата записи" />
          <button class="ghost-btn" type="button" data-act="date-next" aria-label="Следующий день" ${isToday ? "disabled" : ""}>›</button>
          ${isToday ? "" : `<button class="dy-link" type="button" data-act="date-today">к сегодняшнему дню</button>`}
          <span class="dy-datetitle">${esc(fmtDate(date, FMT_LONG))}</span>
          <span class="dy-status" id="dyStatus"></span>
        </div>
        <label class="dy-label" for="dyBody">Как прошёл день — своими словами</label>
        <textarea id="dyBody" rows="10" maxlength="${MAX_BODY}" placeholder="Что планировал, что сделал, что откладывал и почему…"></textarea>
        <div class="dy-count" id="dyCount"></div>
        <details class="dy-details" id="dyDetails">
          <summary>Подсказки по полям (необязательно)</summary>
          <div class="dy-fields">
            ${FIELD_DEFS.map(([k, label]) => `<div><label for="dyF_${k}">${esc(label)}</label><textarea id="dyF_${k}" data-field="${k}" rows="2" maxlength="${MAX_FIELD}"></textarea></div>`).join("")}
          </div>
        </details>
        <div class="dy-actions">
          <button class="primary-btn" type="button" id="dyAnalyze" data-act="analyze">Проанализировать</button>
          ${e ? `<button class="danger-btn" type="button" data-act="entry-delete">Удалить запись</button>` : ""}
        </div>
        <p class="dy-hint">Анализ запускается только этой кнопкой. На анализ уходят запись дня, несколько последних записей и названия твоих целей — через сервер, ключ ИИ в браузере не хранится. Бесплатный тариф Google Gemini может использовать отправленный текст для улучшения своих продуктов — не пиши в дневник то, чего не хочешь отправлять.</p>
      </div>`;
    $("dyBody").value = e ? e.body : "";
    let hasField = false;
    FIELD_KEYS.forEach((k) => {
      const v = e && e.fields && e.fields[k] ? e.fields[k] : "";
      $("dyF_" + k).value = v;
      if (v) hasField = true;
    });
    $("dyDetails").open = hasField;
    updateCount();
    setStatus(V.status === "saving" ? "local" : V.status);
    syncAnalyzeButton();
  }

  function updateCount() {
    const el = $("dyCount"), b = $("dyBody");
    if (el && b) el.textContent = `${b.value.length} / ${MAX_BODY}`;
  }
  function syncAnalyzeButton() {
    const b = $("dyAnalyze");
    if (!b) return;
    b.disabled = !!V.analyzing;
    b.textContent = V.analyzing ? "Анализирую…" : "Проанализировать";
  }
  const formValues = () => {
    const fields = {};
    FIELD_KEYS.forEach((k) => { const el = $("dyF_" + k); if (el) fields[k] = el.value; });
    return { body: $("dyBody") ? $("dyBody").value : "", fields };
  };

  let saveTimer = null;
  function onFormInput() {
    updateCount();
    setStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(commitForm, 500);
  }
  function commitForm() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!$("dyBody")) return;
    const { body, fields } = formValues();
    const changed = saveEntry(V.date, body, fields);
    if (changed) {
      const ok = persist();
      setStatus(!ok ? "error" : V.signedIn ? "pending" : "local");
      syncSoon(2500);
      renderHistory();
      renderAnalysis();
      renderSubTabs();
    } else {
      setStatus(V.status === "saving" ? (anyDirty() ? "pending" : V.signedIn ? "synced" : "local") : V.status);
    }
  }

  function gotoDate(d) {
    if (!validK(d)) return;
    if (d > todayK()) d = todayK();
    commitForm();
    V.date = d;
    V.aerr = null;
    renderForm();
    renderAnalysis();
    renderHistory();
  }

  /* ───────── разбор ИИ ───────── */

  function badgesHtml(g) {
    const b = [];
    if (g.urgent) b.push(`<span class="dy-badge urgent">Срочно</span>`);
    b.push(`<span class="dy-badge ${g.priority === "main" ? "main" : ""}">${esc(PRIORITY[g.priority] || PRIORITY.unknown)}</span>`);
    b.push(`<span class="dy-badge">${esc(CATEGORY[g.category] || CATEGORY.other)}</span>`);
    return b.join("");
  }

  function proposalHtml(a, p, i) {
    const st = a.feedback["goal:" + i] || "";
    if (st.startsWith("accepted:") || st.startsWith("merged:")) {
      const gid = st.split(":")[1];
      const g = DB.goals[gid];
      const live = g && !g.deletedAt;
      return `<div class="dy-prop is-done"><div class="dy-compact"><span>${st.startsWith("merged:") ? "Объединена с целью" : "Добавлена в цели"}: <b>${esc(live ? g.title : p.title)}</b>${live ? "" : " (цель удалена)"}</span>${live ? `<button class="dy-sbtn" type="button" data-act="goto-goals">Открыть</button>` : ""}</div></div>`;
    }
    if (st === "rejected") {
      return `<div class="dy-prop is-done"><div class="dy-compact"><span>Отклонена: ${esc(p.title)}</span><button class="dy-sbtn" type="button" data-act="prop-restore" data-a="${esc(a.id)}" data-i="${i}">Вернуть</button></div></div>`;
    }
    const sim = (p.matches_goal_id && DB.goals[p.matches_goal_id] && !DB.goals[p.matches_goal_id].deletedAt ? DB.goals[p.matches_goal_id] : null) || findSimilarGoal(p.title);
    const subs = (p.subtasks || []).map((s) => `<li>${esc(s.title)}${s.estimated_minutes ? ` <small>· ${s.estimated_minutes} мин</small>` : ""}</li>`).join("");
    return `<div class="dy-prop">
      <div class="dy-prop-head"><div class="dy-prop-title">${esc(p.title)}</div><div class="dy-badges">${badgesHtml({ urgent: p.urgent, priority: p.priority, category: p.category })}</div></div>
      ${p.description ? `<p>${esc(p.description)}</p>` : ""}
      ${p.reason ? `<p><small>Почему выделена:</small> ${esc(p.reason)}</p>` : ""}
      <p><small>Срок:</small> ${p.deadline ? esc(fmtDate(p.deadline)) + " <small>(назван в записи)</small>" : "<small>не назван — поставишь сам, если нужен</small>"}</p>
      ${subs ? `<ul>${subs}</ul>` : ""}
      ${sim ? `<p><small>Похожая цель уже есть:</small> <b>${esc(sim.title)}</b></p>` : ""}
      <div class="dy-btns">
        <button class="dy-sbtn accent" type="button" data-act="prop-accept" data-a="${esc(a.id)}" data-i="${i}">Принять…</button>
        ${sim ? `<button class="dy-sbtn" type="button" data-act="prop-merge" data-a="${esc(a.id)}" data-i="${i}" data-g="${esc(sim.id)}">Объединить с существующей</button>` : ""}
        <button class="dy-sbtn danger" type="button" data-act="prop-reject" data-a="${esc(a.id)}" data-i="${i}">Отклонить</button>
      </div>
    </div>`;
  }

  function hypothesisHtml(a, h, i) {
    const v = a.feedback["proc:" + i] || "";
    return `<div class="dy-hyp ${v === "rejected" ? "is-rejected" : ""}">
      <div class="dy-prop-head"><div class="dy-prop-title">${esc(h.reason)}</div><span class="dy-badge ${esc(h.confidence)}">${esc(CONF[h.confidence] || "")}</span></div>
      <div class="dy-quote">«${esc(h.evidence)}»<small>${h.evidence_in_text ? "цитата из записи" : "пересказ — в тексте записи такой формулировки нет"}</small></div>
      ${h.recommendation ? `<p><small>Что попробовать:</small> ${esc(h.recommendation)}</p>` : ""}
      <div class="dy-btns">
        <button class="dy-sbtn ${v === "confirmed" ? "on" : ""}" type="button" data-act="proc-yes" data-a="${esc(a.id)}" data-i="${i}">${v === "confirmed" ? "✓ Похоже на правду" : "Похоже на правду"}</button>
        <button class="dy-sbtn ${v === "rejected" ? "on" : ""}" type="button" data-act="proc-no" data-a="${esc(a.id)}" data-i="${i}">${v === "rejected" ? "✓ Это не так" : "Это не так"}</button>
      </div>
    </div>`;
  }

  function renderAnalysis() {
    const root = $("dyAnalysis");
    if (!root) return;
    const date = V.date;
    let html = "";
    if (V.analyzing && V.analyzing.date === date) {
      html += `<div class="card"><div class="dy-loading"><span class="dy-spin"></span><span>ИИ читает запись и последние дни… Обычно 5–20 секунд.</span></div></div>`;
    } else if (V.aerr && V.aerr.date === date) {
      html += `<div class="card"><div class="dy-error">${esc(V.aerr.text)}<br><button class="primary-btn" type="button" data-act="analyze">Повторить</button></div></div>`;
    }
    const e = liveEntry(date);
    const a = e ? analysesFor(date)[0] : null;
    if (a && a.result && !(V.analyzing && V.analyzing.date === date)) {
      const r = a.result;
      const stale = e.updatedAt > (a.forUpdatedAt != null ? a.forUpdatedAt : a.createdAt + 120000);
      html += `<div class="card">
        <div class="dy-block-title">Итог дня</div>
        <p class="dy-summary">${esc(r.summary)}</p>
        ${stale ? `<div class="dy-stale">Запись менялась после анализа. Нажми «Проанализировать» ещё раз, чтобы обновить выводы.</div>` : ""}
        ${(r.goals || []).length ? `<div class="dy-block-title">Предложенные цели — ничего не создаётся без твоего решения</div>${r.goals.map((p, i) => proposalHtml(a, p, i)).join("")}` : `<div class="dy-block-title">Предложенные цели</div><p class="dy-empty">В записи не нашлось чётких целей.</p>`}
        ${(r.procrastination || []).length ? `<div class="dy-block-title">Возможные причины откладывания</div><p class="dy-empty" style="margin-bottom:9px">Это гипотезы по тексту записи, а не диагноз. Если не согласен — так и отметь, ИИ это учтёт.</p>${r.procrastination.map((h, i) => hypothesisHtml(a, h, i)).join("")}` : ""}
        ${(r.tomorrow_suggestions || []).length ? `<div class="dy-block-title">На завтра</div><ul class="steps">${r.tomorrow_suggestions.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        <div class="dy-meta">Анализ от ${esc(FMT_TIME.format(a.createdAt))}${a.model ? " · " + esc(a.model) : ""}</div>
      </div>`;
    }
    root.innerHTML = html;
    syncAnalyzeButton();
  }

  /* ───────── история ───────── */

  function renderHistory() {
    const root = $("dyHistory");
    if (!root) return;
    if (!$("dyHistList")) {
      root.innerHTML = `
        <div class="card soft">
          <div class="dy-hist-head"><h3>История</h3><input type="search" id="dyQ" placeholder="Поиск по записям" aria-label="Поиск по записям" /></div>
          <div class="dy-hist" id="dyHistList"></div>
          <div class="dy-actions"><button class="dy-sbtn" type="button" data-act="export">Экспорт всего в JSON</button></div>
        </div>`;
      $("dyQ").value = V.q;
    }
    const q = V.q.trim().toLowerCase();
    const all = Object.values(DB.entries).filter((e) => !e.deletedAt && entryText(e)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const list = q ? all.filter((e) => entryText(e).toLowerCase().includes(q)) : all;
    const slice = list.slice(0, V.shown);
    const hist = $("dyHistList");
    if (!list.length) {
      hist.innerHTML = `<p class="dy-empty">${q ? "Ничего не найдено." : "Записей пока нет — первая появится здесь."}</p>`;
      return;
    }
    hist.innerHTML = slice.map((e) => {
      const flags = [analysesFor(e.date).length ? "ИИ" : "", e.dirty ? "не отправлено" : ""].filter(Boolean).join(" · ");
      return `<button class="dy-hist-item ${e.date === V.date ? "on" : ""}" type="button" data-act="open-date" data-date="${esc(e.date)}">
        <span class="dy-hist-date">${esc(fmtDate(e.date, FMT_LONG))}</span><span class="dy-hist-text">${esc(entrySnippet(e))}</span><span class="dy-hist-flags">${esc(flags)}</span></button>`;
    }).join("") + (list.length > slice.length ? `<button class="dy-sbtn" type="button" data-act="more">Показать ещё (${list.length - slice.length})</button>` : "");
  }

  /* ───────── цели ───────── */

  const byDeadline = (a, b) => (a.deadline || "9999") < (b.deadline || "9999") ? -1 : (a.deadline || "9999") > (b.deadline || "9999") ? 1 : a.createdAt - b.createdAt;

  function deadlineHtml(g) {
    if (!g.deadline) return `<span class="dy-deadline none">без срока</span>`;
    const left = Math.round((parseK(g.deadline) - parseK(todayK())) / 86400000);
    const open = g.status !== "done" && g.status !== "cancelled";
    const cls = open && left < 0 ? "overdue" : open && left <= 2 ? "soon" : "";
    const note = !open ? "" : left < 0 ? " · просрочено" : left === 0 ? " · сегодня" : left === 1 ? " · завтра" : "";
    return `<span class="dy-deadline ${cls}" title="Срок выполнения">до ${esc(fmtDate(g.deadline))}${note}</span>`;
  }

  function goalHtml(g) {
    const subs = subsOf(g.id);
    const pr = progressOf(g);
    const cls = ["dy-goal", g.urgent && g.status !== "done" ? "is-urgent" : "", g.status === "done" ? "is-done" : ""].join(" ");
    return `<article class="${cls}" data-goal="${esc(g.id)}">
      <div class="dy-goal-top"><div class="dy-goal-title">${esc(g.title)}</div>${deadlineHtml(g)}</div>
      ${g.description ? `<p class="dy-goal-desc">${esc(g.description)}</p>` : ""}
      <div class="dy-goal-row">
        <div class="dy-badges">${badgesHtml(g)}</div>
        <select data-act="goal-status" data-g="${esc(g.id)}" aria-label="Статус цели">${Object.keys(STATUS).map((k) => `<option value="${k}" ${k === g.status ? "selected" : ""}>${STATUS[k]}</option>`).join("")}</select>
      </div>
      <div class="dy-progress"><div class="dy-bar ${pr.pct === 100 ? "full" : ""}"><span style="width:${pr.pct}%"></span></div><span class="dy-progress-text">${subs.length ? `${pr.done}/${pr.total} · ` : ""}${pr.pct}%</span></div>
      ${subs.length ? `<ul class="dy-subs">${subs.map((s) => `<li class="dy-sub-item ${s.done ? "done" : ""}"><label><input type="checkbox" data-act="sub-toggle" data-s="${esc(s.id)}" ${s.done ? "checked" : ""}/><span>${esc(s.title)}</span></label>${s.est ? `<small>${s.est} мин</small>` : ""}<button class="dy-x" type="button" data-act="sub-del" data-s="${esc(s.id)}" aria-label="Удалить подзадачу" title="Удалить подзадачу">✕</button></li>`).join("")}</ul>` : ""}
      <form class="dy-addsub" data-act="sub-add" data-g="${esc(g.id)}"><input type="text" name="t" maxlength="300" placeholder="Добавить подзадачу" aria-label="Новая подзадача" /><button class="dy-sbtn" type="submit">＋</button></form>
      <div class="dy-foot">
        <button class="dy-i" type="button" data-act="goal-info" data-g="${esc(g.id)}" title="Рекомендации и подробности" aria-label="Рекомендации и подробности">i</button>
        <button class="dy-sbtn" type="button" data-act="goal-edit" data-g="${esc(g.id)}">Изменить</button>
        ${g.status !== "cancelled" && g.status !== "done" ? `<button class="dy-sbtn" type="button" data-act="goal-irrelevant" data-g="${esc(g.id)}" title="Цель больше не актуальна — ИИ не будет предлагать её снова">Неактуально</button>` : ""}
        <span class="grow"></span>
        <button class="dy-sbtn danger" type="button" data-act="goal-delete" data-g="${esc(g.id)}">Удалить</button>
      </div>
    </article>`;
  }

  function renderGoals() {
    const root = $("dyGoalsView");
    if (!root) return;
    const all = liveGoals();
    const active = all.filter((g) => g.status !== "done" && g.status !== "cancelled");
    const groups = [
      ["Срочные", active.filter((g) => g.urgent).sort(byDeadline)],
      ["Главные", active.filter((g) => !g.urgent && g.priority === "main").sort(byDeadline)],
      ["Второстепенные", active.filter((g) => !g.urgent && g.priority !== "main").sort(byDeadline)],
      ["Выполненные", all.filter((g) => g.status === "done").sort((a, b) => b.updatedAt - a.updatedAt)],
    ];
    const cancelled = all.filter((g) => g.status === "cancelled").sort((a, b) => b.updatedAt - a.updatedAt);
    root.innerHTML = `
      <div class="dy-goals-head">
        <div class="section-head" style="margin:0"><h2 style="font-size:18px">Цели</h2><p>Главные, второстепенные и срочные. Срок — в правом верхнем углу карточки.</p></div>
        <button class="primary-btn" type="button" data-act="goal-new">＋ Новая цель</button>
      </div>
      ${all.length ? "" : `<div class="card"><p class="dy-empty">Целей пока нет. Напиши день в дневнике и нажми «Проанализировать» — предложения появятся там, а здесь окажется только то, что ты подтвердишь. Или добавь цель вручную.</p></div>`}
      ${groups.map(([title, list]) => list.length ? `<div class="dy-group-title">${title} <span>${list.length}</span></div>${list.map(goalHtml).join("")}` : "").join("")}
      ${cancelled.length ? `<details class="dy-cancelled"><summary>Неактуальные и отменённые (${cancelled.length})</summary>${cancelled.map(goalHtml).join("")}</details>` : ""}
      <div class="dy-actions"><button class="dy-sbtn" type="button" data-act="export">Экспорт всего в JSON</button></div>`;
  }

  /* ───────── модальное окно ───────── */

  function closeModal() {
    const m = $("dyModal");
    if (m) m.remove();
    document.body.classList.remove("dy-lock");
    document.removeEventListener("keydown", onModalKey);
  }
  function onModalKey(e) { if (e.key === "Escape") closeModal(); }
  function openModal(html) {
    closeModal();
    const m = document.createElement("div");
    m.className = "dy-modal";
    m.id = "dyModal";
    m.innerHTML = `<div class="dy-modal-box" role="dialog" aria-modal="true">${html}</div>`;
    m.addEventListener("mousedown", (ev) => { if (ev.target === m) closeModal(); });
    document.body.appendChild(m);
    document.body.classList.add("dy-lock");
    document.addEventListener("keydown", onModalKey);
    const first = m.querySelector("input[type=text], textarea, button");
    if (first) first.focus();
    return m;
  }

  function goalFormHtml(title, v, withSubs) {
    const sel = (map, cur) => Object.keys(map).map((k) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(map[k])}</option>`).join("");
    return `<h3><span>${esc(title)}</span><button class="dy-x" type="button" data-act="modal-close" aria-label="Закрыть">✕</button></h3>
      <form class="dy-form" id="dyGoalForm" novalidate>
        <label>Название<input type="text" name="title" maxlength="200" value="${esc(v.title)}" required /></label>
        <label>Описание<textarea name="description" rows="3" maxlength="2000">${esc(v.description)}</textarea></label>
        <div class="two">
          <label>Приоритет<select name="priority">${sel(PRIORITY, v.priority)}</select></label>
          <label>Категория<select name="category">${sel(CATEGORY, v.category)}</select></label>
        </div>
        <div class="two">
          <label>Срок (необязательно)<input type="date" name="deadline" value="${esc(v.deadline || "")}" /></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="urgent" ${v.urgent ? "checked" : ""}/> Срочная</label>
        </div>
        ${withSubs ? `<label>Подзадачи — по одной в строке, время после «|» (например: Открыть урок | 15)<textarea name="subs" rows="5">${esc(v.subsText || "")}</textarea></label>` : ""}
        <div class="dy-form-err" id="dyFormErr" role="alert"></div>
        <div class="dy-btns" style="margin-top:0"><button class="primary-btn" type="submit">Сохранить</button><button class="dy-sbtn" type="button" data-act="modal-close">Отмена</button></div>
      </form>`;
  }

  /* Читает и проверяет форму; при ошибке пишет её в форму и возвращает null */
  function readGoalForm(form, withSubs) {
    const f = form.elements;
    const title = f.title.value.trim();
    const err = (t) => { $("dyFormErr").textContent = t; return null; };
    if (!title) return err("Напиши название цели.");
    const deadline = f.deadline.value || null;
    if (deadline && !validK(deadline)) return err("Дата указана неверно.");
    return {
      title, description: f.description.value.trim(), priority: f.priority.value, category: f.category.value,
      deadline, urgent: f.urgent.checked, subtasks: withSubs ? parseSubLines(f.subs.value) : [],
    };
  }

  function openGoalForm(opts) {
    const m = openModal(goalFormHtml(opts.title, opts.values, opts.withSubs));
    const form = m.querySelector("#dyGoalForm");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const vals = readGoalForm(form, opts.withSubs);
      if (!vals) return;
      if (opts.onSave(vals) !== false) closeModal();
    });
  }

  function newGoalForm() {
    openGoalForm({
      title: "Новая цель", withSubs: true,
      values: { title: "", description: "", priority: "unknown", category: "other", deadline: "", urgent: false, subsText: "" },
      onSave: (vals) => {
        const g = createGoal(Object.assign({}, vals, { sourceDates: [] }));
        vals.subtasks.forEach((s, i) => createSub(g.id, s.title, s.est, i));
        afterMutation();
        say("Цель добавлена.");
        sfx("mark");
      },
    });
  }

  function editGoalForm(g) {
    openGoalForm({
      title: "Изменить цель", withSubs: false,
      values: { title: g.title, description: g.description, priority: g.priority, category: g.category, deadline: g.deadline, urgent: g.urgent },
      onSave: (vals) => {
        Object.assign(g, { title: vals.title.slice(0, 200), description: vals.description.slice(0, 2000), priority: vals.priority, category: vals.category, deadline: vals.deadline, urgent: vals.urgent });
        touch(g);
        afterMutation();
      },
    });
  }

  function acceptForm(a, i) {
    const p = (a.result.goals || [])[i];
    if (!p) return;
    openGoalForm({
      title: "Новая цель из анализа", withSubs: true,
      values: {
        title: p.title, description: p.description, priority: p.priority, category: p.category, deadline: p.deadline || "", urgent: p.urgent,
        subsText: (p.subtasks || []).map((s) => (s.estimated_minutes ? `${s.title} | ${s.estimated_minutes}` : s.title)).join("\n"),
      },
      onSave: (vals) => {
        const dup = findSimilarGoal(vals.title);
        if (dup && norm(dup.title) === norm(vals.title) && !confirm(`Цель «${dup.title}» уже есть. Создать ещё одну такую же?`)) return false;
        acceptProposal(a, i, vals);
        afterMutation();
        say("Цель добавлена.");
        sfx("markGood");
      },
    });
  }

  function infoModal(g) {
    const subs = subsOf(g.id);
    const total = subs.reduce((s, x) => s + (x.done ? 0 : x.est || 0), 0);
    const sec = (h, body) => `<div class="dy-info-sec"><h4>${h}</h4>${body}</div>`;
    openModal(`<h3><span>${esc(g.title)}</span><button class="dy-x" type="button" data-act="modal-close" aria-label="Закрыть">✕</button></h3>
      ${g.description ? sec("О цели", `<p>${esc(g.description)}</p>`) : ""}
      ${g.reason ? sec("Почему она выделена", `<p>${esc(g.reason)}</p>`) : ""}
      ${g.recommendations.length ? sec("Как приступить", `<ul>${g.recommendations.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`) : sec("Как приступить", `<p>Рекомендаций пока нет: цель создана вручную или ИИ их не дал. Напиши о ней в дневнике и запусти анализ.</p>`)}
      ${subs.length ? sec("Осталось по оценке", `<p>${total ? `около ${total} мин` : "оценок времени нет"} · выполнено ${subs.filter((s) => s.done).length} из ${subs.length}</p>`) : ""}
      ${g.sourceDates.length ? sec("Упоминалась в записях", `<p>${g.sourceDates.map((d) => `<button class="dy-link" type="button" data-act="open-date" data-date="${esc(d)}">${esc(fmtDate(d))}</button>`).join(" · ")}</p>`) : ""}
      <div class="dy-btns"><button class="dy-sbtn" type="button" data-act="modal-close">Закрыть</button></div>`);
  }

  /* ───────── действия ───────── */

  function afterMutation() {
    persist();
    syncSoon(1200);
    setStatus(V.signedIn ? "pending" : "local");
    renderSubTabs();
    if (V.sub === "goals") renderGoals(); else { renderAnalysis(); renderHistory(); }
  }

  function toggleSub(sid, checked) {
    const s = DB.subtasks[sid];
    if (!s) return;
    s.done = !!checked;
    touch(s);
    const g = DB.goals[s.goalId];
    if (g && !g.deletedAt) {
      const subs = subsOf(g.id);
      const all = subs.length > 0 && subs.every((x) => x.done);
      if (all && g.status !== "done") { g.status = "done"; touch(g); say("Все шаги выполнены — цель закрыта."); sfx("markGood"); }
      else if (!all && g.status === "done") { g.status = "in_progress"; touch(g); }
      else if (s.done && g.status === "not_started") { g.status = "in_progress"; touch(g); }
      else if (s.done) sfx("mark");
    }
    afterMutation();
  }

  function exportJson() {
    commitForm();
    const entries = Object.values(DB.entries).filter((e) => !e.deletedAt).sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((e) => ({ date: e.date, body: e.body, fields: cleanFields(e.fields), updated_at: iso(e.updatedAt) }));
    const goals = liveGoals().map((g) => ({
      id: g.id, title: g.title, description: g.description, priority: g.priority, urgent: g.urgent, category: g.category,
      deadline: g.deadline, status: g.status, reason: g.reason, recommendations: g.recommendations, source_dates: g.sourceDates,
      created_at: iso(g.createdAt), updated_at: iso(g.updatedAt),
      subtasks: subsOf(g.id).map((s) => ({ id: s.id, title: s.title, estimated_minutes: s.est, done: s.done, position: s.position })),
    }));
    const analyses = Object.values(DB.analyses).sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => ({ id: a.id, entry_date: a.entryDate, model: a.model, created_at: iso(a.createdAt), result: a.result, feedback: a.feedback }));
    const blob = new Blob([JSON.stringify({ app: "profession-tracker", kind: "diary-export", version: 1, exported_at: new Date().toISOString(), entries, goals, analyses }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `diary-${todayK()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    say(`Экспортировано: записей ${entries.length}, целей ${goals.length}.`);
  }

  async function fnError(error) {
    let code = "", message = "", status = 0;
    try {
      const ctx = error && error.context;
      if (ctx) {
        status = ctx.status || 0;
        if (typeof ctx.json === "function") { const b = await ctx.json(); code = b.error || ""; message = b.message || ""; }
      }
    } catch { /* ignore */ }
    if (!code && status === 404) code = "not_deployed";
    if (!code && error && (error.code === "client_timeout")) code = "client_timeout";
    if (!code && (!status || (error && /fetch|network|Failed/i.test(error.name + " " + error.message)))) code = "network";
    return { code, text: FN_MESSAGES[code] || message || "Не удалось получить анализ. Повтори позже." };
  }

  async function analyze() {
    if (V.analyzing) return;
    commitForm();
    const date = V.date;
    const e = liveEntry(date);
    if (!e || entryText(e).length < MIN_ANALYZE) { say("Сначала напиши хотя бы пару предложений."); return; }
    const s = await getSessionSafe();
    if (!s) { V.aerr = { date, text: FN_MESSAGES.unauthorized }; renderAnalysis(); return; }
    V.analyzing = { date };
    V.aerr = null;
    renderAnalysis();
    try {
      for (let k = 0; k < 2; k++) {
        await runSync();
        const cur = liveEntry(date);
        if (cur && !cur.dirty) break;
      }
      if (V.noTables) throw { code: "no_tables" };
      const cur = liveEntry(date);
      if (!cur || cur.dirty) throw { code: "not_synced" };

      const { data, error } = await withTimeout(client().functions.invoke(FN, { body: { entry_date: date } }), 90000);
      if (error) { const fe = await fnError(error); throw { code: fe.code, text: fe.text }; }
      const a = data && data.analysis;
      if (!a || !a.id || !a.result || !Array.isArray(a.result.goals)) throw { code: "bad", text: "Сервер вернул неожиданный ответ. Повтори." };
      if (DB.analyses[a.id]) DB.analyses[a.id].forUpdatedAt = cur.updatedAt; /* не затираем локальные решения */
      else DB.analyses[a.id] = Object.assign(fromAnalysis(a), { forUpdatedAt: cur.updatedAt });
      persist();
      say(data.cached ? "Запись не менялась — показал сохранённый анализ." : "Анализ готов. Проверь предложения.");
      sfx("mark");
    } catch (err) {
      const text = (err && err.text) || FN_MESSAGES[err && err.code] || (err && err.code === "client_timeout" ? FN_MESSAGES.client_timeout : "Не удалось получить анализ. Повтори позже.");
      V.aerr = { date, text, code: err && err.code };
      console.warn("Дневник: анализ не удался", err);
    } finally {
      V.analyzing = null;
      renderAnalysis();
    }
  }

  /* ───────── события ───────── */

  function onClick(ev) {
    const t = ev.target.closest("[data-act]");
    if (!t || t.tagName === "FORM" || t.tagName === "SELECT" || t.type === "checkbox") return;
    const act = t.dataset.act;
    const a = t.dataset.a ? DB.analyses[t.dataset.a] : null;
    const i = t.dataset.i != null ? parseInt(t.dataset.i, 10) : -1;
    const g = t.dataset.g ? DB.goals[t.dataset.g] : null;

    switch (act) {
      case "sub":
        commitForm();
        V.sub = t.dataset.sub;
        try { localStorage.setItem(KEY + ":view", V.sub); } catch { /* ignore */ }
        renderAll();
        break;
      case "goto-goals": V.sub = "goals"; renderAll(); window.scrollTo({ top: 0, behavior: "smooth" }); break;
      case "date-prev": gotoDate(shiftK(V.date, -1)); break;
      case "date-next": gotoDate(shiftK(V.date, 1)); break;
      case "date-today": gotoDate(todayK()); break;
      case "open-date":
        closeModal();
        commitForm();
        V.sub = "entry";
        V.date = t.dataset.date;
        renderAll();
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "more": V.shown += 30; renderHistory(); break;
      case "analyze": analyze(); break;
      case "export": exportJson(); break;
      case "entry-delete":
        if (!confirm(`Удалить запись за ${fmtDate(V.date, FMT_LONG)} вместе с её анализом? Это нельзя отменить.`)) break;
        clearTimeout(saveTimer);
        deleteEntry(V.date);
        persist();
        syncSoon(500);
        V.aerr = null;
        renderForm();
        renderAnalysis();
        renderHistory();
        setStatus(V.signedIn ? "pending" : "local");
        say("Запись удалена.");
        break;
      case "prop-accept": if (a) acceptForm(a, i); break;
      case "prop-merge": if (a && mergeProposal(a, i, t.dataset.g)) { afterMutation(); say("Шаги добавлены к существующей цели."); sfx("mark"); } break;
      case "prop-reject": if (a) { setFeedback(a, "goal:" + i, "rejected"); afterMutation(); } break;
      case "prop-restore": if (a) { setFeedback(a, "goal:" + i, null); afterMutation(); } break;
      case "proc-yes": if (a) { setFeedback(a, "proc:" + i, a.feedback["proc:" + i] === "confirmed" ? null : "confirmed"); afterMutation(); } break;
      case "proc-no": if (a) { setFeedback(a, "proc:" + i, a.feedback["proc:" + i] === "rejected" ? null : "rejected"); afterMutation(); } break;
      case "goal-new": newGoalForm(); break;
      case "goal-edit": if (g) editGoalForm(g); break;
      case "goal-info": if (g) infoModal(g); break;
      case "goal-irrelevant":
        if (g && confirm(`Отметить цель «${g.title}» неактуальной? ИИ не будет предлагать её снова.`)) { g.status = "cancelled"; touch(g); afterMutation(); }
        break;
      case "goal-delete":
        if (g && confirm(`Удалить цель «${g.title}» вместе с подзадачами?`)) { removeGoal(g); afterMutation(); say("Цель удалена."); }
        break;
      case "sub-del": {
        const s = DB.subtasks[t.dataset.s];
        if (s) { touch(s); s.deletedAt = s.updatedAt; afterMutation(); }
        break;
      }
      case "modal-close": closeModal(); break;
      default: break;
    }
  }

  function onChange(ev) {
    const t = ev.target;
    if (t.id === "dyDate") { gotoDate(t.value); return; }
    if (t.dataset && t.dataset.act === "goal-status") {
      const g = DB.goals[t.dataset.g];
      if (g && STATUS[t.value]) { g.status = t.value; touch(g); afterMutation(); if (t.value === "done") { say("Цель выполнена."); sfx("markGood"); } }
    } else if (t.dataset && t.dataset.act === "sub-toggle") {
      toggleSub(t.dataset.s, t.checked);
    }
  }

  function onSubmit(ev) {
    const f = ev.target;
    if (f.dataset && f.dataset.act === "sub-add") {
      ev.preventDefault();
      const g = DB.goals[f.dataset.g];
      const title = f.elements.t.value.trim();
      if (!g || !title) return;
      const pos = subsOf(g.id).reduce((m, s) => Math.max(m, s.position), -1) + 1;
      createSub(g.id, title, null, pos);
      if (g.status === "done") { g.status = "in_progress"; touch(g); }
      afterMutation();
    }
  }

  function onInput(ev) {
    const t = ev.target;
    if (t.id === "dyBody" || (t.dataset && t.dataset.field)) onFormInput();
    else if (t.id === "dyQ") { V.q = t.value; V.shown = 30; renderHistory(); }
  }

  function wire() {
    const root = $("panel-diary");
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("input", onInput);
    /* модальное окно живёт в body — свой обработчик */
    document.addEventListener("click", (ev) => { if (ev.target.closest && ev.target.closest("#dyModal")) onClick(ev); });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { commitForm(); persist(); } else if (V.signedIn) syncSoon(300);
    });
    window.addEventListener("pagehide", () => { commitForm(); persist(); });
    window.addEventListener("online", () => syncSoon(500));
    /* другая вкладка браузера изменила дневник */
    window.addEventListener("storage", (ev) => {
      if (ev.key !== KEY || !ev.newValue) return;
      DB = loadDb();
      renderAll(isTyping());
    });
  }

  function init() {
    if (!buildShell()) return;
    wire();
    renderAll();
    setStatus(anyDirty() ? "pending" : "local");
    hookAuth();
    window.diaryExport = exportJson;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
