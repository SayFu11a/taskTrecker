// Supabase Edge Function: напоминания по расписанию.
//
// Крон (pg_cron) дёргает функцию раз в 15 минут. Функция смотрит московское время,
// находит текущий блок, проверяет в базе, у кого этот блок ещё НЕ отмечен,
// и шлёт push только им. Мёртвые подписки (404/410) удаляет.
//
// verify_jwt = false: шлюз Supabase пропускает запрос, а проверка стоит внутри.
//   крон     — Authorization: Bearer <PUSH_CRON_SECRET> (секрет продублирован в Vault);
//   человек  — кнопка «Проверить» в трекере, его access token;
//   без токена — только диагностика ?dry=1.
// CORS открыт: функцию зовут с https://profession-tracker.vercel.app.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:tracker@example.com";
const CRON_SECRET = Deno.env.get("PUSH_CRON_SECRET") ?? "";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* Europe/Moscow = UTC+3 круглый год */
const TZ_OFFSET_MIN = 180;

/* Те же блоки, что в data.js (TIMELINE) — держать синхронно. */
const SLOTS = [
  { from: "10:00", to: "12:00", block: "ulbi", title: "🎓 Ulbi TV + практика", body: "Два часа основного маршрута. Начни с одного урока." },
  { from: "12:15", to: "13:00", block: "interviews", title: "🗣️ Собеседования", body: "Одна тема, отвечай вслух." },
  { from: "14:00", to: "15:00", block: "leetcode", title: "🧩 LeetCode", body: "Одна задача. Честные 20–30 минут сам." },
  { from: "15:15", to: "16:15", block: "jobs", title: "📮 hh.ru и вакансии", body: "2–3 качественных отклика лучше 20 массовых." },
  { from: "16:30", to: "17:00", block: "news", title: "📡 Новости Frontend", body: "15–20 минут — и всё." },
  { from: "17:00", to: "18:00", block: "review", title: "🔁 Повторение / проект", body: "Своя практика закрепляет лучше конспектов." },
];

const TEST_SLOT = {
  from: "test",
  block: "__test__",
  title: "✅ Уведомления работают",
  body: "Это проверка. Настоящие напоминания придут в начале блока.",
};

/* Минимальный порог блока из data.js (mins.min) — «сделано» = натикало хотя бы столько. */
const MIN_MINUTES: Record<string, number> = {
  ulbi: 20,
  interviews: 10,
  leetcode: 10,
  jobs: 10,
  news: 5,
  review: 5,
  sport: 7,
};

/* Старые уровни → какой порог считать сделанным. Для «сделано» достаточно
   минимума, поэтому любая отметка закрывает блок. */
const LEGACY_DONE: Record<string, boolean> = { min: true, norm: true, max: true };

/* Запись блока в базе: { min, timer? } (новый формат) или просто число (старый). */
function minutesOfRecord(rec: unknown): number {
  if (typeof rec === "number") return rec > 0 ? rec : 0;
  if (rec && typeof rec === "object" && "min" in rec) {
    const m = Number((rec as { min: unknown }).min);
    return Number.isFinite(m) && m > 0 ? m : 0;
  }
  return 0;
}

