/* Достижения: считаются из уже сохранённых данных, отдельного учёта нет.
   Разблокировка запоминается в state.achievements, чтобы звук и тост
   срабатывали один раз, а не при каждом рендере. */

/* Сводка прогресса для проверки условий. */
function achievementProgress() {
  const dayKeys = Object.keys(state.days || {}).filter(
    (k) => state.days[k] && Object.keys(state.days[k]).length
  );

  const LEVEL_ORDER = { min: 1, norm: 2, max: 3 };

  let fullNormDays = 0;
  let minDays = 0;
  let maxBlocksInDay = 0;
  let blockInterviews = 0;
  let blockJobs = 0;

  dayKeys.forEach((key) => {
    const data = state.days[key];
    const levels = Object.keys(data)
      .map((id) => LEVEL_ORDER[data[id]] || 0)
      .filter(Boolean);

    const marked = levels.length;
    maxBlocksInDay = Math.max(maxBlocksInDay, marked);

    if (marked === BLOCKS.length && levels.every((l) => l >= 2)) fullNormDays++;
    if (marked > 0 && levels.every((l) => l === 1)) minDays++;

    if (data.interviews) blockInterviews++;
    if (data.jobs) blockJobs++;
  });

  const gymDone = Object.values(state.gym || {}).reduce(
    (sum, week) => sum + Object.values(week).filter(Boolean).length,
    0
  );

  return {
    closedDays: dayKeys.length,
    fullNormDays,
    minDays,
    maxBlocksInDay,
    blockInterviews,
    blockJobs,
    gymDone,
    leetcodeCount: (state.leetcode || []).length,
    bestStreak: bestStreak(),
  };
}

/* Самая длинная серия подряд идущих закрытых дней. */
function bestStreak() {
  const keys = Object.keys(state.days || {})
    .filter((k) => state.days[k] && Object.keys(state.days[k]).length)
    .sort();

  let best = 0;
  let run = 0;
  let prev = null;

  keys.forEach((key) => {
    if (prev && shiftDay(prev, 1) === key) {
      run += 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = key;
  });

  return best;
}

/* Какие достижения уже открыты (по сохранённой отметке). */
function unlockedIds() {
  return Object.keys(state.achievements || {});
}

/* Проверка новых достижений. Возвращает список только что открытых. */
function checkAchievements() {
  if (!state.achievements) state.achievements = {};
  const progress = achievementProgress();
  const fresh = [];

  ACHIEVEMENTS.forEach((a) => {
    if (state.achievements[a.id]) return;
    let ok = false;
    try {
      ok = !!a.check(progress);
    } catch {
      ok = false;
    }
    if (ok) {
      state.achievements[a.id] = new Date().toISOString();
      fresh.push(a);
    }
  });

  if (fresh.length) save();
  return fresh;
}

/* Сначала звук, потом тост — иначе анимация накроет сообщение. */
function celebrate(list) {
  if (!list.length) return;

  if (list.length > 1) {
    play("achievement");
    setTimeout(
      () => toast(`Открыто достижений: ${list.length} — ${list.map((a) => a.title).join(", ")}`),
      120
    );
    return;
  }

  const a = list[0];
  play("achievement");
  setTimeout(() => toast(`${a.icon} ${a.title} — ${a.desc}`), 120);
}

/* Проверить и отпраздновать — одна строка для вызова из save(). */
function refreshAchievements() {
  const fresh = checkAchievements();
  if (fresh.length) {
    celebrate(fresh);
    renderAchievements();
  }
  return fresh;
}

/* ─────────── экран достижений ─────────── */

function renderAchievements() {
  const root = document.getElementById("achievements");
  if (!root) return;

  const opened = unlockedIds();
  const progress = achievementProgress();

  const counter = document.getElementById("achCount");
  if (counter) counter.textContent = `${opened.length}/${ACHIEVEMENTS.length}`;

  root.innerHTML = ACHIEVEMENTS.map((a) => {
    const isOpen = !!state.achievements && !!state.achievements[a.id];
    const when = isOpen ? new Date(state.achievements[a.id]) : null;
    return `<div class="ach-card${isOpen ? " open" : ""}">
      <div class="ach-icon">${isOpen ? a.icon : "🔒"}</div>
      <div class="ach-body">
        <div class="ach-title">${a.title}</div>
        <div class="ach-desc">${a.desc}</div>
        ${when ? `<div class="ach-date">открыто ${DATE_FMT.format(when)}</div>` : ""}
      </div>
    </div>`;
  }).join("");

  /* подсказка, сколько осталось до ближайшей цели */
  const hint = document.getElementById("achHint");
  if (hint && opened.length < ACHIEVEMENTS.length) {
    const next = ACHIEVEMENTS.filter((a) => !state.achievements[a.id])[0];
    hint.textContent = `Ближайшая цель: ${next.icon} ${next.title} — ${next.desc}`;
  } else if (hint) {
    hint.textContent = "Все достижения открыты. Это уже не трекер, а образ жизни.";
  }

  /* статистика под сеткой */
  const stats = document.getElementById("achStats");
  if (stats) {
    stats.innerHTML = `
      <div class="stat"><div class="stat-val">${progress.closedDays}</div><div class="stat-label">дней закрыто</div></div>
      <div class="stat"><div class="stat-val">${progress.bestStreak}</div><div class="stat-label">лучшая серия</div></div>
      <div class="stat"><div class="stat-val">${progress.gymDone}</div><div class="stat-label">тренировок</div></div>
      <div class="stat"><div class="stat-val">${progress.leetcodeCount}</div><div class="stat-label">задач в журнале</div></div>`;
  }
}
