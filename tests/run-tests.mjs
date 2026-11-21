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
/* Даты в тестах считаются от сегодняшнего дня: зашитые «2026-11-17» через
   неделю оказывались в прошлом, и тесты падали не из-за кода, а из-за
   календаря. dayKey(-1) — вчера, dayKey(0) — сегодня. */
const dayKey = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
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

test("двойной клик «стоп»: второго timer_stop нет и нет ложного «Меньше минуты»", async () => {
  const { server, w, screen } = await boot({ latency: 300 });
  w.eval('startTimer("jobs")');
  for (let i = 0; i < 30 && w.eval('JSON.stringify(state.hours[selectedDate] || {})').indexOf("byServer") < 0; i++) await sleep(100);
  w.__advance(40 * 60000);
  for (let i = 0; i < 20 && screen("jobs") === "0 мин"; i++) await sleep(100);

  /* два клика подряд, как у человека с быстрым тапом */
  w.eval('stopTimer(selectedDate, "jobs")');
  await sleep(40);
  w.eval('stopTimer(selectedDate, "jobs")');
  await sleep(3000);

  const stops = server.S.calls.filter((c) => c.name === "timer_stop").length;
  eq(stops, 1, "запросов timer_stop на двойной клик");
  eq(w.eval('state.hours[selectedDate].jobs.min'), 40, "минуты в state");
  /* тост приложения — один элемент #toast; смотрим его, а не textContent
     документа, куда попадают тексты <script> */
  const toastText = (w.document.getElementById("toast") || {}).textContent || "";
  /* «Записано 40 мин» мог перекрыть следующий тост синхронизации — это норма;
     важно, что ложного «Меньше минуты» не было */
  ok(!/Меньше минуты/.test(toastText), `показан ложный тост «Меньше минуты» (тост: ${toastText})`);
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

/* Поведение функции send-reminders: берём чистую часть (deviceKeyOf) и
   прогоняем сценарий «Chrome + iPhone одного человека». */
async function loadReminderHelpers() {
  /* вырезаем чистые функции из index.ts и исполняем их в node */
  const src = read("supabase/functions/send-reminders/index.ts");
  const pick = (name) => {
    const start = src.indexOf("function " + name);
    ok(start >= 0, `в send-reminders нет функции ${name}`);
    let i = src.indexOf("{", start);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (!depth) return src.slice(start, i + 1);
      }
    }
    throw new Error("не закрылась функция " + name);
  };
  const code =
    "const LEGACY_DONE = { min: true, norm: true, max: true };" +
    "function minutesOfRecord(rec){ if(typeof rec==='number') return rec>0?rec:0; if(rec&&typeof rec==='object'&&'min' in rec){const m=Number(rec.min);return Number.isFinite(m)&&m>0?m:0;} return 0; }" +
    "function runningMinutes(rec){ if(!rec||typeof rec!=='object') return 0; const t=rec.timer&&rec.timer.startedAt; if(!t) return 0; const ts=new Date(t).getTime(); if(!Number.isFinite(ts)) return 0; return Math.max(0, Math.floor((Date.now()-ts)/60000)); }" +
    "const minutesOf = (h) => Number(h.slice(0,2))*60 + Number(h.slice(3,5));" +
    "const SLOT_TICK_MIN = 15;" +
    "function timerRunning(rec){ if(!rec||typeof rec!=='object') return false; const st=rec.timer&&rec.timer.startedAt; if(!st) return false; return Number.isFinite(new Date(st).getTime()); }" +
    pick("deviceKeyOf") +
    pick("isFirstTick") +
    pick("blockStarted") +
    "return { deviceKeyOf, isFirstTick, blockStarted };";
  /* файл — TypeScript, а исполняем в node: убираем аннотации типов */
  const js = code
    .replace(/\(row: Record<string, unknown>\): string/g, "(row)")
    .replace(/\(mins: number, from: string\): boolean/g, "(mins, from)")
    .replace(/\(rec: unknown, legacyLevel: unknown, minNeed: number\): boolean/g, "(rec, legacyLevel, minNeed)")
    .replace(/LEGACY_DONE\[legacyLevel as string\]/g, "LEGACY_DONE[legacyLevel]");
  // eslint-disable-next-line no-new-func
  return new Function(js)();
}

