/* «Возвращение в профессию» — логика трекера */

const STORE_KEY = "vp-tracker-v1";

/* Версия сборки — видна в профиле. Менять вместе с VERSION в sw.js. */
const BUILD_LABEL = "сборка v24";

const DEFAULT_STATE = {
  days: {},        // legacy: старые уровни { "2026-11-04": { ulbi: "norm" } }, только для миграции
  modes: {},       // { "2026-11-04": "bad" | "norm" | "good" }
  gym: {},         // { "1": { mon: true, wed: false, fri: true } }
  week: 1,
  leetcode: [],    // [{ id, name, theme, diff, date }]
  hours: {},        // { "2026-11-04": { ulbi: 95, leetcode: 30 } } — единственный источник: минуты
  namaz: {},        // { "2026-11-06": { fajr: true, ... } } — отмеченные намазы
  namazOn: true,    // показывать блок намаза
  timer: null,      // legacy, не используется: таймер живёт в state.hours[дата][блок].timer
  scheduleView: "detail", // "detail" | "coarse"
  achievements: {}, // { id: ISO-дата открытия }
  meta: {},         // { "2026-11-04": timestamp последнего изменения } — для синка
};

/* structuredClone есть не везде (Safari < 15.4) — без него падал весь трекер */
const cloneDeep = (obj) =>
  typeof structuredClone === "function"
    ? structuredClone(obj)
    : JSON.parse(JSON.stringify(obj));

let state = load();

/* ─────────── таймер ───────────
   Таймер живёт в тех же данных, что и время: state.hours[дата][блок] = { min, timer }.
   timer.startedAt — обычный ISO-таймстемп (как updated_at в базе). Тикающее время
   нигде не хранится, оно всегда считается как now − startedAt. Поэтому перезагрузка,
   закрытие страницы и синхронизация ничего не сбрасывают. */

/* Запись блока: { min, timer }. Число минут — старый формат, понимаем и его. */
function blockRecord(dateKey, blockId) {
  const day = (state.hours || {})[dateKey];
  const rec = day ? day[blockId] : null;
  if (rec === undefined || rec === null) return { min: 0, timer: null };
  if (typeof rec === "number") return { min: rec, timer: null };
  return { min: Number(rec.min) || 0, timer: rec.timer || null };
}

/* Идущий таймер по блоку: { startedAt, startedAtIso } или null. */
function timerFor(dateKey, blockId) {
  const t = blockRecord(dateKey, blockId).timer;
  if (!t || !t.startedAt) return null;
  const ts = new Date(t.startedAt).getTime();
  if (!Number.isFinite(ts)) return null;
  return { startedAt: ts, startedAtIso: new Date(ts).toISOString() };
}

/* Все идущие таймеры — по всем дням и блокам. */
function runningTimers() {
  const out = [];
  Object.keys(state.hours || {}).forEach((dateKey) => {
    const day = state.hours[dateKey] || {};
    Object.keys(day).forEach((blockId) => {
      const t = timerFor(dateKey, blockId);
      if (t) out.push({ date: dateKey, block: blockId, startedAt: t.startedAt, startedAtIso: t.startedAtIso });
    });
  });
  return out;
}

/* Единственное место, где пишутся минуты дня. Идущий таймер сохраняется. */
function writeMinutes(dateKey, blockId, minutes) {
  if (!state.hours) state.hours = {};
  const day = state.hours[dateKey] || (state.hours[dateKey] = {});
  const next = Math.max(0, Math.round(minutes || 0));
  const timer = blockRecord(dateKey, blockId).timer;
  if (!next && !timer) delete day[blockId];
  else day[blockId] = timer ? { min: next, timer } : { min: next };
  if (!Object.keys(day).length) delete state.hours[dateKey];
  touchDay(dateKey);
  save();
}

/* Включить/выключить таймер блока, не трогая записанные минуты. */
function setBlockTimer(dateKey, blockId, startedAtIso) {
  if (!state.hours) state.hours = {};
  const day = state.hours[dateKey] || (state.hours[dateKey] = {});
  const min = blockRecord(dateKey, blockId).min;
  if (!min && !startedAtIso) delete day[blockId];
  else day[blockId] = startedAtIso ? { min, timer: { startedAt: startedAtIso } } : { min };
  if (!Object.keys(day).length) delete state.hours[dateKey];
  touchDay(dateKey);
  save();
}

/* Больше 12 часов подряд — это забытый таймер: пишем максимум 12 ч и говорим вслух. */
const TIMER_MAX_MIN = 12 * 60;

/* Пока идёт загрузка (миграции, обрезка забытых таймеров) — пишем только
   в localStorage: экран ещё не собран, render-функции трогать нельзя. */
var booting = true;

/* ── Однократная миграция старых данных: уровни в state.days и одиночный state.timer.
   Старые «отмечено» не теряем. */
(function migrateOldData() {
  let moved = 0;

  if (!state.hoursMigratedV1) {
    Object.keys(state.days || {}).forEach((date) => {
      const blocks = state.days[date] || {};
      Object.keys(blocks).forEach((id) => {
        const level = blocks[id];
        if (!LEVEL_ORDER[level]) return;
        const need = minutesForLevel(id, level);
        if (!blockRecord(date, id).min && need) {
          state.hours[date] = state.hours[date] || {};
          state.hours[date][id] = { min: need };
          moved++;
        }
      });
    });
    delete state.days;
    state.hoursMigratedV1 = true;
  }

  /* Одиночный таймер { block, date, startedAt } переезжает в свой блок. */
  if (state.timer && state.timer.block && state.timer.startedAt) {
    const d = state.timer.date || todayKey();
    const id = state.timer.block;
    if (!timerFor(d, id)) {
      const ts = new Date(state.timer.startedAt).getTime();
      if (Number.isFinite(ts)) {
        state.hours[d] = state.hours[d] || {};
        const min = blockRecord(d, id).min;
        state.hours[d][id] = { min, timer: { startedAt: new Date(ts).toISOString() } };
      }
    }
  }
  delete state.timer;

  /* Забытый таймер (страница закрыта вчера) не должен записать сутки. */
  runningTimers()
    .filter((t) => Date.now() - t.startedAt > TIMER_MAX_MIN * 60000)
    .forEach((t) => {
      const rec = blockRecord(t.date, t.block);
      const add = Math.min(Math.round((Date.now() - t.startedAt) / 60000), TIMER_MAX_MIN);
      setBlockTimer(t.date, t.block, null);
      writeMinutes(t.date, t.block, rec.min + add);
      setTimeout(() => {
        toast(`Таймер по «${blockName(t.block)}» шёл слишком долго — записал ${fmtMinutes(add)}. Проверь время.`);
      }, 1200);
    });

  saveLocalOnly();
  if (moved) console.log("Мигрировано отметок в минуты:", moved);
  booting = false;
})();

/* ─────────────── утилиты ─────────────── */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return cloneDeep(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return normalizeStateHours({ ...cloneDeep(DEFAULT_STATE), ...parsed });
  } catch {
    return cloneDeep(DEFAULT_STATE);
  }
}

/* Данные блока в хранилище приводим к одному виду: { min, timer? }.
   Страховка от «обновил страницу — время пропало»: читаем и старые числа,
   и старые уровни, чтобы ничего не потерять. */
function normalizeStateHours(st) {
  const out = {};
  const src = st.hours || {};
  Object.keys(src).forEach((date) => {
    const day = src[date];
    if (!day || typeof day !== "object") return;
    const norm = {};
    Object.keys(day).forEach((id) => {
      const rec = day[id];
      if (typeof rec === "number") {
        if (rec > 0) norm[id] = { min: rec };
        return;
      }
      if (!rec || typeof rec !== "object") return;
      const min = Number(rec.min) || 0;
      let timer = null;
      if (rec.timer && rec.timer.startedAt) {
        const ts = new Date(rec.timer.startedAt).getTime();
        if (Number.isFinite(ts)) timer = { startedAt: new Date(ts).toISOString() };
      }
      if (min > 0 || timer) norm[id] = timer ? { min, timer } : { min };
    });
    if (Object.keys(norm).length) out[date] = norm;
  });
  st.hours = out;
  return st;
}

/* Запись только в браузер — используется синхронизацией, чтобы не было цикла. */
function saveLocalOnly() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Не удалось сохранить", e);
  }
}

function save() {
  saveLocalOnly();
  if (booting) return;
  if (typeof refreshAchievements === "function") refreshAchievements();
  if (typeof syncSoon === "function") syncSoon();
}

function todayKey() {
  const d = new Date();
  return keyOf(d);
}

/* Дата позже сегодняшней. Сравнение строк безопасно: формат YYYY-MM-DD
   сортируется лексикографически так же, как календарно. */
function isFutureDate(key) {
  return typeof key === "string" && key > todayKey();
}

