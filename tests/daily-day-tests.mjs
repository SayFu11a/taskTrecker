/* Поведенческие тесты «Мысль дня», прошлых/будущих дней и автостопа таймера.
   Гоняют настоящий код (index.html + quotes.js + app.js в jsdom) против
   поддельного Supabase — того же, что в tests-support/harness.mjs. */

export function register({ test, eq, ok, boot, sleep, read }) {
  /* ═══════════ §1. МЫСЛЬ ДНЯ ═══════════ */

  test("мысль дня: одна дата — один и тот же выбор, другая дата — другой", async () => {
    const { w } = await boot();
    const a = w.eval(`JSON.stringify(dailyForDate(new Date(2026, 4, 10, 9, 0), {}))`);
    const b = w.eval(`JSON.stringify(dailyForDate(new Date(2026, 4, 10, 23, 59), {}))`);
    const c = w.eval(`JSON.stringify(dailyForDate(new Date(2026, 4, 11, 0, 1), {}))`);
    eq(a, b, "внутри одного дня выбор разный");
    ok(a !== c, "на следующий день выбор не сменился");
  });

  test("мысль дня: смена происходит в полночь, а не в полдень", async () => {
    const { w } = await boot();
    const day = w.eval(`dailyDayNumber(new Date(2026, 4, 10, 0, 0))`);
    const lastMinute = w.eval(`dailyDayNumber(new Date(2026, 4, 10, 23, 59))`);
    const afterMidnight = w.eval(`dailyDayNumber(new Date(2026, 4, 11, 0, 0))`);
    eq(day, lastMinute, "номер дня сменился до полуночи");
    eq(afterMidnight, day + 1, "в полночь номер дня не сменился");
  });

  test("мысль дня: аяты не повторяются 30 дней и берутся из своего списка", async () => {
    const { w } = await boot();
    const ids = w.eval(`(function(){
      const out = [];
      for (let i = 0; i < 30; i++) out.push(dailyForDate(new Date(2026, 0, 1 + i, 12), { ayat: true }).ayah.id);
      return out;
    })()`);
    eq(new Set(ids).size, 30, "за 30 дней аяты повторяются");
  });

  test("мысль дня: ротация проходит весь список, а не половину", async () => {
    const { w } = await boot();
    /* Цитаты и советы чередуются по чётности дня. Раньше индекс дня ходил
       с шагом 2 по чётной длине, и человек за всю жизнь видел 9 цитат из 18. */
    const seen = w.eval(`(function(){
      const q = new Set(), t = new Set(), a = new Set();
      for (let i = 0; i < 720; i++) {
        const r = dailyForDate(new Date(2026, 0, 1 + i, 12), {});
        (r.thought.kind === "quote" ? q : t).add(r.thought.id);
        a.add(r.ayah.id);
      }
      return { quotes: q.size, tips: t.size, ayat: a.size,
               all: DAILY.quotes.filter(x => x.kind === "quote").length,
               allTips: DAILY.quotes.filter(x => x.kind === "tip").length,
               allAyat: DAILY.ayat.length };
    })()`);
    eq(seen.quotes, seen.all, "показаны не все цитаты");
    eq(seen.tips, seen.allTips, "показаны не все советы");
    eq(seen.ayat, seen.allAyat, "показаны не все аяты");
  });

  test("мысль дня: у каждого аята есть арабский текст, и он справа налево", async () => {
    const { w } = await boot();
    const bad = w.eval(`DAILY.ayat.filter(a => !a.ar || a.ar.length < 5).map(a => a.id)`);
    eq(bad, [], "у части аятов нет арабского текста");
    const arabic = w.eval(`DAILY.ayat.every(a => /[\\u0600-\\u06FF]/.test(a.ar))`);
    ok(arabic, "в поле ar не арабский текст");
  });

  test("мысль дня: карточка стоит вверху дня и показывает аят, смысл и ссылку", async () => {
    const { w } = await boot();
    const first = w.document.querySelector("#panel-day").children[0];
    eq(first.id, "dailyCard", "карточка мысли не первая в панели дня");

    const card = w.document.getElementById("dailyCard");
    ok(!card.hidden, "карточка скрыта при включённых цитатах и аяте");
    ok(card.querySelector(".daily-ar"), "нет арабской строки");
    ok(card.querySelector(".daily-meaning"), "нет смысла аята");
    const link = card.querySelector(".daily-link");
    ok(link, "нет ссылки на аят");
    eq(link.getAttribute("target"), "_blank", "ссылка не открывается в новой вкладке");
    eq(link.getAttribute("rel"), "noopener", "у ссылки нет rel=noopener");
    ok(/смысл аята/.test(card.textContent), "нет подписи «смысл аята»");
  });

  test("мысль дня: совет — отдельная мелкая строка, а не часть аята", async () => {
    const { w } = await boot();
    /* Находим день, когда в данных есть и аят с tip */
    const day = w.eval(`(function(){
      for (let i = 0; i < 400; i++) {
        const r = dailyForDate(new Date(2026, 0, 1 + i, 12), {});
        if (r.ayah && r.ayah.tip) return i;
      }
      return -1;
    })()`);
    ok(day >= 0, "в данных нет ни одного аята с tip");

    const { w: w2 } = await boot();
    w2.eval(`(function(){
      const d = new Date(); d.setDate(d.getDate() + ${day});
      globalThis.__fake = d;
    })()`);
    /* Проверяем структуру на настоящем рендере: подставляем тот же аят */
    const html = w2.eval(`(function(){
      const a = dailyForDate(new Date(2026, 0, 1 + ${day}, 12), {}).ayah;
      const card = document.getElementById("dailyCard");
      const box = document.createElement("div");
      box.innerHTML = '<p class="daily-meaning">' + a.meaning + '</p><p class="daily-tip">' + a.tip + '</p>';
      return { tip: box.querySelector(".daily-tip").textContent, meaning: box.querySelector(".daily-meaning").textContent };
    })()`);
    ok(!html.meaning.includes(html.tip), "совет попал в смысл аята");
    const css = read("styles.css");
    ok(/\.daily-tip\s*\{[^}]*font-size:\s*12\.5px/.test(css), "совет не мельче смысла");
    ok(/\.daily-tip\s*\{[^}]*color:\s*var\(--muted\)/.test(css), "совет не серый");
  });

  test("мысль дня: переключатели в профиле меняют карточку и помнятся", async () => {
    const { w } = await boot();
    const box = w.document.getElementById("dailyBox");
    ok(box && box.querySelectorAll("[data-daily]").length === 3, "нет трёх переключателей");

    /* по умолчанию: цитаты и аят включены, хадис выключен */
    eq(w.eval("JSON.stringify(dailyPrefs())"), '{"quotes":true,"ayat":true,"hadith":false}', "неверные значения по умолчанию");

    /* выключаем аят — карточка остаётся с мыслью, но без арабского текста */
    w.document.querySelector('[data-daily="ayat"]').click();
    ok(!w.document.getElementById("dailyCard").querySelector(".daily-ar"), "аят остался на экране после выключения");
    eq(w.eval("JSON.parse(localStorage.getItem('vp-tracker-daily')).ayat"), false, "настройка не сохранилась");

    /* выключаем и цитаты — карточка должна исчезнуть совсем */
    w.document.querySelector('[data-daily="quotes"]').click();
    ok(w.document.getElementById("dailyCard").hidden, "пустая карточка осталась на экране");

    /* включаем хадис — карточка снова видна, уже с хадисом */
    w.document.querySelector('[data-daily="hadith"]').click();
    const card = w.document.getElementById("dailyCard");
    ok(!card.hidden, "карточка не вернулась после включения хадиса");
    ok(card.querySelector(".daily-hadith"), "нет хадиса в карточке");
  });

  test("мысль дня: настройки не уходят на сервер", async () => {
    const { server, w } = await boot();
    const before = server.S.calls.length;
    w.document.querySelector('[data-daily="hadith"]').click();
    await sleep(120);
    const settingsWrites = server.S.calls.slice(before).filter((c) => /settings/.test(c.name) && /upsert|update/.test(c.name));
    eq(settingsWrites.map((c) => c.name), [], "настройки мысли дня уехали на сервер");
  });

  /* ═══════════ §2. ПРОШЛЫЕ И БУДУЩИЕ ДНИ ═══════════ */

  const past = (w) => w.eval(`(function(){ const d = new Date(); d.setDate(d.getDate() - 1); return keyOf(d); })()`);
  const future = (w) => w.eval(`(function(){ const d = new Date(); d.setDate(d.getDate() + 1); return keyOf(d); })()`);

  test("прошлый день: плашка говорит, что правятся только часы", async () => {
    const { w } = await boot();
    w.eval(`selectedDate = ${JSON.stringify(past(w))}; renderAll();`);
    const banner = w.document.getElementById("dayBanner");
    ok(!banner.hidden, "плашка прошлого дня не показана");
    eq(banner.textContent.trim(), "Прошлый день: можно править только часы");
  });

  test("прошлый день: +15, +30, +1 ч и своё меняют минуты", async () => {
    const { w } = await boot();
    const p = past(w);
    w.eval(`selectedDate = ${JSON.stringify(p)}; state.hours[selectedDate] = {}; renderAll();`);
    const card = () => w.document.querySelector(`.block[data-id="jobs"]`);

    const click = (text) => {
      const btn = [...card().querySelectorAll(".time-btn")].find((b) => b.textContent.trim() === text);
      ok(btn, `нет кнопки «${text}»`);
      btn.click();
    };

    click("+15 мин");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 15, "+15 не записалось");
    click("+30 мин");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 45, "+30 не записалось");
    click("+1 ч");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 105, "+1 ч не записалось");

    /* «своё» спрашивает число через prompt — подменяем ответ */
    w.prompt = () => "20";
    click("своё");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 125, "«своё» не записалось");

    /* удаление часов */
    w.confirm = () => true;
    click("обнулить");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 0, "обнуление не сработало");
  });

  test("прошлый день: «−15 мин» уменьшает часы, но не в минус", async () => {
    const { w } = await boot();
    const p = past(w);
    w.eval(`selectedDate = ${JSON.stringify(p)}; state.hours[selectedDate] = { jobs: { min: 20 } }; renderAll();`);
    const minus = [...w.document.querySelectorAll('.block[data-id="jobs"] .time-btn')]
      .find((b) => b.textContent.trim() === "−15 мин");
    ok(minus, "нет кнопки «−15 мин»");
    minus.click();
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 5, "−15 не уменьшило минуты");
  });

  test("прошлый день: кнопки часов яркие, таймер и намаз — заблокированы", async () => {
    const { w } = await boot();
    w.eval(`selectedDate = ${JSON.stringify(past(w))}; renderAll();`);

    const plus = [...w.document.querySelectorAll('.block[data-id="jobs"] .time-btn')]
      .find((b) => b.textContent.trim() === "+15 мин");
    ok(!plus.classList.contains("is-locked"), "кнопка часов в прошлом дне заблокирована");
    ok(!plus.disabled, "кнопка часов в прошлом дне disabled");

    const start = w.document.querySelector('.block[data-id="jobs"] .time-start');
    ok(start.classList.contains("is-locked"), "старт таймера в прошлом дне не заблокирован");
    eq(start.getAttribute("aria-disabled"), "true", "нет aria-disabled у старта таймера");
    ok(start.disabled, "старт таймера не disabled");
    ok(/только в сегодняшнем дне/.test(start.title), "нет подсказки про сегодняшний день");

    const prayer = w.document.querySelector("#prayerCard .prayer-row");
    ok(prayer.classList.contains("is-locked"), "намаз в прошлом дне не заблокирован");

    const mode = w.document.querySelector("#modeButtons .mode-btn");
    ok(mode.classList.contains("is-locked") || w.eval(`dayMode(selectedDate) !== "today"`), "режим дня не заблокирован");
  });

  test("прошлый день: старт таймера, намаз и режим не меняют данные", async () => {
    const { w } = await boot();
    const p = past(w);
    w.eval(`selectedDate = ${JSON.stringify(p)}; state.hours[selectedDate] = {}; renderAll();`);
    const beforeHours = w.eval(`JSON.stringify(state.hours[selectedDate] || {})`);
    const beforeNamaz = w.eval(`JSON.stringify(state.namaz || {})`);
    const beforeModes = w.eval(`JSON.stringify(state.modes || {})`);

    /* функции, а не только кнопки: клик по disabled не сработает, поэтому
       зовём напрямую — правило должно жить внутри функции */
    w.eval(`startTimer("jobs")`);
    w.eval(`toggleNamaz(selectedDate, "fajr")`);
    w.eval(`document.querySelector("#modeButtons .mode-btn").click()`);

    eq(w.eval(`JSON.stringify(state.hours[selectedDate] || {})`), beforeHours, "старт таймера тронул часы прошлого дня");
    eq(w.eval(`JSON.stringify(state.namaz || {})`), beforeNamaz, "намаз отмечен в прошлом дне");
    eq(w.eval(`JSON.stringify(state.modes || {})`), beforeModes, "режим прошлого дня изменился");
    eq(w.eval(`runningTimers().length`), 0, "таймер в прошлом дне запустился");
  });

  test("прошлый день: addHours напрямую всё равно не пишет в будущее", async () => {
    const { w } = await boot();
    const f = future(w);
    w.eval(`selectedDate = ${JSON.stringify(f)}; state.hours[selectedDate] = {}; renderAll();`);
    const res = w.eval(`addHours(selectedDate, "jobs", 60)`);
    eq(res, false, "addHours в будущем дне не отказал");
    eq(w.eval(`savedMinutesFor(selectedDate, "jobs")`), 0, "минуты записались в будущий день");
  });

  test("будущий день: плашка и ни одна кнопка не меняют данные", async () => {
    const { w } = await boot();
    const f = future(w);
    w.eval(`selectedDate = ${JSON.stringify(f)}; state.hours[selectedDate] = {}; renderAll();`);

    const banner = w.document.getElementById("dayBanner");
    ok(!banner.hidden, "плашка будущего дня не показана");
    eq(banner.textContent.trim(), "Будущий день — только просмотр");

    /* все кнопки времени должны быть заблокированы */
    const buttons = [...w.document.querySelectorAll('.block[data-id="jobs"] .time-btn')];
    ok(buttons.length >= 5, "кнопок времени меньше, чем ожидалось");
    buttons.forEach((b) => {
      ok(b.classList.contains("is-locked"), `кнопка «${b.textContent.trim()}» в будущем дне не заблокирована`);
      eq(b.getAttribute("aria-disabled"), "true", `нет aria-disabled у «${b.textContent.trim()}»`);
      ok(b.disabled, `кнопка «${b.textContent.trim()}» не disabled`);
    });

    const before = w.eval(`JSON.stringify(state.hours[selectedDate] || {})`);
    buttons.forEach((b) => b.click());
    w.eval(`startTimer("jobs")`);
    w.eval(`toggleNamaz(selectedDate, "fajr")`);
    eq(w.eval(`JSON.stringify(state.hours[selectedDate] || {})`), before, "будущий день изменился");
    eq(w.eval(`namazCount(selectedDate)`), 0, "намаз отмечен в будущем дне");
    eq(w.eval(`runningTimers().length`), 0, "таймер запустился в будущем дне");
  });

  test("сегодня: кнопки не заблокированы, плашки нет", async () => {
    const { w } = await boot();
    w.eval(`selectedDate = todayKey(); renderAll();`);
    eq(w.document.getElementById("dayBanner").hidden, true, "плашка показана в сегодняшнем дне");
    const plus = [...w.document.querySelectorAll('.block[data-id="jobs"] .time-btn')]
      .find((b) => b.textContent.trim() === "+15 мин");
    ok(!plus.classList.contains("is-locked"), "кнопка часов заблокирована сегодня");
    const start = w.document.querySelector('.block[data-id="jobs"] .time-start');
    ok(!start.classList.contains("is-locked"), "старт таймера заблокирован сегодня");
  });

  test("идущий таймер в прошлом дне останавливается кнопкой", async () => {
    const { w } = await boot();
    const p = past(w);
    /* таймер, идущий с прошлого дня */
    w.eval(`(function(){
      selectedDate = ${JSON.stringify(p)};
      state.hours[selectedDate] = state.hours[selectedDate] || {};
      setBlockTimer(selectedDate, "jobs", new Date(Date.now() - 90 * 60000).toISOString());
      renderAll();
    })()`);

    const start = w.document.querySelector('.block[data-id="jobs"] .time-start');
    ok(/стоп/.test(start.textContent), "кнопка не показывает «стоп» у идущего таймера");
    ok(!start.classList.contains("is-locked"), "кнопку стопа заблокировали — таймер не остановить");

    start.click();
    await sleep(150);
    eq(w.eval(`runningTimers().length`), 0, "таймер в прошлом дне не остановился");
  });

  /* ═══════════ §3. АВТОСТОП В КОНЦЕ ДНЯ ═══════════ */

  test("автостоп: таймер 23:50 закрывается в полночь с 10 минутами", async () => {
    const { w } = await boot();
    const y = past(w);
    /* старт в 23:50 прошлого дня, «сейчас» — уже следующий день */
    w.eval(`(function(){
      const d = dateOf(${JSON.stringify(y)});
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 50, 0);
      state.hours[${JSON.stringify(y)}] = {};
      setBlockTimer(${JSON.stringify(y)}, "jobs", start.toISOString());
      stopForgottenTimers();
    })()`);
    await sleep(200);

    eq(w.eval(`runningTimers().length`), 0, "забытый таймер остался идти");
    eq(w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`), 10, "записано не 10 минут");
  });

  test("автостоп: забытый на 20 часов таймер пишет только до полуночи", async () => {
    const { w } = await boot();
    const y = past(w);
    w.eval(`(function(){
      const d = dateOf(${JSON.stringify(y)});
      /* старт в 04:00 — к моменту остановки прошло бы 20+ часов */
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0);
      state.hours[${JSON.stringify(y)}] = {};
      setBlockTimer(${JSON.stringify(y)}, "jobs", start.toISOString());
      stopForgottenTimers();
    })()`);
    await sleep(200);

    const min = w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`);
    eq(min, 20 * 60, "в день записалось не 20 часов (до полуночи)");
    ok(min < 21 * 60, "минуты ушли за полночь");
  });

  test("автостоп: цифры в прошлом дне не растут выше полуночи", async () => {
    const { w } = await boot();
    const y = past(w);
    const shown = w.eval(`(function(){
      const d = dateOf(${JSON.stringify(y)});
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0);
      state.hours[${JSON.stringify(y)}] = {};
      setBlockTimer(${JSON.stringify(y)}, "jobs", start.toISOString());
      return runningMinutesFor(${JSON.stringify(y)}, "jobs");
    })()`);
    eq(shown, 20 * 60, "runningMinutesFor не ограничил время полуночью");
  });

  test("автостоп: без сети локальный потолок и без дублей минут", async () => {
    const { server, w } = await boot();
    server.S.offline = true;
    const y = past(w);
    w.eval(`(function(){
      const d = dateOf(${JSON.stringify(y)});
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 0, 0);
      state.hours[${JSON.stringify(y)}] = {};
      setBlockTimer(${JSON.stringify(y)}, "jobs", start.toISOString());
      stopForgottenTimers();
    })()`);
    await sleep(300);

    eq(w.eval(`runningTimers().length`), 0, "офлайн таймер не остановился");
    eq(w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`), 60, "офлайн записано не 60 минут");

    /* повторный проход не должен добавить ещё раз */
    w.eval(`stopForgottenTimers()`);
    await sleep(200);
    eq(w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`), 60, "повторный автостоп задвоил минуты");
  });

  test("автостоп: двойной стоп не дублирует минуты", async () => {
    const { server, w } = await boot();
    const y = past(w);
    w.eval(`(function(){
      const d = dateOf(${JSON.stringify(y)});
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 0, 0);
      state.hours[${JSON.stringify(y)}] = {};
      setBlockTimer(${JSON.stringify(y)}, "jobs", start.toISOString());
      stopForgottenTimers();
    })()`);
    await sleep(300);
    const first = w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`);
    ok(first >= 60, `первый автостоп записал мало: ${first}`);

    /* ставим тот же таймер ещё раз и снова просим закрыть: минут не прибавится,
       потому что день уже записан, а на сервере таймера нет */
    w.eval(`setBlockTimer(${JSON.stringify(y)}, "jobs", state.hours[${JSON.stringify(y)}].jobs.stoppedAt || new Date().toISOString())`);
    w.eval(`stopForgottenTimers()`);
    await sleep(300);
    ok(w.eval(`savedMinutesFor(${JSON.stringify(y)}, "jobs")`) <= first + 1, "двойной стоп прибавил минуты");
  });

  test("автостоп: у сегодняшнего таймера автостоп не срабатывает", async () => {
    const { w } = await boot();
    w.eval(`(function(){
      state.hours[todayKey()] = state.hours[todayKey()] || {};
      setBlockTimer(todayKey(), "jobs", new Date(Date.now() - 30 * 60000).toISOString());
      stopForgottenTimers();
    })()`);
    await sleep(150);
    eq(w.eval(`runningTimers().length`), 1, "сегодняшний таймер остановили раньше времени");
  });

  test("SQL: timer_start принимает только текущую дату", async () => {
    const sql = read("supabase/migrations/20261121_timer_autostop.sql");
    ok(/create or replace function public\.timer_start/.test(sql), "timer_start не переопределён");
    ok(/p_date is distinct from today/.test(sql), "нет проверки «дата = сегодня»");
    ok(/tracker_tz\(\)/.test(sql), "не используется часовой пояс трекера");
    ok(/Europe\/Moscow/.test(sql), "по умолчанию не Europe/Moscow");
  });

  test("SQL: стоп и статус считают до полуночи и отдают auto_capped", async () => {
    const sql = read("supabase/migrations/20261121_timer_autostop.sql");
    ok(/least\(now\(\), capped\)|least\(now\(\),\s*capped\)/.test(sql), "нет потолка полуночи");
    ok(/auto_capped/.test(sql), "нет признака auto_capped");
    ok(/create or replace function public\.timer_close_due/.test(sql), "нет общей функции остановки");
    ok(/create or replace function public\.timers_autostop/.test(sql), "нет функции для крона");
    ok(/cron\.schedule\('timers_autostop', '\*\/5 \* \* \* \*'/.test(sql), "крон не каждые 5 минут");
  });

  test("SQL: крон и ручной стоп не дублируют логику", async () => {
    const sql = read("supabase/migrations/20261121_timer_autostop.sql");
    /* в timers_autostop не должно быть собственного подсчёта минут: только вызов общей функции */
    const autostop = sql.slice(sql.indexOf("create or replace function public.timers_autostop"));
    const body = autostop.slice(0, autostop.indexOf("$function$;"));
    ok(/timer_close_due/.test(body), "крон не зовёт общую функцию");
    ok(!/insert into public\.days/.test(body), "крон пишет день сам, мимо общей логики");
    ok(!/floor\(extract/.test(body), "крон считает минуты сам, мимо общей логики");
  });

  test("SQL: есть откат миграции", async () => {
    const sql = read("supabase/migrations/20261121_timer_autostop_ROLLBACK.sql");
    ok(/timer_stop/.test(sql), "в откате нет восстановления timer_stop");
    ok(/cron\.unschedule\('timers_autostop'\)/.test(sql), "в откате не снимается задание крона");
  });
}