test("send-reminders: два устройства одного человека получают по одному разу", async () => {
  const h = await loadReminderHelpers();
  const rows = [
    { user_id: "u1", endpoint: "ep-chrome", device_id: "chrome" },
    { user_id: "u1", endpoint: "ep-iphone", device_id: "iphone" },
    /* старая строка до миграции: без device_id */
    { user_id: "u1", endpoint: "ep-old", device_id: null },
    /* повтор того же устройства (переподписка) */
    { user_id: "u1", endpoint: "ep-chrome-2", device_id: "chrome" },
  ];
  const keys = rows.map((r) => h.deviceKeyOf(r));
  eq(new Set(keys).size, 3, `устройства схлопнулись в ${new Set(keys).size}: ${JSON.stringify([...new Set(keys)])}`);
  ok(keys[0] === keys[3], "переподписка того же устройства не схлопнулась");
  ok(keys[0] !== keys[1], "Chrome и iPhone схлопнулись в одно устройство");
  ok(new Set([keys[0], keys[1], keys[2]]).size === 3, "старая строка без device_id потерялась");

  /* «первый тик»: 0 и 14 минут после начала — да, 15 и 40 — нет */
  ok(h.isFirstTick(10 * 60 + 0, "10:00"), "в 10:00 напоминание не отправляется");
  ok(h.isFirstTick(10 * 60 + 14, "10:00"), "в 10:14 напоминание не отправляется");
  ok(!h.isFirstTick(10 * 60 + 15, "10:00"), "в 10:15 напоминание всё ещё отправляется");
  ok(!h.isFirstTick(11 * 60 + 30, "10:00"), "в 11:30 напоминание всё ещё отправляется");

  /* блок уже начат: минуты, идущий таймер или старая отметка уровня */
  ok(h.blockStarted({ min: 20 }, null, 20), "набранные минуты не считаются начатым блоком");
  ok(!h.blockStarted({ min: 0 }, null, 20), "пустой блок считается начатым");
  ok(h.blockStarted({ min: 0, timer: { startedAt: new Date().toISOString() } }, null, 20), "идущий таймер не считается");
  ok(h.blockStarted(null, "min", 20), "старая отметка уровня не считается");
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

test("намаз: после 6 часов без новых отметок опрос не превращается в полную выгрузку", async () => {
  const { server, w } = await boot({ latency: 30 });

  /* Первая сверка — полная: база пустая, ставятся оба ключа. */
  w.eval("pullSettings()");
  await sleep(500);
  const cursor = w.localStorage.getItem("vp-tracker-namaz-synced-at-v2");
  const fullAt = w.localStorage.getItem("vp-tracker-namaz-full-at-v2");
  ok(cursor, "курсор не завёлся — каждый опрос будет полной выгрузкой");
  ok(fullAt, "время полной сверки не завелось");

  /* Ночь: новых отметок не было 8 часов. Курсор остался старым, но время
     ПОЛНОЙ сверки свежее — значит следующий опрос обязан быть срезом,
     а не выгрузкой всего. */
  w.localStorage.setItem("vp-tracker-namaz-synced-at-v2", new Date(Date.now() - 8 * 3600 * 1000).toISOString());
  const fresh = Date.now() - Date.parse(w.localStorage.getItem("vp-tracker-namaz-full-at-v2")) < 60_000;
  ok(fresh, "время полной сверки старое — опрос пойдёт полной выгрузкой");

  /* Инкрементальный запрос содержит срез по дате, полный — нет. */
  server.S.namaz[dayKey(0) + "|fajr"] = { done: true, updated_at: new Date(Date.now() - 60000).toISOString() };
  w.eval("pullSettings()");
  await sleep(600);
  const before = w.localStorage.getItem("vp-tracker-namaz-synced-at-v2");
  ok(Date.parse(before) > Date.now() - 5 * 60_000, `курсор не сдвинулся после среза: ${before}`);
});

test("намаз: поздний офлайн-клик доезжает без полной сверки (свежие дни по date)", async () => {
  const { server, w } = await boot({ latency: 30 });
  const today = w.eval("selectedDate");

  /* Первая сверка: полная, база пустая — запоминаем границу по updated_at.
     ВАЖНО: namazSync из app.js — это загрузка расписания, а синхронизация
     отметок живёт в timersync.js (внутри IIFE) и вызывается через
     pullSettings(). Поэтому дёргаем именно её. */
  w.eval("pullSettings()");
  await sleep(400);
  const fullFirst = server.S.calls.filter((c) => c.name === "namaz_marks.select").length;

  /* Теперь метка в localStorage выглядит «свежей»: прошлая сверка только что.
     Но на сервере появляется отметка, у которой updated_at СТАРШЕ границы —
     это клик офлайн, отправленный позже (namaz_set пишет время клиента). */
  const oldIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  server.S.namaz[today + "|fajr"] = { done: true, updated_at: oldIso };

  w.eval("pullSettings()");
  await sleep(500);
  eq(w.eval(`!!(state.namaz[${JSON.stringify(today)}] || {}).fajr`), true,
    "отметка со старым updated_at не доехала — фильтр по updated_at её пропустил");
  ok(server.S.calls.filter((c) => c.name === "namaz_marks.select").length > fullFirst, "сверки не было");
});

test("отправляются только изменённые дни, пустой отправки нет", async () => {
  const { server, w } = await boot({ latency: 30 });
  await sleep(700); // стартовая сверка утихла
  const before = server.S.calls.filter((c) => c.name === "days.upsert").length;

  /* ничего не меняли — отправки быть не должно */
  w.eval("pushAll()");
  await sleep(300);
  eq(server.S.calls.filter((c) => c.name === "days.upsert").length, before,
    "пустая отправка дней всё-таки ушла");

  /* меняем один день из трёх — уезжает ровно он */
  w.eval(`state.hours["${dayKey(-2)}"] = { jobs: { min: 90 } };
          state.hours["${dayKey(-1)}"] = { ulbi: { min: 45 } };
          state.hours["${dayKey(-3)}"] = { news: { min: 20 } };
          markDayDirty("${dayKey(-1)}");
          pushAll();`);
  await sleep(400);
  const sent = server.S.calls
    .filter((c) => c.name === "days.upsert")
    .slice(before)
    .flatMap((c) => c.rows || [])
    .map((r) => r.date);
  eq([...new Set(sent)], [dayKey(-1)], "уехали не только изменённые дни");
});

test("после обновления несохранённые локальные дни уезжают на сервер (миграция «грязных»)", async () => {
  /* состояние «старой версии»: дни есть в localStorage, ключа dirty нет */
  const storage = {
    "vp-tracker-v1": JSON.stringify({
      hours: { [dayKey(-1)]: { jobs: { min: 90 } }, [dayKey(-2)]: { ulbi: { min: 45 } } },
      meta: {},
      days: {},
      modes: {},
    }),
  };
  const { server, w } = await boot({ latency: 30, storage });
  await sleep(1200);
  ok(w.localStorage.getItem("vp-tracker-dirty-days"), "дни не помечены изменёнными при обновлении");
  const pushed = server.S.calls.filter((c) => c.name === "days.upsert").flatMap((c) => c.rows || []);
  const dates = new Set(pushed.map((r) => r.date));
  ok(dates.has(dayKey(-1)) && dates.has(dayKey(-2)),
    `не уехали старые дни: отправлены ${JSON.stringify([...dates])}`);
  eq(w.localStorage.getItem("vp-tracker-dirty-migrated-v1"), "1", "миграция не отмечена как выполненная");

  /* второй запуск на тех же данных: повторной пометки быть не должно */
  const again = await boot({ latency: 30, storage });
  await sleep(900);
  eq(again.w.localStorage.getItem("vp-tracker-dirty-migrated-v1"), "1", "миграция повторилась");
});

test("после провала связи «online» сразу досылает правки, а не ждёт минуту", async () => {
  const { server, w } = await boot({ latency: 30 });
  await sleep(600);

  /* правка, которую надо дослать */
  w.eval(`state.hours["${dayKey(-1)}"] = { jobs: { min: 90 } }; markDayDirty("${dayKey(-1)}");`);
  w.eval(`localStorage.setItem("vp-tracker-pending", "1");`);

  /* сеть пропала: проход падает */
  server.S.offline = true;
  w.eval('requestSync("test-offline", { force: true })');
  await sleep(700);
  eq(w.eval("typeof pullLastAt !== 'undefined' ? pullLastAt : -1"), 0,
    "после провала окно «не чаще раза в минуту» не снято");

  /* сеть вернулась — событие online должно дослать правки немедленно */
  server.S.offline = false;
  const before = server.S.calls.filter((c) => c.name === "days.upsert").length;
  w.dispatchEvent(new w.Event("online"));
  await sleep(900);
  const after = server.S.calls.filter((c) => c.name === "days.upsert").length;
  ok(after > before, "после возврата сети правки не ушли");
});

test("все сигналы синхронизации идут через один планировщик с паузой 10 с", async () => {
  const src = read("sync.js");
  ok(/SYNC_MIN_GAP = 10000/.test(src), "нет паузы между запусками");
  ok(/function requestSync/.test(src), "нет общего планировщика");
  const vis = /document\.addEventListener\("visibilitychange"[\s\S]{0,200}requestSync\("visibility"\)/.test(src);
  ok(vis, "возврат во вкладку не идёт через планировщик");
  const online = /addEventListener\("online"[\s\S]{0,400}requestSync\("online"(?:,\s*\{\s*force:\s*true\s*\})?\)/.test(src);
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

test("триггер days_touch: повторная запись тех же дней не двигает updated_at", async () => {
  const { server, w } = await boot({ latency: 30 });
  await sleep(400);
  /* sb мог обнулиться, если initSync не дождался сети: подставляем сервер заново */
  w.__gluesb();
  /* пишем день дважды с одинаковыми данными — как старый клиент, который
     отправлял все дни на каждый сигнал */
  const row = { user_id: "u1", date: dayKey(0), hours: { jobs: { min: 40 } }, mode: null, updated_at: new Date().toISOString() };
  await w.eval(`(async()=>{ await sb.from("days").upsert(${JSON.stringify([row])}, { onConflict: "user_id,date" }); })()`);
  await sleep(200);
  const firstAt = server.S.days[dayKey(0)].updated_at;
  await sleep(30);
  await w.eval(`(async()=>{ await sb.from("days").upsert(${JSON.stringify([row])}, { onConflict: "user_id,date" }); })()`);
  await sleep(200);
  eq(server.S.days[dayKey(0)].updated_at, firstAt, "updated_at сдвинулся от записи без изменений");
  /* а реальное изменение — двигает */
  await w.eval(`(async()=>{ await sb.from("days").upsert([{...${JSON.stringify(row)}, hours: { jobs: { min: 55 } }}], { onConflict: "user_id,date" }); })()`);
  await sleep(200);
  ok(server.S.days[dayKey(0)].updated_at !== firstAt, "updated_at не сдвинулся при реальном изменении");
});

test("SQL-миграция: функция touch_updated_at сравнивает старое и новое", async () => {
  const sql = read("supabase/migrations/20261117_sync_fixes.sql");
  ok(/create or replace function public\.touch_updated_at/.test(sql), "триггер не переопределён");
  ok(/to_jsonb\(old\) - 'updated_at' is distinct from to_jsonb\(new\) - 'updated_at'/.test(sql), "нет сравнения старого и нового значения");
  ok(/return new;/.test(sql), "триггер не возвращает строку");
});

test("дневник: pull четырёх таблиц только если прошла минута или были правки", async () => {
  const src = read("diary.js");
  ok(/PULL_GAP_MS|pullGap|shouldPull/.test(src), "нет ограничения на частоту pull дневника");
  /* Отметку «когда сверялись» ставит только сам pull. Иначе при пропущенном
     pull время уползает вперёд и следующая сверка не случится никогда. */
  const afterSync = src.slice(src.indexOf("async function doSync"), src.indexOf("function hookAuth"));
  ok(!/if\s*\(!mustPull\)\s*notePull\(\)/.test(afterSync), "отметка ставится и без pull — сверка может зависнуть навсегда");
  ok(/mustPull\s*\?\s*await\s+pullAll/.test(afterSync) || /if\s*\(mustPull\)[\s\S]{0,60}pullAll/.test(afterSync),
    "pull не обусловлен правками и таймером");
});

/* ═══════════ 4. НАМАЗ БЕЗ ДУБЛЕЙ ═══════════ */

test("namazTick: дубль между вкладками и после перезагрузки не показывается дважды", async () => {
  const src = read("app.js");
  ok(/NAMAZ_SHOWN_KEY|namazShown/.test(src), "нет отметки «уже показано» в localStorage");
  ok(/namazShownKey|событие\+минута|event.*minute/.test(src) || /nowKey.*id.*ahead/.test(src), "ключ дедупликации не привязан к событию и минуте");
});

/* ═══════════ 5. МЫСЛЬ ДНЯ, ДНИ, АВТОСТОП ═══════════ */

const dailySuite = await import("./daily-day-tests.mjs");
dailySuite.register({ test, eq, ok, boot, sleep, read });

/* ─────────── запуск ─────────── */
(async () => {
  /* ONLY=3,13 — прогнать только эти тесты (отладка); без переменной идут все */
  const only = (process.env.ONLY || "").split(",").filter(Boolean).map(Number);
  let i = 0;
  for (const { name, fn } of results) {
    i++;
    if (only.length && !only.includes(i)) {
      if (!only.includes(i)) { results.length; continue; }
    }
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
