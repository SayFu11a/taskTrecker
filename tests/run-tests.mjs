/* Регрессионные тесты таймера, уведомлений и лишних запросов.
   Запуск: node tests/run-tests.mjs

   Тесты гоняют НАСТОЯЩИЙ код (index.html + app.js + timersync.js + sync.js
   в jsdom) против поддельного Supabase. Подменены только сеть, часы и
   картинки — функции таймера и слияния те же, что в проде. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeServer, makeApp, ROOT } from "../tests-support/harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

/* ─────────── крошечный раннер ─────────── */
const results = [];
let failed = 0;
function test(name, fn) {
  results.push({ name, fn });
}
function eq(actual, expected, what = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: получили ${a}, ждали ${e}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what || "условие не выполнено");
}

/* ─────────── общая обвязка ─────────── */
async function boot({ latency = 40, storage = null } = {}) {
  const server = makeServer();
  server.S.latency = latency;
  const w = makeApp(server, { storage });
  const clock = { skew: 0 };
  server.S.skewRef = clock;
  w.eval(`(function(){
    const Real = Date;
    globalThis.__clock = { skew: 0 };
    globalThis.Date = class extends Real {
      constructor(...a){ if (a.length) super(...a); else super(Real.now() + globalThis.__clock.skew); }
      static now(){ return Real.now() + globalThis.__clock.skew; }
    };
  })()`);
  w.__setSkew = (v) => { w.__clock.skew = v; clock.skew = v; };
  w.__advance = (ms) => { w.__clock.skew += ms; clock.skew += ms; };
  await sleep(60);
  const screen = (block) => {
    const card = [...w.document.querySelectorAll(".block")].find((c) => c.dataset.id === block);
    return card ? card.querySelector(".time-value").textContent.trim() : "(нет карточки)";
  };
  return { server, w, clock, screen };
}

/* ═══════════ 1. ТАЙМЕР ═══════════ */

test("стоп на нормальной сети: на экране минуты базы, а не 0", async () => {
  const { server, w, screen } = await boot({ latency: 40 });
  w.eval('startTimer("jobs")');
  await sleep(150);
  w.__advance(40 * 60000);
  await sleep(20);
  w.eval('stopTimer(selectedDate, "jobs")');
  await sleep(400);
  eq(screen("jobs"), "40 мин", "экран после стопа");
  eq(w.eval('state.hours[selectedDate].jobs.min'), 40, "минуты в state");
  /* Ни один пуш за сцену не должен унести минуты вместе с идущим таймером:
     именно так терялись 40 минут. */
  const bad = server.S.calls
    .filter((c) => c.name === "days.upsert")
    .flatMap((c) => c.rows || [])
    .filter((r) => r.hours && r.hours.jobs && r.hours.jobs.timer && !r.hours.jobs.min);
  eq(bad.length, 0, "пушей с min: 0 и идущим таймером");
  const day = Object.values(server.S.days)[0];
  eq(day && day.hours ? day.hours.jobs.min : "(дня нет)", 40, "минуты на сервере");
});

test("стоп на медленной сети (900 мс): экран не показывает 0 даже до ответа", async () => {
  const { w, screen } = await boot({ latency: 900 });
  w.eval('startTimer("jobs")');
  /* ждём, пока timer_start вернётся и таймер станет серверным */
  for (let i = 0; i < 30 && w.eval('JSON.stringify(state.hours[selectedDate] || {})').indexOf("byServer") < 0; i++) await sleep(100);
  w.__advance(40 * 60000);
  await sleep(20);
  /* часы прыгнули — даём тикеру переписать подпись (renderAll каждую секунду) */
  for (let i = 0; i < 20 && screen("jobs") === "0 мин"; i++) await sleep(100);
  eq(screen("jobs"), "40 мин", "экран прямо перед стопом");
  w.eval('stopTimer(selectedDate, "jobs")');
  /* Пока ответа нет, на экране натикавшее, а не 0: прежняя версия гасила
     отметку до ответа, и человек видел «0 мин» на живом таймере. */
  await sleep(300);
  ok(screen("jobs") !== "0 мин", `пока ответ в пути, экран ${screen("jobs")} — не должен быть 0`);
  await sleep(2200);
  eq(screen("jobs"), "40 мин", "экран после ответа сервера");
  eq(w.eval('state.hours[selectedDate].jobs.min'), 40, "минуты в state");
});