function keyOf(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateOf(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* ─────────── время: минуты ↔ «1 ч 20 мин» ─────────── */

function fmtMinutes(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (!m) return "0 мин";
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} мин`;
  if (!rest) return `${h} ч`;
  return `${h} ч ${rest} мин`;
}

/* Компактно — для плашек и итогов: «2:35» */
function fmtShort(min) {
  const m = Math.max(0, Math.round(min || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/* Разбор ручного ввода: «45», «-15», «1.5» (=90 мин), «1,5», «1 ч 30», «1:30». */
function parseMinutesInput(raw) {
  const text = String(raw == null ? "" : raw).trim().toLowerCase().replace(",", ".");
  if (!text) return null;
  const sign = text.startsWith("-") ? -1 : 1;

  const colon = text.match(/^[+-]?(\d+):(\d{1,2})$/);
  if (colon) return sign * (parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10));

  const minutesWord = text.match(/^[+-]?(\d+(?:\.\d+)?)\s*(?:мин[а-я]*|м|m)$/);
  if (minutesWord) return sign * Math.round(parseFloat(minutesWord[1]));

  const hoursWithMin = text.match(/^[+-]?(\d+(?:\.\d+)?)\s*(?:ч|час[а-я]*|h)\s*(\d+)?\s*(?:мин[а-я]*|м|m)?$/);
  if (hoursWithMin) {
    const h = Math.abs(parseFloat(hoursWithMin[1]));
    const m = hoursWithMin[2] ? parseInt(hoursWithMin[2], 10) : Math.round((h % 1) * 60);
    return sign * Math.round(Math.floor(h) * 60 + m);
  }

  const plain = text.match(/^[+-]?(\d+(?:\.\d+)?)$/);
  if (plain) {
    const v = Math.abs(parseFloat(plain[1]));
    /* целое до 12 — считаем минутами («45»), дробное или «10» — часами? Нет:
       «45» это минуты, «1.5» — часы. Целое ≥ 13 тоже минуты. */
    if (v % 1 !== 0) return sign * Math.round(v * 60);
    return sign * Math.round(v);
  }
  return null;
}

/* «чч:мм» по таймстемпу — подсказка «идёт с 14:05» */
function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Минуты блока в хранилище: число (старый формат) или { min, timer }. */
function blockMinutes(rec) {
  if (rec === undefined || rec === null) return 0;
  if (typeof rec === "number") return rec;
  return Number(rec.min) || 0;
}

/* Записанные минуты — без идущего таймера. Именно это уходит в базу. */
function savedMinutesFor(dateKey, blockId) {
  const day = (state.hours || {})[dateKey] || {};
  if (!blockId) return Object.keys(day).reduce((sum, id) => sum + blockMinutes(day[id]), 0);
  return blockMinutes(day[blockId]);
}

/* Сколько сейчас тикает по блоку (незаписанные минуты). */
function runningMinutesFor(dateKey, blockId) {
  const t = timerFor(dateKey, blockId);
  if (!t) return 0;
  return Math.max(0, Math.floor((Date.now() - t.startedAt) / 60000));
}

/* Минуты «как есть сейчас»: записанные + тикающий таймер.
   Отсюда считается всё, что видит человек: уровни, прогресс, плашки. */
function hoursFor(dateKey, blockId) {
  const saved = savedMinutesFor(dateKey, blockId);
  if (!blockId) {
    const day = (state.hours || {})[dateKey] || {};
    return saved + Object.keys(day).reduce((sum, id) => sum + runningMinutesFor(dateKey, id), 0);
  }
  return saved + runningMinutesFor(dateKey, blockId);
}

/* Что показать как «уровень»: считается из минут, отдельно не хранится. */
function levelOf(dateKey, blockId) {
  return levelFromMinutes(blockId, hoursFor(dateKey, blockId));
}

/* Старое хранилище: { ulbi: "norm" } → { ulbi: 120 } по порогам блока. */
function hoursFromLegacyLevels(blocks) {
  const out = {};
  Object.keys(blocks || {}).forEach((id) => {
    const level = blocks[id];
    const need = LEVEL_ORDER[level] ? minutesForLevel(id, level) : 0;
    if (need) out[id] = { min: need };
  });
  return out;
}

/* «Отметить уровень» = поставить ровно столько минут, сколько нужно порогу.
   Если по блоку идёт таймер — сначала забираем его тикающее время,
   иначе оно потеряется. */
function setBlockMinutes(dateKey, blockId, minutes) {
  if (timerFor(dateKey, blockId)) stopTimer(dateKey, blockId);
  writeMinutes(dateKey, blockId, minutes);
}

function addHours(dateKey, blockId, deltaMin) {
  if (timerFor(dateKey, blockId)) stopTimer(dateKey, blockId);
  writeMinutes(dateKey, blockId, savedMinutesFor(dateKey, blockId) + deltaMin);
}


function startTimer(blockId) {
  const running = runningTimers();
  if (running.length) {
    toast(`Уже идёт таймер: «${blockName(running[0].block)}». Сначала останови его.`);
    return;
  }
  setBlockTimer(selectedDate, blockId, new Date().toISOString());
  renderAll();
  toast(`Таймер пошёл: ${blockName(blockId)}`);
  play("tick");
}

/* Стоп: тикающее время переезжает в записанные минуты. */
function stopTimer(dateKey, blockId) {
  const targets = [];
  if (blockId) targets.push({ date: dateKey || selectedDate, block: blockId });
  else runningTimers().forEach((t) => targets.push({ date: t.date, block: t.block }));
  if (!targets.length) return;

  let total = 0;
  targets.forEach(({ date, block }) => {
    const t = timerFor(date, block);
    if (!t) return;
    let min = Math.round((Date.now() - t.startedAt) / 60000);
    const rec = blockRecord(date, block);
    if (min > TIMER_MAX_MIN) {
      min = TIMER_MAX_MIN;
      toast("Таймер шёл больше 12 часов — записал 12 ч. Похоже, забыл остановить.");
    }
    setBlockTimer(date, block, null);
    if (min >= 1) {
      writeMinutes(date, block, rec.min + min);
      total += min;
    } else {
      writeMinutes(date, block, rec.min);
    }
  });

  if (total >= 1) {
    toast(`Записано ${fmtMinutes(total)}.`);
    play("markGood");
  } else {
    toast("Меньше минуты — не записал.");
  }
  renderAll();
}

/* выбранная дата — объявляем до всего, что её читает */
var selectedDate = todayKey();

function blockName(id) {
  const b = BLOCKS.find((x) => x.id === id);
  return b ? b.name : id;
}

function shiftDay(key, delta) {
  const d = dateOf(key);
  d.setDate(d.getDate() + delta);
  return keyOf(d);
}

/* понедельник = 0 */
function weekdayIndex(key) {
  return (dateOf(key).getDay() + 6) % 7;
}

const humanDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", weekday: "long" });
const DATE_FMT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

/* Данные дня = минуты по блокам. Отдельного «уровня» в базе больше нет. */
/* Отметка времени изменения дня — по ней синхронизация решает,
   чья версия свежее (телефон или компьютер). */
function touchDay(key) {
  if (!state.meta) state.meta = {};
  state.meta[key] = Date.now();
}

function modeFor(key) {
  return state.modes[key] || "norm";
}

/* ─────────────── дневной чек-лист ─────────────── */

const blocksRoot = document.getElementById("blocks");
const tipsState = new Set();

function renderBlocks() {
  blocksRoot.innerHTML = "";

  BLOCKS.forEach((b) => {
    const future = isFutureDate(selectedDate);
    const minutes = hoursFor(selectedDate, b.id);
    const lvl = levelFromMinutes(b.id, minutes);
    const card = el("div", "block" + (lvl ? " done" : "") + (future ? " future" : ""));
    card.dataset.id = b.id;
    card.dataset.level = lvl || "";

    const top = el("div", "block-top");
    top.innerHTML = `
      <div class="block-icon">${b.icon}</div>
      <div class="block-info">
        <div class="block-name">${b.name}</div>
        <div class="block-desc">${b.desc}</div>
      </div>`;

    /* Плашки уровней — индикатор, а не отдельная отметка.
       Загораются сами, когда минут набралось на порог. Клик ставит время. */
    const pick = el("div", "level-pick");
    const order = ["min", "norm", "max"];
    const reached = lvl ? LEVEL_ORDER[lvl] : 0;

    order.forEach((level) => {
      const isOn = reached >= LEVEL_ORDER[level];
      const isCurrent = lvl === level;
      const btn = el(
        "button",
        "level-btn" + (isOn ? " on" : "") + (isCurrent ? " current" : ""),
        `${LEVEL_LABEL[level]}<small>${b[level]}</small>`
      );
      btn.dataset.lvl = level;
      btn.type = "button";
      btn.title =
        `Поставить ${fmtMinutes(minutesForLevel(b.id, level))} — от этого загорится «${LEVEL_LABEL[level].toLowerCase()}»`;

      btn.addEventListener("click", () => {
        const need = minutesForLevel(b.id, level);
        /* Считаем заново в момент клика: пока карточка висела, мог идти таймер
           или время прийти с другого устройства. Старое значение здесь врёт. */
        const nowMin = hoursFor(selectedDate, b.id);
        /* Никогда не отнимаем время: если его уже больше порога — просто говорим об этом.
           Иначе «минимум» затирал бы реальные 2 часа работы. */
        if (nowMin >= need) {
          if (timerFor(selectedDate, b.id)) stopTimer(selectedDate, b.id);
          const lvlNow = levelFromMinutes(b.id, hoursFor(selectedDate, b.id));
          toast(`«${b.name}»: уже ${fmtMinutes(hoursFor(selectedDate, b.id))} — это ${LEVEL_LABEL[lvlNow].toLowerCase()}.`);
          renderAll();
          return;
        }
        /* Догоняем до порога: если таймер идёт, addHours сначала его остановит
           и запишет натикавшее. */
        const delta = need - nowMin;
        addHours(selectedDate, b.id, delta);
        const after = levelFromMinutes(b.id, hoursFor(selectedDate, b.id));
        renderAll();
        play(level === "min" ? "mark" : "markGood");
        if (isFutureDate(selectedDate)) {
          toast("Отмечено на будущую дату. Пока этот день не наступил, статистика считает его закрытым.");
          return;
        }
        const msgs = {
          min: "Минимум засчитан. Этого уже достаточно.",
          norm: "Норма дня. Хорошая работа.",
          max: "Максимум — сильно. Но не превращай это в норму.",
        };
        toast(msgs[after || level]);
      });
      pick.appendChild(btn);
    });

    top.appendChild(pick);
    card.appendChild(top);

    const toggle = el("button", "tips-toggle", tipsState.has(b.id) ? "скрыть подсказки" : "что делать →");
    toggle.type = "button";
    const tips = el("ul", "block-tips" + (tipsState.has(b.id) ? " open" : ""));
    tips.innerHTML = b.tips.map((t) => `<li>${t}</li>`).join("");
    toggle.addEventListener("click", () => {
      const open = tips.classList.toggle("open");
      toggle.textContent = open ? "скрыть подсказки" : "что делать →";
      if (open) tipsState.add(b.id);
      else tipsState.delete(b.id);
    });

    /* ── учёт времени: своя строка под уровнями, не мешает им ── */
    card.appendChild(renderTimeRow(b));

    const meta = el("div", "block-meta");
    meta.style.cssText = "display:flex;align-items:center;margin-top:8px";
    meta.appendChild(toggle);
    card.appendChild(meta);
    card.appendChild(tips);

    blocksRoot.appendChild(card);
  });
}

/* Строка «сколько реально потратил» + быстрые кнопки и таймер.
   Держим одной полосой: на телефоне она переносится, на десктопе — в ряд. */
function renderTimeRow(b) {
  const row = el("div", "time-row");
  /* hoursFor уже включает идущий таймер — отдельно его не прибавляем */
  const shown = hoursFor(selectedDate, b.id);
  const timer = timerFor(selectedDate, b.id);
  const running = Boolean(timer);

  const value = el("div", "time-value" + (shown ? " has" : "") + (running ? " ticking" : ""),
    fmtMinutes(shown));
  value.title = running
    ? "Идёт таймер с " + hhmm(timer.startedAt) + ". Нажми «стоп», чтобы записать."
    : "Сколько реально потрачено на этот блок";

  const quick = el("div", "time-quick");
  [15, 30, 60].forEach((min) => {
    const btn = el("button", "time-btn", "+" + (min === 60 ? "1 ч" : min + " мин"));
    btn.type = "button";
    btn.addEventListener("click", () => {
      addHours(selectedDate, b.id, min);
      renderAll();
      play("tick");
      toast(`${b.name}: +${fmtMinutes(min)}. Всего ${fmtMinutes(hoursFor(selectedDate, b.id))}.`);
    });
    quick.appendChild(btn);
  });

  /* ручной ввод — по клику раскрывается поле, чтобы не занимать место всегда */
  const manualBtn = el("button", "time-btn time-btn-ghost", "своё");
  manualBtn.type = "button";
  manualBtn.title = "Ввести своё время";
  manualBtn.addEventListener("click", () => {
    const input = prompt("Сколько минут записать?\nМожно с минусом, чтобы убрать: -15\nМожно в часах: 1.5 = 90 минут", "45");
    if (input === null) return;
    const min = parseMinutesInput(input);
    if (min === null || min === 0) {
      toast("Не понял число. Напиши 45, -15 или 1.5 (часа).");
      return;
    }
    addHours(selectedDate, b.id, min);
    renderAll();
    play(min > 0 ? "mark" : "tick");
    toast(`${b.name}: ${min > 0 ? "+" : ""}${min} мин. Всего ${fmtMinutes(hoursFor(selectedDate, b.id))}.`);
  });
  quick.appendChild(manualBtn);

  const timerBtn = el("button", "time-btn time-start" + (running ? " running" : ""), running ? "■ стоп" : "▶ старт");
  timerBtn.type = "button";
  timerBtn.title = running ? "Остановить таймер" : "Запустить таймер для этого блока";
  timerBtn.addEventListener("click", () => (running ? stopTimer(selectedDate, b.id) : startTimer(b.id)));

  const right = el("div", "time-right");
  right.appendChild(quick);
  right.appendChild(timerBtn);

  row.appendChild(el("span", "time-label", "⏱"));
  row.appendChild(value);
  row.appendChild(right);

  /* таймер, идущий в другом блоке, не должен молчать */
  const other = runningTimers().filter((t) => !(t.date === selectedDate && t.block === b.id))[0];
  if (other) {
    row.appendChild(
      el("span", "time-other", `таймер идёт в «${blockName(other.block)}» с ${hhmm(other.startedAt)}`)
    );
  }

  return row;
}

/* ─────────────── прогресс-кольцо ─────────────── */

/* даты, по которым звук «день закрыт» уже сыграл */
const closedCelebrated = new Set();

function dayScore(key) {
  const target = MODE_TARGET[modeFor(key)];
  const values = BLOCKS.map((b) => LEVEL_ORDER[levelOf(key, b.id)] || 0);
  const got = values.reduce((s, v) => s + Math.min(v, target), 0);
  const total = BLOCKS.length * target;
  return { pct: total ? got / total : 0, done: values.filter(Boolean).length, target };
}

function renderRing() {
  const { pct, done, target } = dayScore(selectedDate);
  const C = 2 * Math.PI * 52;

  /* день закрыт впервые — короткое арпеджио (один раз на дату) */
  if (pct >= 1 && done > 0 && !closedCelebrated.has(selectedDate)) {
    closedCelebrated.add(selectedDate);
    play("dayClosed");
  } else if (pct < 1) {
    closedCelebrated.delete(selectedDate);
  }
  const fg = document.getElementById("ringFg");
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - Math.min(pct, 1));
  fg.style.stroke = pct >= 1 ? "var(--accent)" : pct >= 0.4 ? "var(--accent-3)" : "var(--norm)";

  document.getElementById("ringPct").textContent = Math.round(pct * 100) + "%";

  let text;
  if (done === 0) text = "Отметь первые задачи";
  else if (pct >= 1) text = "День закрыт. Можно спокойно закончить.";
  else if (done >= 4) text = "Хороший темп. Остаток — по силам.";
  else if (target === 1) text = "Минимум — это победа, а не полумера.";
  else text = `Сделано блоков: ${done} из ${BLOCKS.length}`;
  document.getElementById("ringText").textContent = text;

  renderFutureNote();
}

/* Заметка над блоком дня: дата ещё не наступила. Отмечать можно,
   но человек должен понимать, что статистика посчитает день закрытым. */
function renderFutureNote() {
  const box = document.getElementById("futureNote");
  if (!box) return;

  if (!isFutureDate(selectedDate)) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const today = dateOf(todayKey());
  const target = dateOf(selectedDate);
  const days = Math.round((target - today) / 86400000);
  const when = days === 1 ? "завтра" : `через ${days} ${plural(days, "день", "дня", "дней")}`;

  box.hidden = false;
  box.innerHTML =
    `⚠️ <b>Будущая дата</b> — ${when} (${humanDate.format(target)}). ` +
    `Отметки здесь разрешены, но статистика засчитает этот день как закрытый ещё до его начала.`;
}

/* ─────────────── режим дня ─────────────── */

const modeButtons = document.getElementById("modeButtons");
function renderModes() {
  modeButtons.innerHTML = "";
  const active = modeFor(selectedDate);
  Object.entries(MODES).forEach(([key, m]) => {
    const btn = el("button", "mode-btn" + (key === active ? " active" : ""), m.label);
    btn.type = "button";
    btn.dataset.mode = key;
    btn.addEventListener("click", () => {
      state.modes[selectedDate] = key;
      touchDay(selectedDate);
      save();
      renderAll();
      play("tick");
      toast(key === "bad" ? "Плохой день — цель просто что-то сделать." : m.hint);
    });
    modeButtons.appendChild(btn);
  });
  document.getElementById("modeHint").textContent = MODES[active].hint;

  document.getElementById("badDayCard").style.display = active === "bad" ? "" : "none";
}

/* ─────────────── плохой день ─────────────── */

/* ─────────────── намаз ─────────────── */

function namazEnabled() {
  return state.namazOn !== false;
}

function namazMarks(dateKey) {
  return (state.namaz || {})[dateKey] || {};
}

function namazDone(dateKey, id) {
  return Boolean(namazMarks(dateKey)[id]);
}

function toggleNamaz(dateKey, id) {
  if (isFutureDate(dateKey)) {
    toast("Это будущий день — намаз отметить нельзя заранее.");
    return;
  }
  if (!state.namaz) state.namaz = {};
  const day = state.namaz[dateKey] || (state.namaz[dateKey] = {});
  if (day[id]) delete day[id];
  else day[id] = true;
  const marked = Boolean(day[id]);
  if (!Object.keys(day).length) delete state.namaz[dateKey];
  touchDay(dateKey);
  save();
  /* перерисовываем всё, где виден намаз: карточку, «Сейчас», расписание и счётчик.
     Раньше расписание не обновлялось — поэтому галочка появлялась только после
     перезагрузки, а повторный клик «не снимал» отметку. */
  renderNamaz();
  renderNow();
  renderTimeline();
  renderHero();
  play(marked ? "markGood" : "tick");
  if (marked) toast(`${NAMAZ_NAMES[id]} отмечен.`);
}

function namazSourceText(times, dateKey) {
  if (times.api) {
    const month = NAMAZ_API_CACHE[(dateKey || todayKey()).slice(0, 7)] || NAMAZ_API_CACHE[todayKey().slice(0, 7)];
    const when = month && month.savedAt ? new Date(month.savedAt) : null;
    const stamp = when ? `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : "";
    return `Муфтият ЧР, официальное расписание с assolat.ru${stamp ? ` · обновлено ${stamp}` : ""}`;
  }
  if (times.official) return "Муфтият ЧР, встроенные дни расписания (API недоступен)";
  return "расчёт по солнцу — официальных данных на этот год нет";
}

