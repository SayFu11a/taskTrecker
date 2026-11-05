// Supabase Edge Function: напоминания по расписанию.
// Запускается по cron (например, раз в 15 минут), смотрит расписание дня
// и рассылает push тем, у кого сейчас подходящий блок.
//
// Деплой:  supabase functions deploy send-reminders --no-verify-jwt
// Секреты: supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// Cron:    добавь расписание в Supabase → Edge Functions → Schedules
//          (или Dashboard → Integrations → Cron), выражение: */15 6-20 * * *

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:tracker@example.com";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/* Те же интервалы, что в data.js — держать синхронно.
   Часовой пояс задан явно, потому что сервер живёт в UTC. */
const TZ_OFFSET_MIN = 180; // Europe/Moscow = UTC+3

const SLOTS = [
  { from: "10:00", to: "12:00", title: "🎓 Ulbi TV + практика", body: "Два часа основного маршрута. Начни с одного урока." },
  { from: "12:15", to: "13:00", title: "🗣️ Подготовка к собеседованиям", body: "Одна тема, отвечай вслух." },
  { from: "14:00", to: "15:00", title: "🧩 LeetCode", body: "Одна задача. Честные 20–30 минут сам." },
  { from: "15:15", to: "16:15", title: "📮 hh.ru и вакансии", body: "2–3 качественных отклика лучше 20 массовых." },
  { from: "16:30", to: "17:00", title: "📡 Новости Frontend", body: "15–20 минут — и всё." },
  { from: "17:00", to: "18:00", title: "🔁 Повторение / проект", body: "Своя практика закрепляет лучше конспектов." },
];

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const now = new Date(Date.now() + TZ_OFFSET_MIN * 60_000);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weekday = (now.getUTCDay() + 6) % 7; // 0 = понедельник

  const slot = SLOTS.find((s) => mins >= minutesOf(s.from) && mins < minutesOf(s.to));
  if (!slot) return json({ sent: 0, reason: "вне активных блоков" });

  /* Воскресенье — выходной, не беспокоим */
  if (weekday === 6) return json({ sent: 0, reason: "воскресенье" });

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("user_id, subscription");

  if (error) return json({ error: error.message }, 500);

  let sent = 0;
  let removed = 0;

  for (const row of subs ?? []) {
    try {
      await webpush.sendNotification(
        row.subscription,
        JSON.stringify({
          title: slot.title,
          body: slot.body,
          tag: `vp-${slot.from}`,
          url: "./",
        })
      );
      sent++;
    } catch (e) {
      /* 404/410 — подписка мертва, чистим, чтобы не копить мусор */
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await supabase.from("push_subscriptions").delete().eq("subscription", row.subscription as never);
        removed++;
      }
    }
  }

  return json({ sent, removed, slot: slot.from });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
