/* ─────────────────────────────────────────────────────────────
   levels.js — XP, уровни и ранги.

   ГЛАВНАЯ ИДЕЯ: XP не хранится. Он каждый раз считается из тех данных,
   что уже есть в приложении (минуты, блоки, намаз, тренировки, LeetCode,
   серии, достижения). Поэтому:
   • на ПК и на телефоне уровень всегда одинаковый, синхронизировать нечего;
   • никаких гонок: два устройства не могут «потерять» XP друг у друга;
   • стёр отметку — XP убавился, как и должно быть.
   Локально запоминается только самый высокий отпразднованный уровень
   (чтобы фейерверк не повторялся) и пара флажков показа.

   Файл сам подгружает levels.css, сам добавляет вкладку «Уровень» и
   карточку уровня в шапку. app.js и styles.css не меняются.
   ───────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  /* ═════════════ правила начисления ═════════════ */

  const RULES = {
    perMinute: 0.25, // 15 XP за час работы
    block: { min: 8, norm: 20, max: 35 }, // за блок, итого за день (не складывается)
    dayClosed: 25, // день закрыт по режиму (плохой / обычный / хороший)
    namaz: 6, // за каждый намаз
    namazAll: 15, // бонус, если за день все пять
    gym: 40, // за тренировку
    gymWeek: 30, // бонус за 3 из 3 за неделю
    lc: { Easy: 20, Medium: 40, Hard: 80 },
    streakStep: 2, // день серии n даёт n × 2 XP
    streakCap: 10, // но не больше 10 × 2 = 20 XP
    achievement: 50,
  };

  /* Цель дня в XP зависит от режима: в плохой день планка ниже. */
  const DAILY_GOAL = { bad: 60, norm: 150, good: 250 };

  /* ═════════════ уровни ═════════════ */

  /* Сколько всего XP нужно, чтобы ДОЙТИ до уровня l.
     120·(l−1)^1.55: 2-й уровень — 120 XP (за полдня), 10-й — ≈3 600,
     20-й — ≈11 500, 30-й — ≈22 000. Крутизна растёт, но не рвётся. */
  function xpForLevel(l) {
    return l <= 1 ? 0 : Math.round(120 * Math.pow(l - 1, 1.55));
  }

  function levelFor(xp) {
    let l = 1;
    while (l < 99 && xp >= xpForLevel(l + 1)) l++;
    return l;
  }

  /* Ранги: от «Новичка» до «Легенды». a/b/c — цвета градиента кольца и шкалы. */
  const TIERS = [
    { from: 1, name: "Новичок", icon: "🌱", a: "#c6f24e", b: "#37d6c0", text: "Первые шаги. Главное — вернуться завтра." },
    { from: 3, name: "Стажёр", icon: "⌨️", a: "#37d6c0", b: "#4ea8ff", text: "Привычка начинает складываться." },
    { from: 6, name: "Джуниор", icon: "🚀", a: "#4ea8ff", b: "#7c6cff", text: "Уже видно систему, а не порывы." },
    { from: 10, name: "Джуниор+", icon: "⚡", a: "#7c6cff", b: "#b06cff", text: "Темп держится даже в плохие дни." },
    { from: 15, name: "Мидл", icon: "🛠️", a: "#b06cff", b: "#ff6cc8", text: "Знаний и дисциплины хватит на собеседования." },
    { from: 20, name: "Мидл+", icon: "💎", a: "#ff6cc8", b: "#ff9a6c", text: "Редкая стабильность. Это и есть профессия." },
    { from: 27, name: "Сеньор", icon: "🦅", a: "#ffb56b", b: "#ffd86b", text: "Опыт, на который можно опереться." },
    { from: 35, name: "Тимлид", icon: "👑", a: "#ffd86b", b: "#ff7a3d", text: "Ты уже тянешь за собой других своим примером." },
    { from: 45, name: "Архитектор", icon: "🏛️", a: "#ff7a8a", b: "#ffd86b", text: "Система работает без усилий воли." },
    { from: 60, name: "Легенда", icon: "🌌", a: "#c6f24e", b: "#b06cff", c: "#ff6cc8", text: "Дальше только своя планка." },
  ];

  function tierFor(level) {
    let t = TIERS[0];
    for (const x of TIERS) if (level >= x.from) t = x;
    return t;
  }

  const FLAVOR = [
    "Каждая закрытая задача — кирпичик.",
    "Маленькие шаги тоже считаются.",
    "Регулярность сильнее вдохновения.",
    "Ты уже дальше, чем вчера.",
    "Даже минимум двигает вперёд.",
    "Хороший темп. Не торопись, но и не стой.",
  ];

  /* ═════════════ подсчёт XP из данных приложения ═════════════ */

  const PART_KEYS = ["time", "blocks", "days", "namaz", "gym", "lc", "streak", "ach"];

  function computeXp() {
    const parts = { time: 0, blocks: 0, days: 0, namaz: 0, gym: 0, lc: 0, streak: 0, ach: 0 };
    const stats = { minutes: 0, blocks: 0, days: 0, namaz: 0, gym: 0, lc: 0, workDays: 0, ach: 0 };
    const byDay = {}; // дата → XP из «датированных» источников (тренировки без даты)

    const add = (part, date, value) => {
      if (!value) return;
      parts[part] += value;
      if (date) byDay[date] = (byDay[date] || 0) + value;
    };

    const ids = typeof NAMAZ_IDS !== "undefined" ? NAMAZ_IDS : ["fajr", "dhuhr", "asr", "maghrib", "isha"];

    /* Будущие даты не считаем: иначе XP можно «нафармить» отметками наперёд. */
    const dates = Object.keys(state.hours || {}).filter((k) => !isFutureDate(k));
    const work = [];

    dates.forEach((date) => {
      const minutes = hoursFor(date);
      if (!(minutes > 0)) return;
      work.push(date);
      stats.minutes += minutes;
      add("time", date, Math.round(minutes * RULES.perMinute));

      BLOCKS.forEach((b) => {
        const lv = levelOf(date, b.id);
        if (lv) {
          add("blocks", date, RULES.block[lv] || 0);
          stats.blocks++;
        }
      });

      const sc = dayScore(date);
      if (sc.done > 0 && sc.pct >= 1) {
        add("days", date, RULES.dayClosed);
        stats.days++;
      }
    });

    Object.keys(state.namaz || {}).forEach((date) => {
      if (isFutureDate(date)) return;
      const day = state.namaz[date] || {};
      const n = ids.filter((id) => day[id]).length;
      if (!n) return;
      stats.namaz += n;
      add("namaz", date, n * RULES.namaz + (n === ids.length ? RULES.namazAll : 0));
    });

    /* Тренировки хранятся по неделям программы, без календарной даты —
       поэтому в «XP по дням» их нет, но в общий счёт они входят. */
    Object.values(state.gym || {}).forEach((week) => {
      if (!week || typeof week !== "object") return;
      const n = ["mon", "wed", "fri"].filter((k) => week[k] === true).length;
      if (!n) return;
      stats.gym += n;
      parts.gym += n * RULES.gym + (n === 3 ? RULES.gymWeek : 0);
    });

    (state.leetcode || []).forEach((item) => {
      stats.lc++;
      add("lc", item.date, RULES.lc[item.diff] || RULES.lc.Easy);
    });

    /* Серия: каждый следующий день подряд даёт больше (до потолка). */
    work.sort();
    let run = 0;
    let prev = null;
    work.forEach((date) => {
      run = prev && shiftDay(prev, 1) === date ? run + 1 : 1;
      prev = date;
      add("streak", date, Math.min(run, RULES.streakCap) * RULES.streakStep);
    });
    stats.workDays = work.length;

    Object.keys(state.achievements || {}).forEach((id) => {
      const iso = state.achievements[id];
      const when = typeof iso === "string" ? new Date(iso) : null;
      const date = when && Number.isFinite(when.getTime()) ? keyOf(when) : null;
      stats.ach++;
      add("ach", date, RULES.achievement);
    });

    const total = PART_KEYS.reduce((s, k) => s + parts[k], 0);
    return { total, parts, stats, byDay, today: byDay[todayKey()] || 0 };
  }

  function buildModel(x) {
    const level = levelFor(x.total);
    const base = xpForLevel(level);
    const next = xpForLevel(level + 1);
    const span = next - base;
    return {
      ...x,
      level,
      base,
      next,
      into: x.total - base,
      span,
      pct: span ? (x.total - base) / span : 0,
      toNext: next - x.total,
      tier: tierFor(level),
    };
  }

  if (typeof document === "undefined") {
    /* запуск вне браузера (проверка в Node) */
    if (typeof module !== "undefined" && module.exports) {
      module.exports = { RULES, DAILY_GOAL, xpForLevel, levelFor, tierFor, TIERS, computeXp, buildModel };
    }
    return;
  }

  /* ═════════════ локальная память: что уже праздновали ═════════════ */

  const SEEN_KEY = "vp-tracker-levels-v1";

  function readSeen() {
    try {
      const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "null");
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }
  function writeSeen(v) {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }

  /* ═════════════ утилиты ═════════════ */

  const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const fmtInt = (n) => Math.round(n).toLocaleString("ru-RU");
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function setHTML(el, html) {
    if (!el || el._h === html) return;
    el._h = html;
    el.innerHTML = html;
  }

  function applyTier(el, tier) {
    if (!el) return;
    el.style.setProperty("--ta", tier.a);
    el.style.setProperty("--tb", tier.b);
    el.style.setProperty("--tc", tier.c || tier.b);
  }

  /* ═════════════ кольцо-«шар» уровня ═════════════ */

  let orbSeq = 0;
  const ORB_C = 2 * Math.PI * 52; // длина окружности, как у кольца дня в шапке

  function orbHTML(cls) {
    const id = "xpg" + ++orbSeq;
    return (
      `<div class="xp-orb ${cls}">` +
      `<svg viewBox="0 0 120 120" aria-hidden="true">` +
      `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" style="stop-color:var(--ta)"/>` +
      `<stop offset=".55" style="stop-color:var(--tc)"/>` +
      `<stop offset="1" style="stop-color:var(--tb)"/></linearGradient></defs>` +
      `<circle class="xp-orb-track" cx="60" cy="60" r="52"/>` +
      `<circle class="xp-orb-arc" cx="60" cy="60" r="52" stroke="url(#${id})"/>` +
      `</svg>` +
      `<div class="xp-orb-core"><span class="xp-orb-ico"></span><b class="xp-orb-num"></b></div>` +
      `</div>`
    );
  }

  function paintOrb(orb, model, levelOverride) {
    if (!orb) return;
    applyTier(orb, model.tier);
    $(".xp-orb-ico", orb).textContent = model.tier.icon;
    $(".xp-orb-num", orb).textContent = String(levelOverride != null ? levelOverride : model.level);
    $(".xp-orb-arc", orb).style.strokeDashoffset = String(ORB_C * (1 - Math.max(0, Math.min(1, model.pct))));
  }

  /* ═════════════ монтирование интерфейса ═════════════ */

  let mounted = false;
  let heroCard = null;
  let panel = null;

  function mount() {
    if (mounted) return;
    const heroMain = $(".hero-main");
    const heroStats = document.getElementById("heroStats");
    const nav = $("nav.tabs");
    const main = $("main.wrap");
    const awardsPanel = document.getElementById("panel-awards");
    if (!heroMain || !heroStats || !nav || !main) return;
    mounted = true;

    /* карточка уровня в шапке */
    heroCard = document.createElement("button");
    heroCard.type = "button";
    heroCard.id = "xpHero";
    heroCard.className = "xp-hero";
    heroCard.setAttribute("aria-label", "Открыть уровень и XP");
    heroCard.innerHTML =
      orbHTML("xp-orb-sm") +
      `<span class="xp-hero-body">` +
      `<span class="xp-hero-top"><b class="xp-rank"></b><span class="xp-lvl"></span><span class="xp-today"></span></span>` +
      `<span class="xp-bar"><i class="xp-fill"></i></span>` +
      `<span class="xp-hero-sub"></span>` +
      `</span>`;
    heroStats.insertAdjacentElement("afterend", heroCard);
    heroCard.addEventListener("click", () => switchTab("levels"));

    /* вкладка */
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.dataset.tab = "levels";
    tab.setAttribute("role", "tab");
    tab.textContent = "Уровень";
    const awardsTab = nav.querySelector('[data-tab="awards"]');
    nav.insertBefore(tab, awardsTab || null);
    tab.addEventListener("click", () => switchTab("levels"));

    /* панель */
    panel = document.createElement("section");
    panel.className = "panel";
    panel.id = "panel-levels";
    panel.innerHTML =
      `<div class="section-head"><h2>Уровень героя</h2>` +
      `<p>Минуты работы, закрытые блоки, намаз, тренировки и задачи превращаются в XP. ` +
      `Уровень считается из твоих данных, поэтому на ПК и телефоне он всегда одинаковый.</p></div>` +
      `<div class="lv-hero card" id="lvHero">` +
      orbHTML("xp-orb-lg") +
      `<div class="lv-hero-body">` +
      `<div class="lv-tier"><span class="lv-tier-ico"></span><span class="lv-tier-name"></span><span class="lv-tier-lvl"></span></div>` +
      `<p class="lv-flavor"></p>` +
      `<div class="xp-bar xp-bar-lg"><i class="xp-fill"></i><span class="xp-ticks"></span></div>` +
      `<div class="lv-xp-line"><b class="lv-xp-now"></b><span class="lv-xp-next"></span></div>` +
      `<div class="lv-nextrank"></div>` +
      `</div></div>` +
      `<div class="lv-goal card" id="lvGoal">` +
      `<div class="lv-goal-top"><h3>Цель дня</h3><span class="lv-goal-val"></span></div>` +
      `<div class="xp-bar"><i class="xp-fill"></i></div>` +
      `<p class="lv-goal-note muted small"></p></div>` +
      `<div class="section-head"><h2>Откуда XP</h2><p>Всё, что ты делаешь по плану, — в зачёт. Даже в плохой день.</p></div>` +
      `<div class="lv-parts" id="lvParts"></div>` +
      `<div class="card lv-chart-card"><h3>XP за 14 дней</h3><div class="lv-chart" id="lvChart"></div>` +
      `<p class="muted small lv-foot">Тренировки идут в общий счёт, но не привязаны к дню, поэтому на графике их нет.</p></div>` +
      `<div class="section-head"><h2>Дорога вверх</h2><p>Ближайшие уровни и все ранги.</p></div>` +
      `<div class="card lv-ladder" id="lvLadder"></div>` +
      `<div class="lv-tiers" id="lvTiers"></div>` +
      `<div class="card soft lv-rules-card"><h3>Как начисляется XP</h3><div class="lv-rules" id="lvRules"></div></div>`;
    main.insertBefore(panel, awardsPanel || null);

    setHTML($("#lvRules", panel), rulesHTML());

    /* если открывали вкладку «Уровень» до перезагрузки — вернуть её
       (app.js восстанавливает вкладку раньше, чем мы её создали) */
    try {
      if (typeof STORE_KEY !== "undefined" && localStorage.getItem(STORE_KEY + ":tab") === "levels") switchTab("levels");
    } catch {
      /* ignore */
    }
  }

  function rulesHTML() {
    const rows = [
      ["⏱", "Время работы", `${String(RULES.perMinute).replace(".", ",")} XP за минуту (${RULES.perMinute * 60} XP в час)`],
      ["🧱", "Блок дня", `минимум +${RULES.block.min} · норма +${RULES.block.norm} · максимум +${RULES.block.max} (за каждый блок, не суммируется)`],
      ["✅", "День закрыт", `+${RULES.dayClosed} XP, когда выполнен режим дня (плохой, обычный, хороший)`],
      ["🕌", "Намаз", `+${RULES.namaz} XP за каждый, +${RULES.namazAll} XP за все пять в день`],
      ["💪", "Тренировка", `+${RULES.gym} XP, +${RULES.gymWeek} XP за три из трёх за неделю`],
      ["🧩", "LeetCode", `Easy +${RULES.lc.Easy} · Medium +${RULES.lc.Medium} · Hard +${RULES.lc.Hard}`],
      ["🔥", "Серия", `день серии даёт n × ${RULES.streakStep} XP, максимум ${RULES.streakCap * RULES.streakStep} XP в день`],
      ["🏆", "Достижение", `+${RULES.achievement} XP за каждое`],
    ];
    return (
      rows.map(([i, t, d]) => `<div class="lv-rule"><span class="lv-rule-ico">${i}</span><div><b>${t}</b><span>${d}</span></div></div>`).join("") +
      `<p class="muted small lv-rules-foot">Будущие даты в XP не идут. Цель дня: плохой день ${DAILY_GOAL.bad}, обычный ${DAILY_GOAL.norm}, хороший ${DAILY_GOAL.good} XP.</p>`
    );
  }

  /* ═════════════ обновление интерфейса ═════════════ */

  const PART_META = [
    { k: "time", icon: "⏱", title: "Время работы", hint: (s) => (s.minutes ? fmtMinutes(s.minutes) : "пока нет") },
    { k: "blocks", icon: "🧱", title: "Закрытые блоки", hint: (s) => `${s.blocks} ${plural(s.blocks, "блок", "блока", "блоков")}` },
    { k: "days", icon: "✅", title: "Закрытые дни", hint: (s) => `${s.days} ${plural(s.days, "день", "дня", "дней")}` },
    { k: "namaz", icon: "🕌", title: "Намаз", hint: (s) => `${s.namaz} отметок` },
    { k: "gym", icon: "💪", title: "Тренировки", hint: (s) => `${s.gym} ${plural(s.gym, "тренировка", "тренировки", "тренировок")}` },
    { k: "lc", icon: "🧩", title: "LeetCode", hint: (s) => `${s.lc} ${plural(s.lc, "задача", "задачи", "задач")}` },
    { k: "streak", icon: "🔥", title: "Серия дней", hint: (s) => `${s.workDays} ${plural(s.workDays, "рабочий день", "рабочих дня", "рабочих дней")}` },
    { k: "ach", icon: "🏆", title: "Достижения", hint: (s) => `${s.ach} из ${typeof ACHIEVEMENTS !== "undefined" ? ACHIEVEMENTS.length : "?"}` },
  ];

  function updateHero(model) {
    if (!heroCard) return;
    applyTier(heroCard, model.tier);
    paintOrb($(".xp-orb", heroCard), model);
    $(".xp-rank", heroCard).textContent = model.tier.name;
    $(".xp-lvl", heroCard).textContent = "Ур. " + model.level;
    const today = $(".xp-today", heroCard);
    today.textContent = model.today > 0 ? "+" + fmtInt(model.today) + " сегодня" : "";
    $(".xp-fill", heroCard).style.width = (Math.max(0, Math.min(1, model.pct)) * 100).toFixed(1) + "%";
    $(".xp-hero-sub", heroCard).textContent =
      fmtInt(model.total) + " XP · до уровня " + (model.level + 1) + " — " + fmtInt(model.toNext);
  }

  function updatePanel(model) {
    if (!panel) return;
    const heroEl = $("#lvHero", panel);
    applyTier(panel, model.tier);
    paintOrb($(".xp-orb", heroEl), model);
    $(".lv-tier-ico", heroEl).textContent = model.tier.icon;
    $(".lv-tier-name", heroEl).textContent = model.tier.name;
    $(".lv-tier-lvl", heroEl).textContent = "Уровень " + model.level;
    $(".lv-flavor", heroEl).textContent = model.tier.text + " " + FLAVOR[model.level % FLAVOR.length];
    $(".xp-fill", heroEl).style.width = (Math.max(0, Math.min(1, model.pct)) * 100).toFixed(1) + "%";
    $(".lv-xp-now", heroEl).textContent = fmtInt(model.total) + " XP";
    $(".lv-xp-next", heroEl).textContent =
      fmtInt(model.into) + " / " + fmtInt(model.span) + " · до уровня " + (model.level + 1) + " ещё " + fmtInt(model.toNext);

    const nextTier = TIERS.find((t) => t.from > model.level);
    $(".lv-nextrank", heroEl).textContent = nextTier
      ? `Следующий ранг: ${nextTier.icon} ${nextTier.name} с уровня ${nextTier.from} (ещё ${fmtInt(xpForLevel(nextTier.from) - model.total)} XP)`
      : "Высший ранг достигнут. Дальше растут только цифры.";

    /* цель дня */
    const goalEl = $("#lvGoal", panel);
    const mode = typeof modeFor === "function" ? modeFor(todayKey()) : "norm";
    const goal = DAILY_GOAL[mode] || DAILY_GOAL.norm;
    const gpct = Math.min(1, model.today / goal);
    $(".lv-goal-val", goalEl).textContent = fmtInt(model.today) + " / " + goal + " XP";
    $(".xp-fill", goalEl).style.width = (gpct * 100).toFixed(1) + "%";
    goalEl.classList.toggle("done", model.today >= goal);
    $(".lv-goal-note", goalEl).textContent =
      model.today >= goal
        ? "Цель дня выполнена. Всё, что дальше, — бонус."
        : `${mode === "bad" ? "Плохой день: планка ниже. " : ""}Осталось ${fmtInt(goal - model.today)} XP до цели дня.`;

    /* откуда XP */
    const total = Math.max(1, model.total);
    setHTML(
      $("#lvParts", panel),
      PART_META.map((m) => {
        const v = model.parts[m.k];
        const share = Math.round((v / total) * 100);
        return (
          `<div class="lv-part${v ? "" : " empty"}">` +
          `<div class="lv-part-ico">${m.icon}</div>` +
          `<div class="lv-part-body"><div class="lv-part-title">${m.title}</div>` +
          `<div class="lv-part-xp">${fmtInt(v)}<small> XP</small></div>` +
          `<div class="lv-part-bar"><i style="width:${share}%"></i></div>` +
          `<div class="lv-part-hint">${m.hint(model.stats)} · ${share}%</div></div></div>`
        );
      }).join("")
    );

    /* график 14 дней */
    const keys = typeof lastNKeys === "function" ? lastNKeys(14) : [];
    const vals = keys.map((k) => model.byDay[k] || 0);
    const max = Math.max(40, ...vals);
    const today = todayKey();
    setHTML(
      $("#lvChart", panel),
      keys
        .map((k, i) => {
          const h = Math.max(vals[i] ? 6 : 3, Math.round((vals[i] / max) * 100));
          const dt = dateOf(k);
          const wd = typeof WEEKDAY_NAMES_SHORT !== "undefined" ? WEEKDAY_NAMES_SHORT[(dt.getDay() + 6) % 7] : "";
          const label = (typeof DATE_FMT !== "undefined" ? DATE_FMT.format(dt) : k) + " — " + fmtInt(vals[i]) + " XP";
          return (
            `<div class="lv-bar${k === today ? " today" : ""}${vals[i] ? "" : " zero"}" title="${esc(label)}">` +
            `<span class="lv-bar-val">${vals[i] ? fmtInt(vals[i]) : ""}</span>` +
            `<i style="height:${h}%"></i><small>${wd}</small></div>`
          );
        })
        .join("")
    );

    /* лестница ближайших уровней */
    const rows = [];
    for (let l = model.level + 1; l <= model.level + 5; l++) {
      const t = tierFor(l);
      const rankUp = t.from === l && l > 1;
      rows.push(
        `<div class="lv-step${rankUp ? " rankup" : ""}">` +
        `<span class="lv-step-n">${l}</span>` +
        `<span class="lv-step-t">${rankUp ? `${t.icon} Новый ранг: <b>${t.name}</b>` : `Уровень ${l}`}</span>` +
        `<span class="lv-step-xp">${fmtInt(xpForLevel(l))} XP<small>+${fmtInt(xpForLevel(l) - model.total)}</small></span></div>`
      );
    }
    setHTML($("#lvLadder", panel), rows.join(""));

    /* ранги */
    setHTML(
      $("#lvTiers", panel),
      TIERS.map((t) => {
        const reached = model.level >= t.from;
        const current = t === model.tier;
        return (
          `<div class="lv-tier-chip${current ? " current" : ""}${reached ? " reached" : ""}" style="--ta:${t.a};--tb:${t.b}">` +
          `<span class="lv-tier-chip-ico">${reached ? t.icon : "🔒"}</span>` +
          `<b>${t.name}</b><small>с уровня ${t.from}</small></div>`
        );
      }).join("")
    );
  }

  /* ═════════════ всплывающие «+XP» ═════════════ */

  let lastPointer = { x: 0, y: 0, t: 0 };
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
    },
    { passive: true, capture: true }
  );

  const PART_LABEL = {
    time: "время",
    blocks: "блок закрыт",
    days: "день закрыт",
    namaz: "намаз",
    gym: "тренировка",
    lc: "LeetCode",
    streak: "серия",
    ach: "достижение",
  };

  function spawnFloat(amount, label, tier) {
    if (reduceMotion) return;
    const node = document.createElement("div");
    node.className = "xp-float";
    applyTier(node, tier);
    node.innerHTML = `+${fmtInt(amount)} XP${label ? `<small>${esc(label)}</small>` : ""}`;

    let x;
    let y;
    if (Date.now() - lastPointer.t < 1600) {
      x = lastPointer.x;
      y = lastPointer.y - 14;
    } else if (heroCard) {
      const r = heroCard.getBoundingClientRect();
      x = r.left + Math.min(r.width - 70, 150);
      y = r.top + 6;
      if (y < 40 || y > window.innerHeight - 40) {
        x = window.innerWidth / 2;
        y = window.innerHeight - 110;
      }
    } else {
      x = window.innerWidth / 2;
      y = window.innerHeight - 110;
    }
    node.style.left = Math.max(60, Math.min(window.innerWidth - 60, x)) + "px";
    node.style.top = Math.max(30, y) + "px";
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 1700);
  }

  let timeOnlyBank = 0; // XP от тикающего таймера копим, чтобы не мигать каждые 4 минуты

  function floatsFor(prev, model) {
    const gained = model.total - prev.total;
    if (gained <= 0) return;
    const diffs = PART_KEYS.map((k) => [k, model.parts[k] - prev.parts[k]]).filter(([, v]) => v > 0);
    const byUser = Date.now() - lastPointer.t < 1600;
    const onlyTime = diffs.length > 0 && diffs.every(([k]) => k === "time");

    if (onlyTime && !byUser) {
      timeOnlyBank += gained;
      if (timeOnlyBank < 5) return;
      const amount = timeOnlyBank;
      timeOnlyBank = 0;
      spawnFloat(amount, "время", model.tier);
      return;
    }
    timeOnlyBank = 0;
    diffs.sort((a, b) => b[1] - a[1]);
    const label = diffs.slice(0, 2).map(([k]) => PART_LABEL[k]).join(" + ");
    spawnFloat(gained, label, model.tier);
  }

  /* ═════════════ праздник: окно нового уровня ═════════════ */

  let overlay = null;
  let overlayOpen = false;
  const queue = [];

  function closeOverlay() {
    if (!overlay) return;
    const el = overlay;
    overlay = null;
    el.classList.remove("show");
    setTimeout(() => {
      el.remove();
      overlayOpen = false;
      if (queue.length) showOverlay(queue.shift());
    }, 380);
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) {
    if (e.key === "Escape") closeOverlay();
  }

  function confetti(canvas, tier) {
    if (reduceMotion || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const W = (canvas.width = window.innerWidth * dpr);
    const H = (canvas.height = window.innerHeight * dpr);
    const colors = [tier.a, tier.b, tier.c || tier.b, "#ffffff", "#ffd86b"];
    const parts = Array.from({ length: 120 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.15,
      y: H * 0.38,
      vx: (Math.random() - 0.5) * 16 * dpr,
      vy: (-Math.random() * 15 - 6) * dpr,
      g: (0.32 + Math.random() * 0.2) * dpr,
      s: (5 + Math.random() * 7) * dpr,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0],
      life: 1,
    }));
    const started = performance.now();
    (function frame(now) {
      if (!canvas.isConnected) return;
      ctx.clearRect(0, 0, W, H);
      const t = (now - started) / 3200;
      parts.forEach((p) => {
        p.vy += p.g;
        p.vx *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.6);
        ctx.restore();
      });
      if (t < 1) requestAnimationFrame(frame);
    })(started);
  }

  function showOverlay(job) {
    if (overlayOpen) {
      queue.push(job);
      return;
    }
    overlayOpen = true;
    const { model, from, intro, rankUp } = job;
    const el = document.createElement("div");
    el.className = "lv-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    applyTier(el, model.tier);

    const gain = job.gain > 0 ? `<span class="lv-chip gain">+${fmtInt(job.gain)} XP</span>` : "";
    el.innerHTML =
      `<canvas class="lv-confetti" aria-hidden="true"></canvas>` +
      `<div class="lv-modal">` +
      `<div class="lv-rays" aria-hidden="true"></div>` +
      `<div class="lv-kicker">${intro ? "Прокачка включена" : "Новый уровень"}</div>` +
      orbHTML("xp-orb-xl") +
      `<h2 class="lv-title">${model.tier.icon} ${model.tier.name}</h2>` +
      (rankUp && !intro ? `<div class="lv-rankup">Новый ранг!</div>` : "") +
      `<p class="lv-text">${
        intro
          ? `Всё, что ты уже сделал, превратилось в <b>${fmtInt(model.total)} XP</b>. Это уровень <b>${model.level}</b>. Дальше каждая закрытая задача, минута работы, намаз и тренировка качают его.`
          : `${esc(model.tier.text)} ${esc(FLAVOR[model.level % FLAVOR.length])}`
      }</p>` +
      `<div class="lv-chips">${gain}<span class="lv-chip">всего ${fmtInt(model.total)} XP</span><span class="lv-chip">до ${model.level + 1}-го — ${fmtInt(model.toNext)}</span></div>` +
      `<button class="lv-btn" type="button">${intro ? "Погнали" : "Продолжить"}</button>` +
      `</div>`;
    document.body.appendChild(el);
    overlay = el;

    const orb = $(".xp-orb", el);
    const start = intro || from == null ? model.level : from;
    paintOrb(orb, { ...model, pct: 0 }, start);
    requestAnimationFrame(() => {
      el.classList.add("show");
      /* число уровня докручивается от старого к новому */
      if (start !== model.level && !reduceMotion) {
        let cur = start;
        const stepMs = Math.max(120, Math.min(320, 900 / Math.max(1, model.level - start)));
        const timer = setInterval(() => {
          cur++;
          $(".xp-orb-num", orb).textContent = String(cur);
          if (cur >= model.level) clearInterval(timer);
        }, stepMs);
      }
      /* дуга наполняется отдельно: число уровня в это время докручивается */
      setTimeout(() => {
        $(".xp-orb-arc", orb).style.strokeDashoffset = String(ORB_C * (1 - Math.max(0, Math.min(1, model.pct))));
      }, 350);
    });

    if (typeof play === "function" && !intro) play("achievement");
    confetti($(".lv-confetti", el), model.tier);
    $(".lv-btn", el).addEventListener("click", closeOverlay);
    el.addEventListener("click", (e) => {
      if (e.target === el) closeOverlay();
    });
    document.addEventListener("keydown", onEsc);
    setTimeout(() => {
      const btn = $(".lv-btn", el);
      if (btn) btn.focus({ preventScroll: true });
    }, 450);
  }

  /* ═════════════ главный цикл ═════════════ */

  let prev = null;
  let queued = false;

  function refresh() {
    queued = false;
    if (typeof state === "undefined" || !state) return;
    if (!mounted) mount();
    if (!mounted) return;

    const model = buildModel(computeXp());
    updateHero(model);
    updatePanel(model);
    events(model);
    prev = model;
  }

  function queueRefresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(refresh);
  }

  function events(model) {
    const today = todayKey();
    let seen = readSeen();

    /* первый запуск: приветствие и «стартовый» уровень без фейерверка */
    if (!seen) {
      seen = { level: model.level, intro: true, goalDay: model.today >= (DAILY_GOAL[modeFor(today)] || 150) ? today : null };
      writeSeen(seen);
      setTimeout(() => showOverlay({ model, intro: true }), 700);
      return;
    }

    /* новый уровень (в том числе набранный на другом устройстве) */
    if (model.level > (seen.level || 1)) {
      const from = seen.level || 1;
      const rankUp = tierFor(from) !== model.tier;
      seen.level = model.level;
      writeSeen(seen);
      const gain = prev ? model.total - prev.total : 0;
      setTimeout(() => showOverlay({ model, from, rankUp, gain }), prev ? 650 : 900);
    }

    /* цель дня */
    const goal = DAILY_GOAL[modeFor(today)] || DAILY_GOAL.norm;
    if (model.today >= goal && seen.goalDay !== today) {
      seen.goalDay = today;
      writeSeen(seen);
      if (prev && !document.hidden) {
        setTimeout(() => {
          if (typeof toast === "function") toast(`🎯 Цель дня выполнена: ${fmtInt(model.today)} XP`);
        }, 900);
      }
    }

    /* «+XP» — только если уже было с чем сравнивать и вкладка видна */
    if (prev && !document.hidden) floatsFor(prev, model);
  }

  /* ═════════════ подключение к приложению ═════════════ */

  /* app.js вызывает эти функции после каждой правки данных, оборачиваем их
     вместо правки самого app.js */
  function wrap(name) {
    if (typeof window[name] !== "function") return;
    const orig = window[name];
    window[name] = function () {
      const r = orig.apply(this, arguments);
      queueRefresh();
      return r;
    };
  }

  function boot() {
    ["renderAll", "renderHero", "renderAchievements"].forEach(wrap);
    refresh();
    /* страховка + живой счёт: пока идёт таймер, XP растёт на глазах */
    setInterval(() => {
      if (document.hidden) return;
      if (typeof runningTimers === "function" && runningTimers().length) refresh();
    }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    window.addEventListener("focus", queueRefresh);
  }

  /* стили подтягиваем сами: достаточно одной строки <script> в index.html */
  function loadCss(cb) {
    const script = document.currentScript;
    const href = script && script.src ? script.src.replace(/levels\.js(\?.*)?$/, "levels.css$1") : "levels.css";
    if (document.querySelector('link[href^="' + href.split("?")[0] + '"]')) return cb();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cb();
    };
    link.addEventListener("load", finish);
    link.addEventListener("error", finish);
    setTimeout(finish, 1200);
    document.head.appendChild(link);
  }

  loadCss(boot);
})();