function namazCount(dateKey) {
  return NAMAZ_IDS.filter((id) => namazDone(dateKey, id)).length;
}

const NAMAZ_SKIP_KEY = "vp-tracker-namaz-skip";

function namazSkipToday() {
  try {
    return localStorage.getItem(NAMAZ_SKIP_KEY) === todayKey();
  } catch {
    return false;
  }
}

function setNamazSkipToday(on) {
  try {
    if (on) localStorage.setItem(NAMAZ_SKIP_KEY, todayKey());
    else localStorage.removeItem(NAMAZ_SKIP_KEY);
  } catch {
    /* ignore */
  }
}

/* при загрузке и по таймеру подтягиваем официальное расписание из API */
function namazBootSync() {
  namazSync(selectedDate);
}
setTimeout(namazBootSync, 500);
setInterval(() => {
  if (!document.hidden) namazSync(todayKey());
}, 6 * 60 * 60 * 1000);

function renderNamaz() {
  const root = document.getElementById("prayerCard");
  if (!root) return;

  if (!namazEnabled()) {
    root.innerHTML = "";
    root.style.display = "none";
    return;
  }
  root.style.display = "";
  root.innerHTML = "";

  const now = new Date();
  const nowKey = keyOf(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dateKey = isFutureDate(selectedDate) ? nowKey : selectedDate;
  const times = namazTimes(dateKey);
  const day = namazDay(dateKey);
  const marks = namazMarks(dateKey);
  const done = namazCount(dateKey);

  const head = el("div", "prayer-head");
  head.innerHTML = `
    <div>
      <div class="prayer-title">🕌 Намаз · ${NAMAZ_CITY.name}</div>
      <div class="prayer-sub">${namazSourceText(times, dateKey)}${dateKey !== nowKey ? ` · ${DATE_FMT.format(dateOf(dateKey))}` : ""}</div>
    </div>
    <div class="prayer-count"><b>${done}</b>/5</div>`;
  root.appendChild(head);

  if (dateKey === nowKey && namazSkipToday()) {
    const skip = el("p", "prayer-skip");
    skip.innerHTML = `Намаз сегодня пропущен — не считается провалом. <button type="button" class="prayer-link" data-unsleep>вернуть</button>`;
    skip.querySelector("[data-unsleep]").addEventListener("click", () => {
      setNamazSkipToday(false);
      renderNamaz();
      renderNow();
    });
    root.appendChild(skip);
  }

  /* ночная часть: подъём на фаджр → намаз → сон до 09:00 */
  if (dateKey === nowKey && namazEnabled()) {
    const p = nightPlan(nowKey);
    const taken = Boolean(marks.fajr);
    const block = el("div", "night-plan" + (taken ? " is-done" : ""));
    block.innerHTML = `
      <div class="night-row"><span class="night-time">${p.wakeTime}</span><span>⏰ Подъём на фаджр <small>за ${NAMAZ_WAKE_AHEAD} мин (считается от восхода/фаджра каждый день)</small></span></div>
      <div class="night-row${taken ? " done" : ""}"><span class="night-time">${p.fajrTime}</span><span>🕌 Фаджр ${taken ? "— отмечен ✓" : `— до восхода ${p.sunriseTime}`}</span></div>
      <div class="night-row"><span class="night-time">${p.sleepToTime}</span><span>☀️ Подъём — дальше расписание как обычно (тренировка, Ulbi, всё по плану)</span></div>
      <div class="night-note">${p.sleepMin > 0 ? `После намаза — сон до ${p.sleepToTime}: ${fmtMinutes(p.sleepMin)}.` : "Летом фаджр почти перед восходом — поспи до 09:00, если нужно."}</div>`;
    root.appendChild(block);
  }

  const list = el("div", "prayer-list");
  day.forEach((p) => {
    const isDone = Boolean(marks[p.id]);
    const isCurrent = dateKey === nowKey && nowMin >= p.at && nowMin < p.end;
    const isPast = dateKey === nowKey && nowMin >= p.end;

    const row = el(
      "button",
      "prayer-row" + (isDone ? " is-done" : "") + (isCurrent ? " is-now" : "") + (isPast && !isDone ? " is-missed" : "")
    );
    row.type = "button";
    row.title = isDone ? "Снять отметку" : "Отметить, что намаз выполнен";
    row.innerHTML = `
      <span class="prayer-icon">${p.icon}</span>
      <span class="prayer-name">${p.name}<small>${p.until} · до ${namazHHMM(p.end)}</small></span>
      <span class="prayer-time">${p.time}</span>
      <span class="prayer-mark">${isDone ? "✓" : ""}</span>`;
    row.addEventListener("click", () => toggleNamaz(dateKey, p.id));
    list.appendChild(row);
  });
  root.appendChild(list);

  const foot = el("div", "prayer-foot");
  const sunrise = times.sunrise ? ` · восход ${times.sunrise}` : "";
  const fajr = day[0];
  foot.textContent = `Фаджр ${fajr.time} · подъём в это время${sunrise}`;
  root.appendChild(foot);
}

function renderBadDay() {
  document.getElementById("badDayTotal").textContent = BAD_DAY.total;
  const list = document.getElementById("badDayList");
  list.innerHTML = BAD_DAY.items
    .map((i) => `<li><b>${i.time}</b><span>${i.text}</span></li>`)
    .join("");
  document.getElementById("badDayRule").textContent = BAD_DAY.rule;
}

/* ─────────────── эйр-статистика ─────────────── */

function streak() {
  let n = 0;
  let cursor = todayKey();
  // если сегодня ещё ничего нет — стрик не рвём, начинаем со вчера
  if (!(hoursFor(cursor) > 0)) {
    cursor = shiftDay(cursor, -1);
  }
  while (hoursFor(cursor) > 0) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

function closedDays() {
  return Object.keys(state.hours || {}).filter((k) => hoursFor(k) > 0).length;
}

function renderHero() {
  const root = document.getElementById("heroStats");
  const s = streak();
  const cd = closedDays();
  const gymDone = Object.values(state.gym).reduce(
    (sum, w) => sum + Object.values(w).filter(Boolean).length,
    0
  );
  /* намазы за всё время — только если блок включён */
  let namazChip = "";
  if (typeof namazEnabled === "function" && namazEnabled()) {
    const namazTotal = Object.values(state.namaz || {}).reduce(
      (sum, day) => sum + Object.keys(day || {}).length,
      0
    );
    namazChip = `<span class="chip">🕌 Намазов <b>${namazTotal}</b></span>`;
  }

  root.innerHTML = `
    <span class="chip">🔥 Серия <b>${s} ${plural(s, "день", "дня", "дней")}</b></span>
    <span class="chip">✅ Закрыто дней <b>${cd}</b></span>
    <span class="chip">💪 Тренировок <b>${gymDone}</b></span>
    <span class="chip">🧩 LeetCode <b>${state.leetcode.length}</b></span>
    ${namazChip}`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/* ─────────────── неделя ─────────────── */

function renderWeek() {
  const grid = document.getElementById("weekGrid");
  const todayIdx = weekdayIndex(todayKey());
  const selectedIdx = weekdayIndex(selectedDate);
  grid.innerHTML = "";

  WEEK_PLAN.forEach((d, i) => {
    const card = el("div", "day-card" + (i === selectedIdx ? " today" : "") + (d.rest ? " day-rest" : ""));
    const workoutLabel = d.workout ? `💪 Тренировка ${d.workout}` : d.rest ? "🌿 Отдых" : "🚶 Восстановление";
    card.innerHTML = `
      <div class="day-head">
        <span class="day-name">${d.day}</span>
        ${i === selectedIdx ? '<span class="day-badge today-badge">выбран</span>' : i === todayIdx ? '<span class="day-badge">сегодня</span>' : ""}
      </div>
      <div class="day-theme">${d.theme}</div>
      <ul class="day-focus">${d.focus.map((f) => `<li>${f}</li>`).join("")}</ul>
      <div class="day-workout">${workoutLabel}</div>`;
    grid.appendChild(card);
  });

  const phases = document.getElementById("phases");
  phases.innerHTML = PHASES.map(
    (p) => `<div class="phase">
      <div class="phase-weeks">${p.weeks}</div>
      <div class="phase-name">${p.name}</div>
      <div class="phase-hours">${p.hours}</div>
      <p class="phase-text">${p.text}</p>
    </div>`
  ).join("");
}

/* ─────────────── тренировки ─────────────── */

function renderGym() {
  const week = state.week;

  document.getElementById("weekNum").textContent = week;

  const dots = document.getElementById("weekDots");
  dots.innerHTML = "";
  for (let w = 1; w <= 8; w++) {
    const b = el("button", "week-dot" + (w === week ? " active" : "") + (w === 8 ? " deload" : ""), String(w));
    b.type = "button";
    b.title = `Неделя ${w}: ${WEEK_NOTES[w - 1]}`;
    b.addEventListener("click", () => {
      state.week = w;
      save();
      renderGym();
      renderHero();
    });
    dots.appendChild(b);
  }

  document.getElementById("weekNote").textContent = WEEK_NOTES[week - 1];

  /* чеки */
  const plan = gymPlanFor(week); // [{key:'mon', label:'Понедельник — A', workout:'A'}, ...]
  const saved = state.gym[week] || (state.gym[week] = {});
  const checks = document.getElementById("gymChecks");
  checks.innerHTML = "";
  plan.forEach((p) => {
    const row = el("label", "gym-check" + (saved[p.key] ? " on" : ""));
    row.innerHTML = `<span class="box">✓</span><span>${p.label}</span><span class="wc">25–35 мин</span>`;
    row.addEventListener("click", (e) => {
      e.preventDefault();
      saved[p.key] = !saved[p.key];
      save();
      renderGym();
      renderHero();
      if (saved[p.key]) {
        play("workout");
        toast("Тренировка отмечена. Восстановление — часть программы.");
      }
    });
    checks.appendChild(row);
  });
  const done = plan.filter((p) => saved[p.key]).length;
  document.getElementById("gymCount").textContent = `${done}/3`;

  /* разминка */
  document.getElementById("warmup").innerHTML = WARMUP.map((w) => `<li>${w}</li>`).join("");

  const pullSteps = document.getElementById("pullupSteps");
  pullSteps.innerHTML = PULLUP_STEPS.map((s) => `<li>${s}</li>`).join("");

  const recovery = document.getElementById("recovery");
  recovery.innerHTML = RECOVERY.map(
    (r) => `<div class="rec-item"><span class="ico">${r.icon}</span><div><b>${r.title}</b>${r.text}</div></div>`
  ).join("");

  /* сами тренировки */
  const root = document.getElementById("workouts");
  root.innerHTML = "";
  ["A", "B"].forEach((key) => {
    const w = WORKOUTS[key];
    const card = el("div", "card");
    card.innerHTML = `
      <div class="workout-head">
        <h3>${w.title}</h3>
        <p>${w.subtitle}</p>
      </div>
      ${w.exercises
        .map(
          (ex) => `<div class="exercise">
            <div class="ex-top">
              <span class="ex-name">${ex.name}</span>
              <span class="ex-reps">${ex.reps[week - 1]}</span>
            </div>
            <div class="ex-note">${ex.note}</div>
          </div>`
        )
        .join("")}`;
    root.appendChild(card);
  });
}

function gymPlanFor(week) {
  const odd = week % 2 === 1;
  return [
    { key: "mon", label: `Понедельник — ${odd ? "A" : "B"}`, workout: odd ? "A" : "B" },
    { key: "wed", label: `Среда — ${odd ? "B" : "A"}`, workout: odd ? "B" : "A" },
    { key: "fri", label: `Пятница — ${odd ? "A" : "B"}`, workout: odd ? "A" : "B" },
  ];
}

/* ─────────────── «Сейчас»: время, день, тренировка ─────────────── */

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function currentTimeline(dateKey) {
  const view = state.scheduleView === "coarse" ? "coarse" : "detail";
  return SCHEDULE_VIEWS[view].timeline;
}

/* ─────────── ночь и утро под намаз ───────────
   День остаётся прежним: подъём в 09:00, всё расписание как было.
   Намаз встроен в ночь — подъём за 10 минут до фаджра, намаз до восхода,
   потом сон до 09:00. Времена считаются от даты, поэтому плавают вместе
   с солнцем (в июне фаджр в 02:30, в декабре — в 06:03). */

/* сколько минут до фаджра встаём */
const NAMAZ_WAKE_AHEAD = 10;

/* Ночная часть дня для даты YYYY-MM-DD: подъём, фаджр, сон до 09:00. */
function nightPlan(dateKey) {
  const t = namazTimes(dateKey);
  const fajr = namazMinutes(t.fajr);
  const sunrise = t.sunrise ? namazMinutes(t.sunrise) : fajr + 60;
  const wake = Math.max(0, fajr - NAMAZ_WAKE_AHEAD);
  const dayStart = 9 * 60;

  return {
    fajr,
    sunrise,
    wake,
    wakeTime: namazHHMM(wake),
    fajrTime: t.fajr,
    sunriseTime: t.sunrise || namazHHMM(sunrise),
    sleepTo: dayStart,
    sleepToTime: "09:00",
    /* сколько минут на сон после намаза (может быть 0 летом) */
    sleepMin: Math.max(0, dayStart - sunrise),
    enabled: typeof namazEnabled === "function" && namazEnabled(),
  };
}

/* Что происходит сейчас в ночной части дня: null, если день уже начался. */
function nightNow(date) {
  if (typeof namazEnabled !== "function" || !namazEnabled()) return null;
  const dateKey = keyOf(date);
  const mins = date.getHours() * 60 + date.getMinutes();
  if (mins >= 9 * 60) return null;

  const plan = nightPlan(dateKey);
  if (mins < plan.wake) return { phase: "sleep", plan };
  if (mins < plan.fajr) return { phase: "wake", plan };
  if (mins < plan.sunrise) return { phase: "fajr", plan };
  return { phase: "after", plan };
}

/* ─────────── намаз внутри расписания ───────────
   Каждый дневной намаз занимает в графике три ступеньки:
   подготовка (10 мин) → сам намаз (10 мин) → возврат к делу.
   Блоки, в которые попадает намаз, разрезаются на две части,
   вторая помечается «(продолжение)». Фаджр сюда не попадает:
   он до 09:00 и живёт в ночном блоке. */

const NAMAZ_PREP_MIN = 10;   // подготовка до намаза
const NAMAZ_PRAYER_MIN = 10; // сколько отводим на сам намаз

/* Вырезать из куска [from,to) интервал события. */
function cutInterval(piece, ev) {
  if (ev.to <= piece.from || ev.from >= piece.to) return [piece];
  const out = [];
  if (ev.from > piece.from) out.push({ from: piece.from, to: Math.min(ev.from, piece.to) });
  if (ev.to < piece.to) out.push({ from: Math.max(ev.to, piece.from), to: piece.to });
  return out;
}

/* ─────────── волнистый край блока намаза ───────────
   Край блока — крупные круглые волны (как на референсе).
   Волны физически бегут по периметру: путь пересчитывается по фазе,
   а SVG-анимация морфит между фазами — гребни едут по кругу. */

const NAMAZ_WAVE_BULGE = 4;   // насколько волна выступает наружу
const NAMAZ_WAVE_LEN = 18;    // длина одной волны, px
const NAMAZ_WAVE_STEP = 3;    // шаг сэмплирования (меньше — плавнее морф)

/* Один периметр с фазой phase (0..1). Возвращает строку path. */
function namazWavePath(w, h, phase) {
  const pad = NAMAZ_WAVE_BULGE + 1;
  const x0 = pad;
  const y0 = pad;
  const x1 = w - pad;
  const y1 = h - pad;

  const pts = [];
  const push = (x, y, nx, ny, offset) => {
    const wave = NAMAZ_WAVE_BULGE * (0.5 + 0.5 * Math.sin(offset));
    pts.push([x + nx * wave, y + ny * wave]);
  };

  /* верх: слева → направо, волна наружу (ny = -1) */
  const topLen = x1 - x0;
  const topN = Math.max(2, Math.round(topLen / NAMAZ_WAVE_STEP));
  for (let i = 0; i < topN; i++) {
    const t = i / topN;
    const along = t * topLen;
    push(x0 + along, y0, 0, -1, (along / NAMAZ_WAVE_LEN) * Math.PI * 2 + phase * Math.PI * 2);
  }
  /* правый бок: сверху вниз */
  const sideLen = y1 - y0;
  const sideN = Math.max(2, Math.round(sideLen / NAMAZ_WAVE_STEP));
  for (let i = 0; i < sideN; i++) {
    const t = i / sideN;
    const along = t * sideLen;
    push(x1, y0 + along, 1, 0, (along / NAMAZ_WAVE_LEN) * Math.PI * 2 + phase * Math.PI * 2);
  }
  /* низ: справа налево */
  for (let i = 0; i < topN; i++) {
    const t = i / topN;
    const along = t * topLen;
    push(x1 - along, y1, 0, 1, (along / NAMAZ_WAVE_LEN) * Math.PI * 2 + phase * Math.PI * 2);
  }
  /* левый бок: снизу вверх */
  for (let i = 0; i < sideN; i++) {
    const t = i / sideN;
    const along = t * sideLen;
    push(x0, y1 - along, -1, 0, (along / NAMAZ_WAVE_LEN) * Math.PI * 2 + phase * Math.PI * 2);
  }

  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
  }
  return d + " Z";
}

/* Кадры анимации: волны едут по кругу, 8 фаз на цикл. */
function namazWaveFrames(w, h) {
  const total = 8;
  const frames = [];
  for (let i = 0; i < total; i++) frames.push(namazWavePath(w, h, i / total));
  return frames;
}

/* Расписание дня вместе с намазами. */
function dayTimeline(dateKey) {
  const base = currentTimeline(dateKey);
  const plain = base.map((s) => ({ ...s }));
  if (typeof namazEnabled !== "function" || !namazEnabled()) return plain;

  const dayStart = 9 * 60;
  const dayEnd = 23 * 60;

  const events = namazDay(dateKey)
    .filter((p) => p.id !== "fajr")
    .map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      atMin: p.at,
      from: p.at - NAMAZ_PREP_MIN,
      to: p.at + NAMAZ_PRAYER_MIN,
      time: p.time,
    }))
    /* интересуют только те, что целиком попадают в рабочий день */
    .filter((ev) => ev.from >= dayStart && ev.to <= dayEnd);

  if (!events.length) return plain;

  const out = [];
  plain.forEach((slot) => {
    let pieces = [{ from: minutesOf(slot.from), to: minutesOf(slot.to) }];
    events.forEach((ev) => {
      pieces = pieces.reduce((acc, piece) => acc.concat(cutInterval(piece, ev)), []);
    });
    const startMin = minutesOf(slot.from);
    pieces.forEach((piece) => {
      if (piece.to <= piece.from) return;
      out.push({
        ...slot,
        from: namazHHMM(piece.from),
        to: namazHHMM(piece.to),
        cont: piece.from !== startMin,
      });
    });
  });

  events.forEach((ev) => {
    out.push({
      prayer: true,
      id: ev.id,
      from: namazHHMM(ev.from),
      to: namazHHMM(ev.to),
      prep: namazHHMM(ev.from),
      at: namazHHMM(ev.atMin),
      end: namazHHMM(ev.to),
      icon: ev.icon,
      label: ev.name,
      atMin: ev.atMin,
    });
  });

  out.sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
  return out;
}