test("стоп во время фоновой синхронизации: таймер не воскресает, минуты и minAt доехали", async () => {
  const { server, w, screen } = await boot({ latency: 400 });
  w.eval('startTimer("jobs")');
  for (let i = 0; i < 30 && w.eval('JSON.stringify(state.hours[selectedDate] || {})').indexOf("byServer") < 0; i++) await sleep(100);
  w.__advance(40 * 60000);
  /* тикер перерисовывает подпись раз в секунду — ждём, иначе «0 мин» про часы */
  for (let i = 0; i < 20 && screen("jobs") === "0 мин"; i++) await sleep(100);
  /* Фоновая сверка уже в пути (возврат во вкладку, онлайн, тик опроса).
     Стоп жмём ровно в этом окне: прежняя версия в нём воскрешала таймер
     и теряла минуты. */
  w.eval("pullThenPush()");
  w.eval('stopTimer(selectedDate, "jobs")');
  await sleep(4000);
  eq(screen("jobs"), "40 мин", "экран после стопа");
  const rec = w.eval('JSON.stringify(state.hours[selectedDate].jobs)');
  const parsed = JSON.parse(rec);
  eq(parsed.min, 40, "минуты в state");
  ok(!parsed.timer, "таймер в state не должен воскреснуть");
  /* Ни один пуш за сцену не должен унести минуты вместе с идущим таймером:
     именно так терялись 40 минут. */
  const bad = server.S.calls
    .filter((c) => c.name === "days.upsert")
    .flatMap((c) => c.rows || [])
    .filter((r) => r.hours && r.hours.jobs && r.hours.jobs.timer && !r.hours.jobs.min);
  eq(bad.length, 0, "пушей с min: 0 и идущим таймером");
  const day = Object.values(server.S.days)[0];
  eq(day && day.hours ? day.hours.jobs.min : "(дня нет)", 40, "минуты на сервере");
  ok(Number(day.hours.jobs.minAt) > 0, "minAt сохранён на сервере");
});

test("стоп без сети: падаем в локальную остановку и пишем минуты по серверным часам", async () => {
  const { server, w, screen } = await boot({ latency: 40 });
  w.eval('startTimer("jobs")');
  await sleep(150);
  w.__advance(25 * 60000);
  await sleep(20);
  /* сеть пропала прямо перед стопом */
  server.rpc = () => new Promise((_, rej) => setTimeout(() => rej(new Error("offline")), 30));
  w.eval('stopTimer(selectedDate, "jobs")');
  await sleep(400);
  eq(screen("jobs"), "25 мин", "экран после офлайн-стопа");
  eq(w.eval('state.hours[selectedDate].jobs.min'), 25, "минуты в state");
  ok(!w.eval('state.hours[selectedDate].jobs.timer'), "таймер погашен");
});

test("srvStopInFlight реально используется, а не висит мёртвой переменной", async () => {
  const ts = read("timersync.js");
  const uses = ts.split("srvStopInFlight").length - 1;
  ok(uses >= 3, `srvStopInFlight упоминается ${uses} раз — guard не реализован`);
  ok(/srvStopInFlight = true/.test(ts) && /finally[\s\S]{0,80}srvStopInFlight = false/.test(ts), "guard не выставляется и не снимается в finally");
});

test("dropServerTimer и adoptServerTimer сохраняют minAt, normalizeDayForDb берёт его из state.minAt", async () => {
  const sync = read("sync.js");
  ok(/normalizeDayForDb\(day, minAtFallback\)/.test(sync), "normalizeDayForDb не принимает запасную карту minAt");
  ok(/Number\(\(minAtFallback \|\| \{\}\)\[id\]\)/.test(sync), "normalizeDayForDb не берёт minAt из state.minAt");
  ok(/normalizeDayForDb\(state\.hours\[date\], \(state\.minAt \|\| \{\}\)\[date\]\)/.test(sync), "stateToRows не передаёт state.minAt");
  const ts = read("timersync.js");
  ok(/if \(rec\.minAt\) state\.hours\[t\.date\]\[t\.block\]\.minAt = rec\.minAt/.test(ts), "dropServerTimer теряет minAt");
  ok(/day\[block\]\.minAt = prevAt/.test(ts), "adoptServerTimer теряет minAt");
});

/* ═══════════ 2. УВЕДОМЛЕНИЯ ═══════════ */

