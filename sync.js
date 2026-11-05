/* Синхронизация с Supabase: аккаунт через Google, данные на сервере.
   Пока ключи не вписаны — модуль молча выключен, сайт работает локально.
   Никакая ошибка сети не должна ломать трекер: всё в try/catch. */

const SUPABASE_URL = ""; // например https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = ""; // anon public key из настроек проекта

const SYNC_PENDING_KEY = "vp-tracker-pending";

let sb = null; // клиент
let session = null;
let syncBusy = false;
let pushTimer = null;

function syncConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/* ─────────── загрузка SDK ─────────── */

async function initSync() {
  if (!syncConfigured()) {
    renderAccount();
    return;
  }

  try {
    /* SDK грузим динамически: без настроенного Supabase лишних запросов нет */
    const mod = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    const { data } = await sb.auth.getSession();
    session = data.session || null;

    sb.auth.onAuthStateChange((event, newSession) => {
      session = newSession;
      renderAccount();
      if (event === "SIGNED_IN") pullThenPush();
    });

    if (session) await pullThenPush();
    else if (hasLocalData()) await maybeOfferMigration();
  } catch (e) {
    console.warn("Синхронизация недоступна", e);
  }

  renderAccount();
}

/* ─────────── вход / выход ─────────── */

async function signInWithGoogle() {
  if (!sb) {
    toast("Сначала впиши ключи Supabase — инструкция в README.");
    return;
  }
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) toast("Не получилось войти: " + error.message);
}

async function signOut() {
  if (!sb) return;
  await sb.auth.signOut();
  session = null;
  renderAccount();
  toast("Вышел из аккаунта. Данные остались на этом устройстве.");
}

/* ─────────── чтение / запись ─────────── */

function hasLocalData() {
  const d = state.days || {};
  return Object.keys(d).length > 0 || (state.leetcode || []).length > 0;
}

/* Разложить состояние на строки dto для таблиц. */
function stateToRows(userId) {
  const meta = state.meta || {};
  const rows = Object.keys(state.days || {}).map((date) => ({
    user_id: userId,
    date,
    blocks: state.days[date],
    mode: (state.modes || {})[date] || null,
    updated_at: new Date(meta[date] || Date.now()).toISOString(),
  }));
  return rows;
}

/* Собрать состояние из строк сервера, слив с локальным по времени. */
function mergeRowsIntoState(rows) {
  state.days = state.days || {};
  state.modes = state.modes || {};
  state.meta = state.meta || {};

  rows.forEach((row) => {
    const remoteTs = new Date(row.updated_at).getTime() || 0;
    const localTs = state.meta[row.date] || 0;

    if (remoteTs > localTs) {
      state.days[row.date] = row.blocks || {};
      if (row.mode) state.modes[row.date] = row.mode;
      state.meta[row.date] = remoteTs;
    }
  });
}

async function pullThenPush() {
  if (!sb || !session) return;
  if (syncBusy) return;
  syncBusy = true;

  try {
    const { data, error } = await sb
      .from("days")
      .select("date,blocks,mode,updated_at")
      .eq("user_id", session.user.id);

    if (error) throw error;

    if (data && data.length) {
      mergeRowsIntoState(data);
      saveLocalOnly();
      renderAll();
    }

    await pushAll();
    await pullSettings();
    toast("Синхронизировано");
  } catch (e) {
    console.warn("Не удалось синхронизировать", e);
    toast("Нет связи с сервером — работаем локально.");
  } finally {
    syncBusy = false;
  }
}

async function pushAll() {
  if (!sb || !session) return;
  const rows = stateToRows(session.user.id);
  if (!rows.length) return;

  const { error } = await sb.from("days").upsert(rows, { onConflict: "user_id,date" });
  if (error) throw error;
}

/* Настройки — отдельная строка. */
async function pushSettings() {
  if (!sb || !session) return;
  try {
    await sb.from("settings").upsert(
      {
        user_id: session.user.id,
        week: state.week,
        schedule_view: state.scheduleView,
        achievements: state.achievements || {},
        leetcode: state.leetcode || [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
  } catch (e) {
    console.warn("Настройки не ушли", e);
  }
}

async function pullSettings() {
  if (!sb || !session) return;
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
  if (pending) syncSoon();
});

/* Вернулись во вкладку — подтягиваем изменения с других устройств. */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sb && session && !syncBusy) pullThenPush();
});

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
    root.innerHTML = `
      <div class="acc-row">
        <span class="acc-dot off"></span>
        <div>
          <div class="acc-title">Войди, чтобы синхронизировать</div>
          <div class="acc-sub">Один аккаунт — телефон и компьютер видят одни и те же отметки.</div>
        </div>
      </div>
      <button class="primary-btn acc-btn" id="googleSignIn">Войти через Google</button>`;
    document.getElementById("googleSignIn").addEventListener("click", signInWithGoogle);
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