/* Какой сейчас интервал. Возвращает {slot, index, left, next} или null вне расписания. */
function slotNow(date, dateKey) {
  const timeline = currentTimeline(dateKey);
  const mins = date.getHours() * 60 + date.getMinutes();
  for (let i = 0; i < timeline.length; i++) {
    const from = minutesOf(timeline[i].from);
    const to = minutesOf(timeline[i].to);
    if (mins >= from && mins < to) {
      return { slot: timeline[i], index: i, left: to - mins, next: timeline[i + 1] || null };
    }
  }
  return null;
}

/* Что сейчас по графику с учётом намаза: либо обычный интервал, либо ступень намаза. */
function momentNow(date, dateKey) {
  const key = dateKey || keyOf(date);
  const mins = date.getHours() * 60 + date.getMinutes();
  const rows = dayTimeline(key);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const from = minutesOf(row.from);
    const to = minutesOf(row.to);
    if (mins < from || mins >= to) continue;
    if (row.prayer) {
      const phase = mins < row.atMin ? "prep" : mins < row.atMin + NAMAZ_PRAYER_MIN ? "prayer" : "done";
      return { row, next: rows[i + 1] || null, left: to - mins, phase, index: i, rows };
    }
    return { row, next: rows[i + 1] || null, left: to - mins, phase: null, index: i, rows };
  }
  return null;
}

