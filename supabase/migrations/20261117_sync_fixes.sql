-- Исправления синхронизации и уведомлений (клиент v42).
-- Безопасно запускать повторно: всё через IF NOT EXISTS / CREATE OR REPLACE.
-- Данные не удаляются и не переписываются.
--
-- Что здесь:
--   1. push_subscriptions.device_id — одна подписка на устройство, без дублей;
--   2. reminder_log — одно напоминание на блок, а не каждые 15 минут;
--   3. days_touch больше не двигает updated_at, если hours не изменились —
--      иначе у всех дней было одно и то же время и «кто новее» не определить.

-- ─────────── 1. устройство у подписки на push ───────────
-- Старые строки остаются как есть (device_id = null): их нельзя удалять
-- без подтверждения владельца — вдруг это живой второй телефон. Миграция
-- только добавляет колонку и индекс, клиент сам чистит дубли своего устройства
-- при следующей подписке.
alter table public.push_subscriptions
  add column if not exists device_id text;

create index if not exists push_subs_user_device_idx
  on public.push_subscriptions (user_id, device_id);

-- ─────────── 2. журнал напоминаний ───────────
-- Одна строка = «этому человеку про этот блок в этот день уже напомнили».
create table if not exists public.reminder_log (
  user_id uuid        not null references auth.users (id) on delete cascade,
  date    date        not null,
  slot    text        not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, date, slot)
);

create index if not exists reminder_log_date_idx on public.reminder_log (date);

-- Пишет только Edge Function (service_role), клиенту не нужно ни читать, ни писать.
alter table public.reminder_log enable row level security;
drop policy if exists "reminder_log: только сервер" on public.reminder_log;
revoke all on public.reminder_log from anon, authenticated;
grant all on public.reminder_log to service_role;

-- ─────────── 3. updated_at меняется только по делу ───────────
-- Старый триггер ставил now() при любом UPDATE. Клиент отправлял все дни
-- сразу, поэтому у всех 11 строк было одно и то же время, и по нему нельзя
-- было понять, что реально менялось. Теперь отметка двигается только если
-- изменились сами данные (hours/blocks/mode у days, содержимое у settings).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if to_jsonb(old) - 'updated_at' is distinct from to_jsonb(new) - 'updated_at' then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;
  return new;
end;
$$;

-- Триггеры уже висят на days, settings и push_subscriptions — они начнут
-- использовать новую версию функции сразу, пересоздавать не нужно.
