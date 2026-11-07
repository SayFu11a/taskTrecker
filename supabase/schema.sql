-- Схема для «Возвращение в профессию» (Supabase / Postgres)
-- Выполнить в Supabase → SQL Editor → New query → вставить целиком → Run.
-- Безопасно запускать повторно: всё через IF NOT EXISTS / OR REPLACE.

-- ─────────── дни: по строке на дату ───────────
-- Построчно, а не одним JSON: тогда правки с телефона и с ПК
-- не перетирают друг друга целиком, а сливаются по дате.
create table if not exists public.days (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  date       date        not null,
  blocks     jsonb       not null default '{}'::jsonb,
  hours      jsonb       not null default '{}'::jsonb,  -- фактически потраченные минуты по блокам
  mode       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists days_user_updated_idx on public.days (user_id, updated_at desc);

-- ─────────── настройки: одна строка на пользователя ───────────
create table if not exists public.settings (
  user_id       uuid        primary key references auth.users (id) on delete cascade,
  week          int         not null default 1,
  schedule_view text        not null default 'detail',
  achievements  jsonb       not null default '{}'::jsonb,
  leetcode      jsonb       not null default '[]'::jsonb,
  namaz         jsonb       not null default '{}'::jsonb,
  namaz_on      boolean     not null default true,
  gym           jsonb       not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- Догоняем уже созданные базы: тренировки раньше не хранились на сервере.
alter table public.settings add column if not exists namaz    jsonb   not null default '{}'::jsonb;
alter table public.settings add column if not exists namaz_on boolean not null default true;
alter table public.settings add column if not exists gym      jsonb   not null default '{}'::jsonb;

-- ─────────── подписки на push ───────────
create table if not exists public.push_subscriptions (
  endpoint  text        primary key,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  subscription jsonb    not null,
  updated_at   timestamptz not null default now()
);

create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);

-- ─────────── защита: каждый видит только своё ───────────
-- Это правило живёт в самой базе, поэтому обойти его из JS нельзя.

alter table public.days               enable row level security;
alter table public.settings           enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "days: своё"    on public.days;
create policy "days: своё" on public.days
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "settings: своё" on public.settings;
create policy "settings: своё" on public.settings
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "push: своё"    on public.push_subscriptions;
create policy "push: своё" on public.push_subscriptions
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─────────── автоматический updated_at ───────────
-- Чтобы синхронизация понимала, чья версия дня свежее.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists days_touch       on public.days;
create trigger days_touch
  before update on public.days
  for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch   on public.settings;
create trigger settings_touch
  before update on public.settings
  for each row execute function public.touch_updated_at();

-- Готово. Дальше: Authentication → Providers → Google (включить),
-- и вписать Project URL + anon key в sync.js и push.js.

-- ─────────── безопасность функций ───────────
-- push_reminders_tick() — SECURITY DEFINER, читает секрет из Vault и дёргает
-- Edge Function. Клиентам вызывать её незачем: только cron (роль postgres).
revoke execute on function public.push_reminders_tick() from public;
revoke execute on function public.push_reminders_tick() from anon;
revoke execute on function public.push_reminders_tick() from authenticated;

-- touch_updated_at() — только триггерная функция, снаружи не нужна.
revoke execute on function public.touch_updated_at() from public;
revoke execute on function public.touch_updated_at() from anon;
revoke execute on function public.touch_updated_at() from authenticated;