/* Тренировка на конкретный день недели (0 = понедельник), с чередованием A/B по неделям. */
function workoutForWeekday(weekdayIdx) {
  const odd = state.week % 2 === 1;
  if (weekdayIdx === 0) return { kind: "workout", workout: odd ? "A" : "B" };
  if (weekdayIdx === 2) return { kind: "workout", workout: odd ? "B" : "A" };
  if (weekdayIdx === 4) return { kind: "workout", workout: odd ? "A" : "B" };
  if (weekdayIdx === 6) return { kind: "rest" };
  return { kind: "walk" };
}

function workoutText(info) {
  if (info.kind === "workout") {
    const list = WORKOUTS[info.workout].exercises.map((e) => `${e.name} ${e.reps[state.week - 1]}`);
    return { title: `💪 Тренировка ${info.workout}`, sub: list.join(" · "), tag: "силовая" };
  }
  if (info.kind === "walk") {
    return { title: "🚶 Восстановление", sub: "Прогулка 20–30 минут, лёгкая растяжка. Тяжёлая нагрузка сегодня не нужна.", tag: "прогулка" };
  }
  return { title: "🌿 Выходной", sub: "Спорт — только по желанию. Никакого чувства вины за отдых.", tag: "отдых" };
}

/* Уровень блока по текущему режиму дня. */
function targetLevelFor(dateKey) {
  const target = MODE_TARGET[modeFor(dateKey)];
  return target === 1 ? "min" : target === 2 ? "norm" : "max";
}

const LEVEL_TEXT = { min: "минимум", norm: "норма", max: "максимум" };