/* Минуты идущего таймера — чтобы не напоминать о том, чем человек занят прямо сейчас. */
function runningMinutes(rec: unknown): number {
  if (!rec || typeof rec !== "object") return 0;
  const timer = (rec as { timer?: { startedAt?: string } }).timer;
  const startedAt = timer?.startedAt;
  if (!startedAt) return 0;
  const ts = new Date(startedAt).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 60_000));
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, "0");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const isTest = url.searchParams.get("test") === "1";
  const force = url.searchParams.get("force") === "1";
  const slotParam = url.searchParams.get("slot");

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  /* Кто просит */
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const isCron = CRON_SECRET.length > 0 && token === CRON_SECRET;

  let onlyUserId: string | null = null;

  if (isTest) {
    if (!token) return json({ error: "нужен токен пользователя" }, 401);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return json({ error: "токен не принят" }, 401);
    onlyUserId = data.user.id;
  } else if (!isCron) {
    /* Раньше здесь без токена пропускался ?dry=1, а ?force=1 — нет: диагностика
       остаётся открытой, но принудительную отправку может дёрнуть только крон,
       иначе любой человек мог бы рассылать push всем подписчикам. */
    if (!dry) return json({ error: "нужен токен: крон — секрет, человек — вход через Google" }, 401);
  }

  if (force && !isCron && !isTest) {
    return json({ error: "принудительная отправка — только по секрету крона" }, 403);
  }

  /* Московское «сейчас» */
  const nowMsk = new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
  const mins = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes();
  const weekday = (nowMsk.getUTCDay() + 6) % 7;
  const dateKey = `${nowMsk.getUTCFullYear()}-${pad(nowMsk.getUTCMonth() + 1)}-${pad(nowMsk.getUTCDate())}`;

  /* Воскресенье — выходной (ручной прогон и тест — можно) */
  if (weekday === 6 && !isTest && !dry && !force) return json({ sent: 0, reason: "воскресенье" });

  let slot = isTest
    ? TEST_SLOT
    : SLOTS.find((s) => mins >= minutesOf(s.from) && mins < minutesOf(s.to));

  if (force && !isTest) {
    slot = (slotParam ? SLOTS.find((s) => s.from === slotParam) : slot) ?? SLOTS[0];
  }

  if (!slot) return json({ sent: 0, reason: "вне активных блоков", mins });

  /* Подписки: все (крон) или только свои (тест) */
  let query = supabase.from("push_subscriptions").select("user_id, endpoint, subscription");
  if (onlyUserId) query = query.eq("user_id", onlyUserId);

  const { data: subs, error } = await query;
  if (error) return json({ error: error.message }, 500);

  if (onlyUserId && !(subs ?? []).length) {
    return json({ error: "нет подписки на этом устройстве — сначала включи уведомления" }, 409);
  }

  /* Кому напоминание уже не нужно: блок отмечен */
  const skip = new Set<string>();
  const ids = [...new Set((subs ?? []).map((r) => r.user_id as string))];
  if (ids.length && slot.block !== "__test__") {
    /* Читаем минуты (hours), а не старые уровни (blocks): трекер пишет время.
       Блок считаем сделанным, если минут набралось хотя бы на его «минимум».
       Идущий таймер тоже считается — прибавляем его минуты к записанным. */
    const { data: days } = await supabase
      .from("days")
      .select("user_id, hours, blocks")
      .eq("date", dateKey)
      .in("user_id", ids);

    const minNeed = MIN_MINUTES[slot.block] ?? 0;

    for (const row of days ?? []) {
      const userId = row.user_id as string;
      const hours = (row.hours ?? {}) as Record<string, unknown>;
      let minutes = minutesOfRecord(hours[slot.block]) + runningMinutes(hours[slot.block]);

      /* строки, записанные до перехода на минуты, содержат только blocks с уровнями */
      const legacy = (row.blocks ?? {}) as Record<string, string>;
      if (!minutes && LEGACY_DONE[legacy[slot.block]]) minutes = minNeed;

      if (minutes >= minNeed && minutes > 0) skip.add(userId);
    }
  }

  const targets = (subs ?? []).filter((r) => !skip.has(r.user_id as string));

  if (dry) {
    return json({
      dry: true,
      date: dateKey,
      mins,
      slot: slot.from,
      subscriptions: (subs ?? []).length,
      wouldSend: targets.length,
      skippedAlreadyDone: skip.size,
    });
  }

  let sent = 0;
  let removed = 0;
  const failures: string[] = [];

  for (const row of targets) {
    try {
      await webpush.sendNotification(
        row.subscription as never,
        JSON.stringify({ title: slot.title, body: slot.body, tag: `vp-${slot.from}`, url: "./" })
      );
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", row.endpoint as string);
        removed++;
      } else {
        failures.push(`${status ?? "?"}: ${(e as Error).message}`);
      }
    }
  }

  return json({ sent, removed, slot: slot.from, date: dateKey, failures });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
