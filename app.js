/* «Возвращение в профессию» — логика трекера */

const STORE_KEY = "vp-tracker-v1";

const DEFAULT_STATE = {
  days: {},        // { "2026-11-04": { ulbi: "norm", ... } }
  modes: {},       // { "2026-11-04": "bad" | "norm" | "good" }
  gym: {},         // { "1": { mon: true, wed: false, fri: true } }
  week: 1,
  leetcode: [],    // [{ id, name, theme, diff, date }]
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
let selectedDate = todayKey();

/* ─────────────── утилиты ─────────────── */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return cloneDeep(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return { ...cloneDeep(DEFAULT_STATE), ...parsed };
  } catch {
    return cloneDeep(DEFAULT_STATE);
  }
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

function dayData(key) {
  if (!state.days[key]) state.days[key] = {};
  return state.days[key];
}

/* Отметка времени изменения дня — по ней синхронизация решает,
   чья версия свежее (телефон или компьютер). */
function touchDay(key) {
  if (!state.meta) state.meta = {};
  state.meta[key] = Date.now();
}

function modeFor(key) {
  return state.modes[key] || "norm";
}

const LEVEL_ORDER = { min: 1, norm: 2, max: 3 };

/* ─────────────── дневной чек-лист ─────────────── */

const blocksRoot = document.getElementById("blocks");
const tipsState = new Set();

function renderBlocks() {
  const data = dayData(selectedDate);
  blocksRoot.innerHTML = "";

  BLOCKS.forEach((b) => {
    const lvl = data[b.id];
    const future = isFutureDate(selectedDate);
    const card = el("div", "block" + (lvl ? " done" : "") + (future ? " future" : ""));
    card.dataset.id = b.id;

    const top = el("div", "block-top");
    top.innerHTML = `
      <div class="block-icon">${b.icon}</div>
      <div class="block-info">
        <div class="block-name">${b.name}</div>
        <div class="block-desc">${b.desc}</div>
      </div>`;

    const pick = el("div", "level-pick");
    ["min", "norm", "max"].forEach((level) => {
      const btn = el(
        "button",
        "level-btn" + (lvl === level ? " on" : ""),
        `${LEVEL_LABEL[level]}<small>${b[level]}</small>`
      );
      btn.dataset.lvl = level;
      btn.type = "button";
      btn.addEventListener("click", () => {
        const d = dayData(selectedDate);
        if (d[b.id] === level) delete d[b.id];
        else d[b.id] = level;
        touchDay(selectedDate);
        save();
        renderAll();
        if (d[b.id]) {
          play(level === "min" ? "mark" : "markGood");
          /* Первая отметка в будущем дне — честно говорим, что попадёт в статистику. */
          if (isFutureDate(selectedDate)) {
            toast("Отмечено на будущую дату. Пока этот день не наступил, статистика считает его закрытым.");
            return;
          }
          const msgs = {
            min: "Минимум засчитан. Этого уже достаточно.",
            norm: "Норма дня. Хорошая работа.",
            max: "Максимум — сильно. Но не превращай это в норму.",
          };
          toast(msgs[level]);
        }
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

    const meta = el("div", "block-meta");
    meta.style.cssText = "display:flex;align-items:center;margin-top:8px";
    meta.appendChild(toggle);
    card.appendChild(meta);
    card.appendChild(tips);

    blocksRoot.appendChild(card);
  });
}

/* ─────────────── прогресс-кольцо ─────────────── */

/* даты, по которым звук «день закрыт» уже сыграл */
const closedCelebrated = new Set();

function dayScore(key) {
  const data = state.days[key] || {};
  const target = MODE_TARGET[modeFor(key)];
  const values = BLOCKS.map((b) => LEVEL_ORDER[data[b.id]] || 0);
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
  if (!(state.days[cursor] && Object.keys(state.days[cursor]).length)) {
    cursor = shiftDay(cursor, -1);
  }
  while (state.days[cursor] && Object.keys(state.days[cursor]).length) {
    n++;
    cursor = shiftDay(cursor, -1);
  }
  return n;
}

function closedDays() {
  return Object.values(state.days).filter((d) => d && Object.keys(d).length).length;
}

function renderHero() {
  const root = document.getElementById("heroStats");
  const s = streak();
  const cd = closedDays();
  const gymDone = Object.values(state.gym).reduce(
    (sum, w) => sum + Object.values(w).filter(Boolean).length,
    0
  );
  root.innerHTML = `
    <span class="chip">🔥 Серия <b>${s} ${plural(s, "день", "дня", "дней")}</b></span>
    <span class="chip">✅ Закрыто дней <b>${cd}</b></span>
    <span class="chip">💪 Тренировок <b>${gymDone}</b></span>
    <span class="chip">🧩 LeetCode <b>${state.leetcode.length}</b></span>`;
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

function fmtMinutes(total) {
  const t = Math.max(0, total);
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

function currentTimeline() {
  const view = state.scheduleView === "coarse" ? "coarse" : "detail";
  return SCHEDULE_VIEWS[view].timeline;
}

/* Какой сейчас интервал. Возвращает {slot, index, left, next} или null вне расписания. */
function slotNow(date) {
  const timeline = currentTimeline();
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
  const info = slotNow(now);
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

  if (!info) {
    root.className = "now-card now-off";
    root.innerHTML = `
      <div class="now-head">
        <span class="now-pill"><span class="live-dot"></span> Сейчас · ${timeStr}</span>
        <span class="now-day">${WEEKDAY_NAMES[dow]}, ${DATE_FMT.format(now)}</span>
      </div>
      <div class="now-main">
        <div class="now-icon">🌙</div>
        <div class="now-text">
          <div class="now-title">Вне расписания</div>
          <div class="now-sub">Расписание идёт с 09:00 до 23:00. Отдых — тоже часть плана.</div>
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
    const data = state.days[nowKey] || {};
    const done = data[slot.block];
    const target = targetLevelFor(nowKey);
    if (block) {
      blockLine = done
        ? `<button class="now-done is-done" disabled>✓ Отмечено: ${LEVEL_TEXT[done]} · ${block[done]}</button>`
        : `<button class="now-done" data-mark="${slot.block}" data-level="${target}">Отметить ${LEVEL_TEXT[target]} · ${block[target]}</button>`;
    }
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
    ${blockLine}
    <div class="now-foot">
      ${next ? `<span class="now-next">Дальше ${next.from} · ${next.label}</span>` : `<span class="now-next">Последний блок дня</span>`}
      <span class="now-workout">${workoutTitle}</span>
    </div>
    ${!isToday ? `<div class="now-hint">Открыт другой день — плашка показывает текущий момент.</div>` : ""}`;

  const btn = root.querySelector("[data-mark]");
  if (btn) {
    btn.addEventListener("click", () => {
      const data = dayData(nowKey);
      const id = btn.dataset.mark;
      const level = btn.dataset.level;
      data[id] = level;
      touchDay(nowKey);
      save();
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
  const timeline = currentTimeline();
  const now = new Date();
  const nowKey = keyOf(now);
  const active = selectedDate === nowKey ? slotNow(now) : null;
  const data = state.days[selectedDate] || {};
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

  timeline.forEach((slot, i) => {
    const isNow = active && active.index === i;
    const isPast = selectedDate === nowKey && active && i < active.index;
    const row = el(
      "div",
      "tl-row" + (isNow ? " is-now" : "") + (slot.tag === "глубоко" ? " strong" : "") + (isPast ? " is-past" : "")
    );
    const done = slot.block && data[slot.block];
    row.innerHTML = `
      <span class="tl-time">${slot.from}<small>–${slot.to}</small></span>
      <span class="tl-label">${slot.icon ? `<span class="tl-ico">${slot.icon}</span>` : ""}${slot.label}${
        done ? ` <span class="tl-done">✓ ${LEVEL_TEXT[done]}</span>` : ""
      }</span>
      ${isNow ? '<span class="tl-now">сейчас</span>' : ""}`;
    root.appendChild(row);
  });

  if (selectedDate === nowKey && active && active.slot.block && data[active.slot.block] === undefined) {
    /* подсказка под расписанием — что отметить прямо сейчас */
    const hint = el("p", "tl-hint", `Сейчас по плану <b>${LEVEL_TEXT[target]}</b> в блоке «${BLOCKS.find((b) => b.id === active.slot.block).name}».`);
    root.appendChild(hint);
  }
}

/* ─────────────── прогресс ─────────────── */

function renderProgress() {
  const cd = closedDays();
  const days30 = lastNKeys(30);
  const marked30 = days30.filter((k) => state.days[k] && Object.keys(state.days[k]).length).length;
  const gyms = Object.values(state.gym).reduce((s, w) => s + Object.values(w).filter(Boolean).length, 0);
  const minDays = days30.filter((k) => {
    const d = state.days[k] || {};
    return Object.values(d).length > 0 && Object.values(d).every((v) => v === "min");
  }).length;

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
    const d = state.days[key] || {};
    const count = Object.values(d).length;
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
    const n = keys.filter((k) => state.days[k] && state.days[k][b.id]).length;
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
  window.scrollTo({ top: 0, behavior: "smooth" });
}

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

/* плашка «Сейчас» живёт сама: раз в 30 секунд и при возврате во вкладку */
setInterval(() => {
  renderNow();
  const nowKey = keyOf(new Date());
  const panel = document.getElementById("panel-day");
  if (panel && panel.classList.contains("active")) renderTimeline();
  if (selectedDate === nowKey && state.days[nowKey]) renderBlocks();
}, 30000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    renderNow();
    if (selectedDate !== todayKey()) return;
    renderTimeline();
  }
});

/* подсказка при первом визите */
if (!localStorage.getItem(STORE_KEY + ":seen")) {
  localStorage.setItem(STORE_KEY + ":seen", "1");
  setTimeout(() => toast("Начни с одного блока. Даже 20 минут считаются."), 900);
}

/* ─────────────── настройки звука ─────────────── */

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