function renderNow() {
  const root = document.getElementById("nowCard");
  if (!root) return;

  const now = new Date();
  const nowKey = keyOf(now);
  const isToday = selectedDate === nowKey;
  const dow = (now.getDay() + 6) % 7;
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const mode = modeFor(nowKey);
  const info = slotNow(now, nowKey);
  const workout = workoutForWeekday(dow);
  const wt = workoutText(workout);

  /* плохой день важнее расписания */
  if (mode === "bad") {
    root.className = "now-card now-bad";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill now-pill-live"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">🫥</div>
        <div class="now-text">
          <div class="now-title">Сегодня плохой день</div>
          <div class="now-sub">${BAD_DAY.total} по плану: ${BAD_DAY.items.map((i) => i.text.split(" — ")[0]).join(", ")}.</div>
        </div>
      </div>
      <div class="now-foot">
        <span class="now-note">Расписание сегодня не обязательно. Сделал минимум — день закрыт.</span>
      </div>`;
    return;
  }

  /* Ночь: сначала смотрим утренний намаз, и только потом «вне расписания» */
  const night = isToday ? nightNow(now) : null;
  if (night && night.phase === "wake") {
    const p = night.plan;
    root.className = "now-card now-namaz-card";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">⏰</div>
        <div class="now-text">
          <div class="now-title">Подъём на фаджр</div>
          <div class="now-sub">Умыться и встать на намаз в ${p.fajrTime} · через ${fmtMinutes(p.fajr - (now.getHours() * 60 + now.getMinutes()))}</div>
        </div>
      </div>
      <div class="now-foot">
        <span class="now-next">После намаза — сон до ${p.sleepToTime}</span>
        <span class="now-workout">Восход ${p.sunriseTime} · фаджр закрывается восходом</span>
      </div>`;
    return;
  }

  if (night && night.phase === "fajr") {
    const p = night.plan;
    const left = p.sunrise - (now.getHours() * 60 + now.getMinutes());
    root.className = "now-card now-namaz-card";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">🕌</div>
        <div class="now-text">
          <div class="now-title">Фаджр</div>
          <div class="now-sub">До восхода ${p.sunriseTime} · осталось ${fmtMinutes(left)}</div>
        </div>
      </div>
      <div class="now-foot">
        <span class="now-next">После намаза — досыпаем до ${p.sleepToTime}</span>
        <span class="now-workout">${wt.title} · ${wt.tag}</span>
      </div>`;
    return;
  }

  if (night && night.phase === "after") {
    const p = night.plan;
    root.className = "now-card now-off";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">😴</div>
        <div class="now-text">
          <div class="now-title">Сон после фаджра</div>
          <div class="now-sub">До ${p.sleepToTime} · ещё ${fmtMinutes(p.sleepTo - (now.getHours() * 60 + now.getMinutes()))}. Намаз уже сделан — это не лень, это часть плана.</div>
        </div>
      </div>
      <div class="now-foot">
        <span class="now-workout">${wt.title} · ${wt.tag}</span>
        <span class="now-note">Расписание начнётся в 09:00</span>
      </div>`;
    return;
  }

  /* идёт ступень намаза — показываем её, а не рабочий блок */
  const moment = isToday ? momentNow(now, nowKey) : null;
  if (moment && moment.row.prayer) {
    const r = moment.row;
    const mark = namazDone(nowKey, r.id);
    const phaseText =
      moment.phase === "prep"
        ? `Подготовка · намаз в ${r.at}`
        : moment.phase === "prayer"
          ? `Намаз идёт · до ${r.end}`
          : `Намаз · вернись к делу в ${r.end}`;
    root.className = "now-card now-namaz-card";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">${r.icon}</div>
        <div class="now-text">
          <div class="now-title">${r.label} · ${r.at}</div>
          <div class="now-sub">${phaseText} · осталось ${fmtMinutes(moment.left)}</div>
        </div>
      </div>
      <button class="now-done${mark ? " is-done" : ""}" ${mark ? "disabled" : ""}>${mark ? "✓ отмечен" : "Отметить намаз"}</button>
      <div class="now-foot">
        <span class="now-next">${moment.next ? `Дальше ${moment.next.from} · ${moment.next.label}` : "Дальше свободное время"}</span>
        <span class="now-workout">${wt.title} · ${wt.tag}</span>
      </div>`;
    const btn = root.querySelector(".now-done");
    if (btn && !mark) btn.addEventListener("click", () => toggleNamaz(nowKey, r.id));
    return;
  }

  if (!info) {
    const p = isToday ? nightPlan(nowKey) : null;
    root.className = "now-card now-off";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">🌙</div>
        <div class="now-text">
          <div class="now-title">${p ? "Сон до утреннего намаза" : "Вне расписания"}</div>
          <div class="now-sub">${
            p
              ? `Расписание идёт с 09:00 до 23:00. Подъём на фаджр в ${p.wakeTime}, намаз в ${p.fajrTime}.`
              : "Расписание идёт с 09:00 до 23:00. Отдых — тоже часть плана."
          }</div>
        </div>
      </div>
      <div class="now-foot">
        <span class="now-workout">${wt.title} · ${wt.tag}</span>
        <span class="now-note">${wt.sub}</span>
      </div>`;
    return;
  }

  const { slot, left, next } = info;
  const total = minutesOf(slot.to) - minutesOf(slot.from);
  const pct = Math.min(100, Math.round(((total - left) / total) * 100));

  /* подпись для тренировки внутри её интервала */
  let workoutTitle = wt.title;
  if (slot.tag === "тело") {
    workoutTitle =
      workout.kind === "workout"
        ? `💪 Сегодня тренировка ${workout.workout}`
        : workout.kind === "walk"
          ? "🚶 Сегодня восстановление"
          : "🌿 Сегодня выходной";
  }

  /* статус блока, если интервал привязан к чек-листу */
  let blockLine = "";
  if (slot.block) {
    const block = BLOCKS.find((b) => b.id === slot.block);
    const done = levelOf(nowKey, slot.block);
    const target = targetLevelFor(nowKey);
    if (block) {
      blockLine = done
        ? `<button class="now-done is-done" disabled>✓ ${LEVEL_TEXT[done]} · ${fmtMinutes(hoursFor(nowKey, slot.block))}</button>`
        : `<button class="now-done" data-mark="${slot.block}" data-level="${target}">Отметить ${LEVEL_TEXT[target]} · ${block[target]}</button>`;
    }
  }

  /* намаз: что идёт сейчас и сколько осталось */
  let namazLine = "";
  if (typeof namazEnabled === "function" && namazEnabled() && isToday) {
    const t = namazTimes(nowKey);
    if (namazSkipToday()) {
      namazLine = `<div class="now-namaz">🕌 Намаз на сегодня пропущен — просто отметь время и живи дальше.</div>`;
    } else {
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const st = namazNow(nowKey, nowMin);
      const marks = namazMarks(nowKey);
      if (st.current) {
        const left = st.current.end - nowMin;
        const isDone = Boolean(marks[st.current.id]);
        namazLine = `<div class="now-namaz${isDone ? " is-done" : ""}">🕌 ${st.current.name} · ${st.current.time}${
          isDone ? " — отмечен ✓" : ` — до ${namazHHMM(st.current.end)}, осталось ${fmtMinutes(left)}`
        }</div>`;
      } else if (st.next) {
        const inMin = st.next.at - nowMin;
        namazLine = `<div class="now-namaz">🕌 Следующий намаз — ${st.next.name} в ${st.next.time}${
          inMin > 0 ? ` · через ${fmtMinutes(inMin)}` : ""
        }</div>`;
      }
    }
  }

  /* идущий таймер виден и здесь, даже если открыт другой интервал дня */
  const liveTimer = runningTimers()[0];
  if (liveTimer) {
    const live = hoursFor(liveTimer.date, liveTimer.block);
    blockLine += `<div class="now-timer">⏱ ${blockName(liveTimer.block)} — идёт с ${hhmm(liveTimer.startedAt)}, уже ${fmtMinutes(live)}</div>`;
  }

  const isBreak = slot.tag === "пауза" || slot.tag === "свободно" || slot.tag === "вечер";

  root.className = "now-card" + (isBreak ? " now-break" : "");
  root.innerHTML = `
    <div class="now-head">
      <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
      <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
    </div>
    <div class="now-main">
      <div class="now-icon">${slot.icon || "•"}</div>
      <div class="now-text">
        <div class="now-title">${slot.label}</div>
        <div class="now-sub">
          ${slot.from}–${slot.to} · осталось ${fmtMinutes(left)}
          ${slot.short ? `· <span class="now-tag">${slot.short}</span>` : ""}
        </div>
      </div>
    </div>
    <div class="now-progress"><span style="width:${pct}%"></span></div>
    ${namazLine}
    ${blockLine}
    <div class="now-foot">
      ${next ? `<span class="now-next">Дальше ${next.from} · ${next.label}</span>` : `<span class="now-next">Последний блок дня</span>`}
      <span class="now-workout">${workoutTitle}</span>
    </div>
    ${!isToday ? `<div class="now-hint">Открыт другой день — плашка показывает текущий момент.</div>` : ""}`;

  const btn = root.querySelector("[data-mark]");
  if (btn) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.mark;
      const level = btn.dataset.level;
      /* Догоняем до порога, но никогда не отнимаем уже накопленное время. */
      const need = minutesForLevel(id, level);
      if (hoursFor(nowKey, id) < need) setBlockMinutes(nowKey, id, need);
      if (selectedDate !== nowKey) {
        selectedDate = nowKey;
        dateInput.value = selectedDate;
      }
      renderAll();
      play(level === "min" ? "mark" : "markGood");
      toast(`Отмечено: ${LEVEL_TEXT[level]}. Этого достаточно.`);
    });
  }
}

/* Полное расписание под чек-листом */
function renderTimeline() {
  const root = document.getElementById("timeline");
  if (!root) return;
  const timeline = dayTimeline(selectedDate);
  const now = new Date();
  const nowKey = keyOf(now);
  const moment = selectedDate === nowKey ? momentNow(now, nowKey) : null;
  const target = targetLevelFor(selectedDate);

  root.innerHTML = "";

  const switcher = el("div", "tl-switch");
  Object.entries(SCHEDULE_VIEWS).forEach(([key, v]) => {
    const b = el("button", "tl-switch-btn" + (state.scheduleView === key || (!state.scheduleView && key === "detail") ? " on" : ""), v.label);
    b.type = "button";
    b.addEventListener("click", () => {
      state.scheduleView = key;
      save();
      renderTimeline();
      renderNow();
    });
    switcher.appendChild(b);
  });

  /* День ещё не наступил — прямо в расписании говорим об этом, а не только в кольце. */
  if (isFutureDate(selectedDate)) {
    const badge = el("div", "future-note");
    badge.innerHTML =
      `⚠️ Это <b>будущий день</b> (${humanDate.format(dateOf(selectedDate))}). ` +
      `Расписание можно смотреть заранее, но отметки пойдут в статистику.`;
    badge.style.marginBottom = "10px";
    root.appendChild(badge);
  }

  root.appendChild(switcher);

  let prevMinutes = -1;

  timeline.forEach((row, i) => {
    const from = minutesOf(row.from);
    const to = minutesOf(row.to);
    const isNow = moment && moment.index === i;
    const isPast = selectedDate === nowKey && from < now.getHours() * 60 + now.getMinutes();

    /* ── намаз: три ступеньки ── */
    if (row.prayer) {
      const mark = (namazMarks(selectedDate) || {})[row.id];
      const step = el(
        "div",
        "tl-namaz" + (isNow ? " is-now" : "") + (mark ? " is-done" : "") + (isPast && !isNow ? " is-past" : "")
      );
      step.dataset.namaz = row.id;
      step.setAttribute("role", "button");
      step.tabIndex = 0;
      step.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleNamaz(selectedDate, row.id);
        }
      });

      const prepMin = minutesOf(row.at) - minutesOf(row.prep);
      step.innerHTML = `
        <span class="tl-namaz-edge" aria-hidden="true"></span>
        <span class="tl-namaz-glow" aria-hidden="true"></span>
        <span class="tl-namaz-steps" aria-hidden="true">
          <i class="step step-1"></i><i class="step step-2"></i><i class="step step-3"></i>
        </span>
        <span class="tl-namaz-main">
          <span class="tl-namaz-title">${row.icon} ${row.label}</span>
          <span class="tl-namaz-times">
            <b>${row.at}</b>
            <small>${row.prep} подготовка · ${row.until || ""}</small>
          </span>
        </span>
        <span class="tl-namaz-scale">
          <span>${row.prep}</span>
          <span class="mid">${row.at}</span>
          <span>${row.end}</span>
        </span>
        ${isNow ? '<span class="tl-namaz-now">сейчас</span>' : ""}
        ${mark ? '<span class="tl-namaz-check">✓</span>' : ""}`;

      step.addEventListener("click", () => toggleNamaz(selectedDate, row.id));

      /* свет живёт там, где мышка: источник света двигается за курсором */
      const moveLight = (e) => {
        const box = step.getBoundingClientRect();
        const x = ((e.clientX - box.left) / box.width) * 100;
        const y = ((e.clientY - box.top) / box.height) * 100;
        step.style.setProperty("--mx", `${Math.max(0, Math.min(100, x))}%`);
        step.style.setProperty("--my", `${Math.max(0, Math.min(100, y))}%`);
      };
      const movePageLight = (e) => {
        document.body.style.setProperty("--page-mx", `${(e.clientX / window.innerWidth) * 100}%`);
        document.body.style.setProperty("--page-my", `${(e.clientY / window.innerHeight) * 100}%`);
      };
      step.addEventListener("pointermove", (e) => {
        moveLight(e);
        movePageLight(e);
      });
      step.addEventListener("mouseenter", (e) => {
        document.body.classList.add("namaz-light");
        step.classList.add("is-lit");
        moveLight(e);
        movePageLight(e);
      });
      step.addEventListener("mouseleave", () => {
        document.body.classList.remove("namaz-light");
        step.classList.remove("is-lit");
        step.style.removeProperty("--mx");
        step.style.removeProperty("--my");
      });
      step.addEventListener("focus", () => document.body.classList.add("namaz-light"));
      step.addEventListener("blur", () => document.body.classList.remove("namaz-light"));
      /* сам край блока становится волнистым: строим контур по его размеру */
      requestAnimationFrame(() => {
        /* offsetWidth/Height — размеры без transform, чтобы зум при наведении
           не пересчитывал рамку */
        const w = step.offsetWidth || 320;
        const h = step.offsetHeight || 54;
        const holder = step.querySelector(".tl-namaz-edge");
        if (!holder || w < 40) return;
        const frames = namazWaveFrames(w, h);
        holder.innerHTML = `
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="namazEdgeGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#fff3cf"/>
                <stop offset="0.45" stop-color="#ffcf7a"/>
                <stop offset="1" stop-color="#ffb04d"/>
              </linearGradient>
            </defs>
            <path class="edge-flame" d="${frames[0]}" pathLength="1000">
              <animate attributeName="d" dur="2.1s" repeatCount="indefinite"
                       calcMode="linear" values="${frames.join(";")};${frames[0]}"/>
            </path>
            <path class="edge-core" d="${frames[0]}" pathLength="1000">
              <animate attributeName="d" dur="2.1s" repeatCount="indefinite"
                       calcMode="linear" values="${frames.join(";")};${frames[0]}"/>
            </path>
          </svg>`;
      });

      if (prepMin !== NAMAZ_PREP_MIN) step.classList.add("is-tight");
      root.appendChild(step);
      prevMinutes = to;
      return;
    }

    /* ── обычный интервал ── */
    const done = row.block ? levelOf(selectedDate, row.block) : null;
    const line = el(
      "div",
      "tl-row" +
        (isNow ? " is-now" : "") +
        (row.tag === "глубоко" ? " strong" : "") +
        (isPast && !isNow ? " is-past" : "") +
        (row.cont ? " is-cont" : "") +
        (from - prevMinutes <= 1 && prevMinutes > 0 ? " joins" : "")
    );
    line.innerHTML = `
      <span class="tl-time">${row.from}<small>–${row.to}</small></span>
      <span class="tl-label">${row.icon ? `<span class="tl-ico">${row.icon}</span>` : ""}${row.label}${
        row.cont ? ' <span class="tl-cont">продолжение</span>' : ""
      }${done ? ` <span class="tl-done">✓ ${LEVEL_TEXT[done]}</span>` : ""}</span>
      ${isNow ? '<span class="tl-now">сейчас</span>' : ""}`;
    root.appendChild(line);
    prevMinutes = to;
  });

  /* касание на телефоне тоже зажигает блок от точки нажатия */
  root.querySelectorAll(".tl-namaz").forEach((node) => {
    node.addEventListener("pointerdown", (e) => {
      const box = node.getBoundingClientRect();
      node.style.setProperty("--mx", `${((e.clientX - box.left) / box.width) * 100}%`);
      node.style.setProperty("--my", `${((e.clientY - box.top) / box.height) * 100}%`);
    });
  });

  if (moment && moment.row && !moment.row.prayer && moment.row.block && !hoursFor(nowKey, moment.row.block)) {
    /* подсказка под расписанием — что отметить прямо сейчас */
    const hint = el("p", "tl-hint", `Сейчас по плану <b>${LEVEL_TEXT[target]}</b> в блоке «${BLOCKS.find((b) => b.id === moment.row.block).name}».`);
    root.appendChild(hint);
  }
}