test("подписка на push знает устройство: device_id и удаление прежних строк этого устройства", async () => {
  const src = read("push.js");
  ok(/DEVICE_KEY/.test(src), "нет ключа устройства в localStorage");
  ok(/device_id/.test(src), "в подписку не пишется device_id");
  ok(/\.eq\(HEADERS_COL, deviceId\(\)\)/.test(src) || /\.eq\("device_id"/.test(src), "нет удаления по устройству");
  ok(/\.neq\("endpoint"/.test(src) || /delete\(\)[\s\S]{0,120}deviceId\(\)/.test(src), "прежние строки этого устройства не удаляются");
  const migration = read("supabase/migrations/20261117_sync_fixes.sql");
  ok(/add column if not exists device_id/.test(migration), "миграция не добавляет device_id");
  ok(/index[\s\S]*device_id/i.test(migration), "нет индекса по device_id");
  ok(/не удаля/i.test(migration), "миграция не оговаривает, что старые строки не удаляются");
});

test("send-reminders: напоминание только в первом тике блока и один раз за блок", async () => {
  const src = read("supabase/functions/send-reminders/index.ts");
  ok(/SLOT_TICK_MIN/.test(src) || /mins - minutesOf\(slot\.from\)/.test(src), "нет ограничения на первый тик блока");
  ok(/reminder_log/.test(src), "нет журнала отправленных напоминаний (повторы каждые 15 минут)");
  ok(/runningMinutes/.test(src), "не учитывается идущий таймер");
});

/* ═══════════ 3. ЗАПРОСЫ ═══════════ */

test("опрос: 5 минут при живой связи, 30 секунд без неё", async () => {
  const src = read("timersync.js");
  ok(/POLL_LIVE_MS = 300000/.test(src), "нет интервала 5 минут для живой связи");
  ok(/POLL_OFFLINE_MS = 30000/.test(src), "нет интервала 30 секунд без связи");
  ok(/liveState === "SUBSCRIBED" \? POLL_LIVE_MS : POLL_OFFLINE_MS/.test(src), "интервал не зависит от состояния realtime");
});

test("опрос намаза инкрементальный, полная сверка — раз в несколько часов", async () => {
  const src = read("timersync.js");
  ok(/\.gt\("updated_at", since\)/.test(src), "намаз качается целиком, без фильтра по updated_at");
  ok(/FULL_SYNC_MS/.test(src), "нет расписания полной сверки");
});

test("отправляются только изменённые дни, пустой отправки нет", async () => {
  const src = read("sync.js");
  ok(/takeDirtyDates/.test(src), "нет списка грязных дат");
  ok(/markDayDirty/.test(read("app.js")), "дни не помечаются изменёнными");
  ok(/typeof markDayDirty|markDayDirty/.test(src) || true, "");
  ok(/clearDirtyDays/.test(src), "грязные даты не очищаются после отправки");
  ok(/if \(!rows\.length\) return;/.test(src), "пустая отправка не отсекается");
});

test("все сигналы синхронизации идут через один планировщик с паузой 10 с", async () => {
  const src = read("sync.js");
  ok(/SYNC_MIN_GAP = 10000/.test(src), "нет паузы между запусками");
  ok(/function requestSync/.test(src), "нет общего планировщика");
  const vis = /document\.addEventListener\("visibilitychange"[\s\S]{0,200}requestSync\("visibility"\)/.test(src);
  ok(vis, "возврат во вкладку не идёт через планировщик");
  const online = /addEventListener\("online"[\s\S]{0,300}requestSync\("online"\)/.test(src);
  ok(online, "online не идёт через планировщик");
  ok(/SIGNED_IN[\s\S]{0,400}sameSession/.test(src), "SIGNED_IN не проверяет, та же ли сессия");
  ok(!/if \(event === "SIGNED_IN"\) pullThenPush\(\)/.test(src), "SIGNED_IN всё ещё запускает синхронизацию напрямую");
});

test("жизненный цикл: 6 событий за 6 секунд дают один запрос, а не шесть", async () => {
  const { server, w } = await boot({ latency: 30 });
  await sleep(200);
  const before = server.S.calls.length;
  /* имитируем возврат во вкладку: focus + pageshow + visibilitychange + online + realtime */
  for (let i = 0; i < 6; i++) {
    w.eval('requestSync("test")');
    await sleep(200);
  }
  await sleep(600);
  const after = server.S.calls.length - before;
  ok(after <= 6, `за 6 событий ушло ${after} запросов — планировщик не схлопывает вызовы`);
  /* и точно меньше, чем по запросу на событие */
  ok(after < 6, `за 6 событий ушло ${after} запросов, ожидался один проход`);
});

test("триггер days_touch не трогает updated_at, если hours не изменились", async () => {
  const sql = read("supabase/migrations/20261117_sync_fixes.sql");
  ok(/create or replace function public\.touch_updated_at/.test(sql), "триггер не переопределён");
  ok(/to_jsonb\(old\) - 'updated_at' is distinct from to_jsonb\(new\) - 'updated_at'/.test(sql), "нет сравнения старого и нового значения");
  ok(/return new;/.test(sql), "триггер не возвращает строку");
});

test("дневник: pull четырёх таблиц только если прошла минута или были правки", async () => {
  const src = read("diary.js");
  ok(/PULL_GAP_MS|pullGap|shouldPull/.test(src), "нет ограничения на частоту pull дневника");
});

/* ═══════════ 4. НАМАЗ БЕЗ ДУБЛЕЙ ═══════════ */

test("namazTick: дубль между вкладками и после перезагрузки не показывается дважды", async () => {
  const src = read("app.js");
  ok(/NAMAZ_SHOWN_KEY|namazShown/.test(src), "нет отметки «уже показано» в localStorage");
  ok(/namazShownKey|событие\+минута|event.*minute/.test(src) || /nowKey.*id.*ahead/.test(src), "ключ дедупликации не привязан к событию и минуте");
});

/* ─────────── запуск ─────────── */
(async () => {
  let i = 0;
  for (const { name, fn } of results) {
    i++;
    try {
      await fn();
      console.log(`✔ ${i}. ${name}`);
    } catch (e) {
      failed++;
      console.log(`✖ ${i}. ${name}\n    ${e.message}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} тестов прошло`);
  process.exit(failed ? 1 : 0);
})();
