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

    /* Подписку ставим ДО обмена кода: иначе SIGNED_IN от обмена
       пройдёт мимо обработчика и синхронизация не запустится. */
    sb.auth.onAuthStateChange((event, newSession) => {
      session = newSession;
      renderAccount();
      if (typeof renderPushBox === "function") renderPushBox();
      if (event === "SIGNED_IN") pullThenPush();
    });

    await reportOauthError();

    /* Если в адресе остался code — довершаем вход сами: автообмен
       мог сорваться, а повторный запрос со свежим состоянием проходит. */
    await exchangeCodeManually();

    const { data } = await sb.auth.getSession();
    session = data.session || null;

    if (session) await pullThenPush();
    else if (hasLocalData()) await maybeOfferMigration();
  } catch (e) {
    console.warn("Синхронизация недоступна", e);
    sb = null;
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

/* Разложить состояние на строки dto для таблиц. */
function stateToRows(userId) {
  const meta = state.meta || {};
  /* Отправляем только те дни, где есть реальные минуты.
     Уровни больше не хранятся: они считаются из часов на любом устройстве. */
  const dates = Object.keys(state.hours || {}).filter((d) => {
    const day = state.hours[d] || {};
    return Object.values(day).some((m) => m > 0);
  });

  return dates.map((date) => ({
    user_id: userId,
    date,
    hours: state.hours[date],
    mode: (state.modes || {})[date] || null,
    updated_at: new Date(meta[date] || Date.now()).toISOString(),
  }));
}

/* Собрать состояние из строк сервера, слив с локальным по времени. */
function mergeRowsIntoState(rows) {
  /* state.days здесь не нужен: уровни больше не хранятся, только минуты. */
  state.modes = state.modes || {};
  state.meta = state.meta || {};

  rows.forEach((row) => {
    const remoteTs = new Date(row.updated_at).getTime() || 0;
    const localTs = state.meta[row.date] || 0;

    if (remoteTs > localTs) {
      if (row.mode) state.modes[row.date] = row.mode;

      /* Часы — единственный источник. Старые строки (до перехода) содержат
         только blocks с уровнями: переводим их в минуты по порогам блока. */
      state.hours = state.hours || {};
      if (row.hours && Object.keys(row.hours).length) {
        state.hours[row.date] = row.hours;
      } else if (row.blocks && typeof hoursFromLegacyLevels === "function") {
        const legacy = hoursFromLegacyLevels(row.blocks);
        if (legacy && Object.keys(legacy).length) state.hours[row.date] = legacy;
      }

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