/* ─────────────── прогресс ─────────────── */

function renderProgress() {
  const cd = closedDays();
  const days30 = lastNKeys(30);
  const marked30 = days30.filter((k) => hoursFor(k) > 0).length;
  const gyms = Object.values(state.gym).reduce((s, w) => s + Object.values(w).filter(Boolean).length, 0);
  const minDays = days30.filter((k) => {
    const levels = BLOCKS.map((b) => levelOf(k, b.id)).filter(Boolean);
    return levels.length > 0 && levels.every((v) => v === "min");
  }).length;

  const todayMin = hoursFor(todayKey());
  const allMin = totalHoursAllTime();
  const weekMin = lastNKeys(7).reduce((sum, k) => sum + hoursFor(k), 0);

  document.getElementById("hoursGrid").innerHTML = `
    <div class="stat stat-hours">
      <div class="stat-val">${fmtShort(todayMin)}<small>ч</small></div>
      <div class="stat-label">сегодня на работу</div>
      <div class="stat-sub">${todayMin ? fmtMinutes(todayMin) : "пока ничего не отмечено"}</div>
    </div>
    <div class="stat stat-hours">
      <div class="stat-val">${fmtShort(allMin)}<small>ч</small></div>
      <div class="stat-label">всего за всё время</div>
      <div class="stat-sub">${allMin ? fmtMinutes(allMin) + " · за 7 дней " + fmtShort(weekMin) + " ч" : "счёт начнётся с первой отметки"}</div>
    </div>`;

  document.getElementById("statGrid").innerHTML = `
    <div class="stat"><div class="stat-val">${cd}</div><div class="stat-label">дней закрыто</div></div>
    <div class="stat"><div class="stat-val">${streak()}</div><div class="stat-label">текущая серия</div></div>
    <div class="stat"><div class="stat-val">${marked30}<small>/30</small></div><div class="stat-label">дней с работой</div></div>
    <div class="stat"><div class="stat-val">${gyms}<small>/24</small></div><div class="stat-label">тренировок</div></div>
    <div class="stat"><div class="stat-val">${state.leetcode.length}</div><div class="stat-label">задач в журнале</div></div>
    <div class="stat"><div class="stat-val">${minDays}</div><div class="stat-label">«минимум-дней»</div></div>`;

  renderHeatmap();
  renderBars();
  renderLeetcode();
}

/* Всего часов за всё время — по всем дням, что есть в state.hours */
function totalHoursAllTime() {
  return Object.keys(state.hours || {}).reduce((sum, k) => sum + hoursFor(k), 0);
}

/* Серия дней с реальной работой (часы > 0) — не путать с серией закрытых дней */
function hoursStreak() {
  let n = 0;
  let cursor = todayKey();
  if (!hoursFor(cursor)) cursor = shiftDay(cursor, -1);
  while (hoursFor(cursor) > 0) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

function lastNKeys(n) {
  const keys = [];
  let cursor = todayKey();
  for (let i = n - 1; i >= 0; i--) keys.push(shiftDay(cursor, -i));
  return keys;
}

function renderHeatmap() {
  const root = document.getElementById("heatmap");
  root.innerHTML = "";

  const today = todayKey();
  const todayIdx = weekdayIndex(today);
  const start = shiftDay(today, -(28 + todayIdx)); // 5 недель назад, с понедельника
  const total = 5 * 7;

  for (let i = 0; i < total; i++) {
    const key = shiftDay(start, i);
    const count = BLOCKS.filter((b) => hoursFor(key, b.id) > 0).length;
    const lvl = count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : 3;

    const cell = el("button", `heat l${lvl}` + (key === today ? " today" : ""));
    cell.type = "button";
    const dt = dateOf(key);
    cell.title = `${humanDate.format(dt)} — ${count ? count + " блоков" : "нет отметок"}`;
    cell.addEventListener("click", () => {
      selectedDate = key;
      document.getElementById("dateInput").value = key;
      switchTab("day");
      renderAll();
    });
    root.appendChild(cell);
  }
}

function renderBars() {
  const keys = lastNKeys(30);
  const root = document.getElementById("bars");
  root.innerHTML = BLOCKS.map((b) => {
    const n = keys.filter((k) => hoursFor(k, b.id) > 0).length;
    const pct = Math.round((n / 30) * 100);
    return `<div class="bar-row">
      <span class="bar-name">${b.icon} ${b.name}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${n}/30</span>
    </div>`;
  }).join("");
}

/* ─────────────── LeetCode журнал ─────────────── */

function renderLeetcode() {
  const root = document.getElementById("lcList");
  if (!state.leetcode.length) {
    root.innerHTML = `<p class="muted small" style="margin:0">Пока пусто. Записывай каждую задачу — потом видно, какие темы проседают.</p>`;
    return;
  }
  root.innerHTML = "";
  [...state.leetcode].reverse().forEach((item) => {
    const row = el("div", "lc-item");
    row.innerHTML = `<div><div class="nm">${escapeHtml(item.name)}</div><div class="th">${escapeHtml(item.theme || "без темы")} · ${item.date}</div></div>
      <span class="df ${item.diff}">${item.diff}</span>`;
    const del = el("button", "lc-del", "✕");
    del.type = "button";
    del.title = "Удалить";
    del.addEventListener("click", () => {
      state.leetcode = state.leetcode.filter((x) => x.id !== item.id);
      save();
      renderProgress();
      renderHero();
    });
    row.appendChild(del);
    root.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ─────────────── правила ─────────────── */

const RULES = [
  ["Не пропускать два дня подряд.", " Сегодня не вышло — завтра возвращаешься хотя бы к минимуму."],
  ["Не навёрстывать пропущенные часы.", " Пропуск — это просто пропуск, а не долг."],
  ["Не увеличивать нагрузку резко.", " Сначала привыкни к норме, потом двигайся дальше."],
  ["YouTube — не обучение,", " если после него ты ничего не попробовал руками."],
  ["Оценивать результат,", " а не количество часов за компьютером."],
  ["Не сидеть в Shorts перед учебным блоком.", " Лучше отложить их до конца запланированного."],
  ["Максимум — не обязательство.", " Обычный день — это норма, а не провал."],
  ["Суббота — ревизия недели.", " Уроки, темы, задачи, отклики, тренировки."],
];

function renderRules() {
  document.getElementById("rules").innerHTML = RULES.map(
    ([a, b], i) => `<div class="rule"><span class="num">${i + 1}</span><div><b>${a}</b>${b}</div></div>`
  ).join("");

  document.getElementById("sources").innerHTML = SOURCES.map(
    (s) => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a><span>${s.text}</span></li>`
  ).join("");
}

/* ─────────────── табы ─────────────── */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
  /* Возврат на страницу — туда же, где остановился. Иначе после перезагрузки
     всегда открывается «День», даже если человек смотрел профиль. */
  try {
    localStorage.setItem(STORE_KEY + ":tab", name);
  } catch {}
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* последняя открытая вкладка */
(function restoreTab() {
  try {
    const saved = localStorage.getItem(STORE_KEY + ":tab");
    if (saved && document.getElementById("panel-" + saved)) switchTab(saved);
  } catch {}
})();

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

/* ─────────────── дата ─────────────── */

const dateInput = document.getElementById("dateInput");
dateInput.value = selectedDate;

dateInput.addEventListener("change", () => {
  if (!dateInput.value) return;
  selectedDate = dateInput.value;
  renderAll();
});

document.getElementById("prevDay").addEventListener("click", () => {
  selectedDate = shiftDay(selectedDate, -1);
  dateInput.value = selectedDate;
  renderAll();
});

document.getElementById("nextDay").addEventListener("click", () => {
  selectedDate = shiftDay(selectedDate, 1);
  dateInput.value = selectedDate;
  renderAll();
});

/* ─────────────── LeetCode ─────────────── */

document.getElementById("lcAdd").addEventListener("click", () => {
  const name = document.getElementById("lcName").value.trim();
  if (!name) {
    play("nope");
    toast("Напиши название задачи");
    return;
  }
  state.leetcode.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    name,
    theme: document.getElementById("lcTheme").value.trim(),
    diff: document.getElementById("lcDiff").value,
    date: todayKey(),
  });
  document.getElementById("lcName").value = "";
  document.getElementById("lcTheme").value = "";
  save();
  renderProgress();
  renderHero();
  play("markGood");
  toast("Записано. Теперь задачу нужно повторить через несколько дней.");
});

/* ─────────────── сброс ─────────────── */

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Точно удалить все отметки, журнал и статистику?")) return;
  state = cloneDeep(DEFAULT_STATE);
  save();
  selectedDate = todayKey();
  dateInput.value = selectedDate;
  renderAll();
  toast("Всё сброшено. Чистый лист.");
});

/* ─────────────── рендер ─────────────── */

function renderAll() {
  if (typeof namazSync === "function" && namazEnabled()) namazSync(selectedDate);
  if (typeof renderNamaz === "function") renderNamaz();
  renderModes();
  renderBlocks();
  renderRing();
  renderHero();
  renderProgress();
  renderWeek();
  renderGym();
  renderNow();
  renderTimeline();
  renderAchievements();
}

renderBadDay();
renderRules();
renderAll();

/* ─────────────── новый слой: звук, достижения, офлайн, синк ─────────────── */

initAudioOnFirstGesture();
renderSfxBox();
renderPushBox();

/* Достижения, заработанные до этой версии, отмечаем молча:
   звук и тост — только за то, что случилось при тебе. */
(function unlockExistingQuietly() {
  const fresh = checkAchievements();
  renderAchievements();
  return fresh;
})();

initServiceWorker().then(refreshPushState);
initSync();

/* идущие таймеры обновляем раз в секунду — только цифры, без полной перерисовки */
function tickTimerLabel() {
  const running = runningTimers();
  if (!running.length) return;

  running.forEach((t) => {
    if (t.date !== selectedDate) {
      /* таймер идёт в другом дне — цифры тут не наши, но плашки «сейчас» живут всегда */
      if (typeof renderNow === "function") renderNow();
      return;
    }
    const card = document.querySelector(`.block[data-id="${t.block}"]`);
    if (!card) return;

    const live = hoursFor(selectedDate, t.block);
    const label = card.querySelector(".time-value");
    if (label) {
      label.textContent = fmtMinutes(live);
      label.classList.add("has", "ticking");
    }
    /* Перешли порог по ходу таймера — плашка должна загореться сама. */
    applyLiveLevel(card, t.block, live);
  });
}

/* Плашки уровней и рамка карточки по «живому» времени (записанное + таймер). */
function applyLiveLevel(card, blockId, minutes) {
  const level = levelFromMinutes(blockId, minutes);
  const reached = level ? LEVEL_ORDER[level] : 0;
  const changed = (card.dataset.level || "") !== (level || "");
  card.dataset.level = level || "";
  card.classList.toggle("done", Boolean(level));

  card.querySelectorAll(".level-btn").forEach((btn) => {
    const lvl = btn.dataset.lvl;
    btn.classList.toggle("on", reached >= LEVEL_ORDER[lvl]);
    btn.classList.toggle("current", lvl === level);
  });

  /* Плашка «Сейчас» и полосы прогресса тоже не должны отставать. */
  if (changed) renderProgress();
}
setInterval(tickTimerLabel, 1000);

/* ─────────── напоминания на намаз: за 20 минут и в момент начала ───────────
   Работает, пока вкладка открыта. Пуш из сервис-воркера — отдельная история,
   здесь простые локальные уведомления и тост, чтобы не пропустить. */
const namazNotified = new Set();

function namazTick() {
  if (typeof namazEnabled !== "function" || !namazEnabled()) return;
  const now = new Date();
  const nowKey = keyOf(now);
  if (namazSkipToday()) return;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  /* подъём на фаджр: за 10 минут до него и в сам момент */
  const night = nightNow(now);
  if (night) {
    const p = night.plan;
    [[p.wake, `Подъём на фаджр — намаз в ${p.fajrTime}.`], [p.fajr, `Время фаджра — ${p.fajrTime}. До восхода ${p.sunriseTime}.`]].forEach(([at, text]) => {
      const key = `wake:${nowKey}:${at}`;
      if (nowMin !== at || namazNotified.has(key)) return;
      namazNotified.add(key);
      toast(text);
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        try {
          new Notification("🕌 Фаджр", { body: text, icon: "./icon-192.png", tag: "namaz-wake" });
        } catch {
          /* молча */
        }
      }
      if (typeof play === "function") play("tick");
    });
    return;
  }

  namazDay(nowKey).forEach((p) => {
    [20, 0].forEach((ahead) => {
      const key = `${nowKey}:${p.id}:${ahead}`;
      if (nowMin !== p.at - ahead || namazNotified.has(key)) return;
      namazNotified.add(key);
      const text =
        ahead === 0
          ? `Время ${p.name} — ${p.time}.`
          : `${p.name} через 20 минут — в ${p.time}.`;
      toast(text);
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        try {
          new Notification("🕌 " + p.name, { body: text, icon: "./icon-192.png", tag: "namaz-" + p.id });
        } catch {
          /* браузер может запретить — молча живём дальше */
        }
      }
      if (typeof play === "function") play("tick");
    });
  });
}
setInterval(namazTick, 20000);

/* ─────────── расписание намаза из API ───────────
   Один раз при загрузке, дальше — при смене месяца/даты и по таймеру.
   Всё кешируется в localStorage, поэтому офлайн ничего не ломается. */
var namazFetching = false;

function namazSync(dateKey) {
  if (typeof namazRefresh !== "function") return;
  if (!namazEnabled()) return;
  if (namazFetching) return;
  /* месяц уже в кеше и свежий — сеть не дёргаем */
  if (typeof namazApiFresh === "function" && namazApiFresh((dateKey || todayKey()).slice(0, 7))) return;
  namazFetching = true;
  namazRefresh(dateKey || todayKey(), {
    onUpdate: () => {
      renderNamaz();
      renderNow();
      renderTimeline();
    },
  })
    .catch(() => null)
    .then(() => {
      namazFetching = false;
    });
}

/* плашка «Сейчас» живёт сама: раз в 30 секунд и при возврате во вкладку */
setInterval(() => {
  renderNow();
  const panel = document.getElementById("panel-day");
  if (panel && panel.classList.contains("active")) renderTimeline();
  /* идущий таймер мог пересечь порог — перерисовываем блоки, даже без клика */
  if (runningTimers().length) renderBlocks();
}, 30000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    renderNow();
    if (typeof namazSync === "function") namazSync(selectedDate);
    if (selectedDate !== todayKey()) return;
    renderTimeline();
  }
});

/* версия сборки — чтобы при жалобе «не работает» было видно, что открыто */
(function showBuild() {
  const root = document.getElementById("profileBuild");
  if (!root) return;
  root.textContent = "Трекер · " + BUILD_LABEL + " · данные локально и в аккаунте";
})();

/* подсказка при первом визите */
if (!localStorage.getItem(STORE_KEY + ":seen")) {
  localStorage.setItem(STORE_KEY + ":seen", "1");
  setTimeout(() => toast("Начни с одного блока. Даже 20 минут считаются."), 900);
}

/* ─────────────── настройки звука ─────────────── */

function renderNamazBox() {
  const root = document.getElementById("namazBox");
  if (!root) return;
  const on = namazEnabled();
  const nowKey = todayKey();
  const t = namazTimes(nowKey);
  const skipped = namazSkipToday();

  root.innerHTML = `
    <div class="acc-row">
      <span class="acc-dot ${on ? "on" : "off"}"></span>
      <div>
        <div class="acc-title">Намаз · ${NAMAZ_CITY.name}</div>
        <div class="acc-sub">${
          on
            ? `${t.source}. Восход ${t.sunrise || "—"}, фаджр ${t.fajr} — подъём в это время. Отметки намазов и напоминание за 20 минут до и в момент начала.`
            : "Блок намаза скрыт."
        }</div>
      </div>
    </div>
    <div class="sfx-actions">
      <button class="ghost-btn acc-btn" id="namazToggle">${on ? "Выключить" : "Включить"}</button>
      ${on ? `<button class="ghost-btn acc-btn" id="namazRefreshBtn">Обновить из API</button>` : ""}
      ${on ? `<button class="ghost-btn acc-btn" id="namazSkipBtn">${skipped ? "Вернуть намаз на сегодня" : "Пропустить сегодня"}</button>` : ""}
    </div>`;

  document.getElementById("namazToggle").addEventListener("click", () => {
    state.namazOn = !on;
    save();
    renderNamazBox();
    renderNamaz();
    renderNow();
  });

  const refreshBtn = document.getElementById("namazRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Обновляю…";
      const ok = await namazRefresh(selectedDate, { force: true });
      renderNamazBox();
      renderNamaz();
      renderNow();
      renderTimeline();
      toast(ok ? "Расписание обновлено из API" : "API недоступен — остаёмся на кеше");
    });
  }

  const skipBtn = document.getElementById("namazSkipBtn");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      setNamazSkipToday(!skipped);
      renderNamazBox();
      renderNamaz();
      renderNow();
    });
  }
}

renderNamazBox();

function renderSfxBox() {
  const root = document.getElementById("sfxBox");
  if (!root) return;
  const on = sfxEnabled();

  root.innerHTML = `
    <div class="acc-row">
      <span class="acc-dot ${on ? "on" : "off"}"></span>
      <div>
        <div class="acc-title">Звуки достижений</div>
        <div class="acc-sub">${on ? "Короткий приятный сигнал при отметке, закрытии дня и новых достижениях." : "Выключены — тишина."}</div>
      </div>
    </div>
    <div class="sfx-actions">
      <button class="ghost-btn acc-btn" id="sfxToggle">${on ? "Выключить" : "Включить"}</button>
      <button class="ghost-btn acc-btn" id="sfxTest">Проверить звук</button>
    </div>`;

  document.getElementById("sfxToggle").addEventListener("click", () => {
    setSfxEnabled(!on);
    renderSfxBox();
    if (!on) play("markGood");
  });

  document.getElementById("sfxTest").addEventListener("click", () => {
    const wasOn = sfxEnabled();
    if (!wasOn) setSfxEnabled(true);
    SFX.achievement();
    if (!wasOn) setTimeout(() => setSfxEnabled(false), 100);
  });
}

renderSfxBox();
