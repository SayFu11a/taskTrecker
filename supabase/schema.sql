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

-- ─────────── таймер: время считает сервер, а не телефон ───────────
-- Зачем: раньше «сколько прошло» считал браузер как now() − startedAt. Если
-- часы устройства сбиты (телефон отстаёт/спешит на 5 часов), телефон,
-- открывший уже идущий таймер, показывал лишние часы, и это время записывалось
-- в минуты навсегда. Теперь старт и стоп фиксирует база: elapsed считает
-- Postgres по своим часам, клиент только показывает.
create table if not exists public.timers (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  block      text        not null,
  date       date        not null,
  started_at timestamptz not null default now(),
  base_min   int         not null default 0,   -- записанные минуты блока на момент старта
  updated_at timestamptz not null default now()
);

alter table public.timers enable row level security;

drop policy if exists "timers: своё" on public.timers;
create policy "timers: своё" on public.timers
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Старт таймера. Один таймер на аккаунт: новый старт заменяет прежний.
create or replace function public.timer_start(p_block text, p_date date, p_base_min int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  u uuid := auth.uid();
  r jsonb;
begin
  if u is null then raise exception 'not authenticated'; end if;
  if coalesce(btrim(p_block), '') = '' then raise exception 'block is required'; end if;

  insert into public.timers (user_id, block, date, started_at, base_min, updated_at)
  values (u, p_block, p_date, now(), greatest(coalesce(p_base_min, 0), 0), now())
  on conflict (user_id) do update
    set block      = excluded.block,
        date       = excluded.date,
        started_at = now(),
        base_min   = excluded.base_min,
        updated_at = now();

  select jsonb_build_object(
           'block', block,
           'date', date,
           'started_at', started_at,
           'base_min', base_min,
           'now', now(),
           'elapsed_min', floor(extract(epoch from (now() - started_at)) / 60)
         )
    into r
    from public.timers where user_id = u;
  return r;
end;
$$;

-- Текущее состояние таймера. Всегда возвращает серверное время — по нему
-- клиент выравнивает свои часы.
create or replace function public.timer_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  u uuid := auth.uid();
  r jsonb;
begin
  if u is null then raise exception 'not authenticated'; end if;

  select jsonb_build_object(
           'running', true,
           'block', block,
           'date', date,
           'started_at', started_at,
           'base_min', base_min,
           'now', now(),
           'elapsed_min', floor(extract(epoch from (now() - started_at)) / 60)
         )
    into r
    from public.timers where user_id = u;

  if r is null then
    r := jsonb_build_object('running', false, 'now', now());
  end if;
  return r;
end;
$$;

-- Стоп таймера: минуты считает база и сразу пишет их в строку дня.
-- Клиент получает готовое число и ничего не вычисляет сам.
create or replace function public.timer_stop()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  u uuid := auth.uid();
  t record;
  elapsed int;
  total int;
  stored int;
begin
  if u is null then raise exception 'not authenticated'; end if;

  select * into t from public.timers where user_id = u for update;
  if t is null then
    return jsonb_build_object('stopped', false, 'now', now());
  end if;

  elapsed := floor(extract(epoch from (now() - t.started_at)) / 60)::int;
  if elapsed < 0 then elapsed := 0; end if;
  if elapsed > 720 then elapsed := 720; end if;  -- 12 часов: забытый таймер

  select coalesce((hours -> t.block ->> 'min')::int, 0)
    into stored
    from public.days where user_id = u and date = t.date;

  total := greatest(coalesce(stored, 0), t.base_min) + elapsed;

  /* minAt — отметка правки (миллисекунды по часам базы). Без неё устройство
     со старым (большим) числом минут «перебивало» записанный стоп, и часы
     возвращались при синхронизации. */
  insert into public.days (user_id, date, hours)
  values (u, t.date, jsonb_build_object(t.block,
            jsonb_build_object('min', total, 'minAt', (extract(epoch from now()) * 1000)::bigint)))
  on conflict (user_id, date) do update
    set hours = coalesce(public.days.hours, '{}'::jsonb)
                || jsonb_build_object(t.block,
                     jsonb_build_object('min', total, 'minAt', (extract(epoch from now()) * 1000)::bigint));

  delete from public.timers where user_id = u;

  return jsonb_build_object(
    'stopped', true,
    'block', t.block,
    'date', t.date,
    'min', total,
    'elapsed_min', elapsed,
    'now', now()
  );
end;
$$;

-- Функции только для вошедших: anon и гости вызывать их не должны.
revoke execute on function public.timer_start(text, date, int) from public;
revoke execute on function public.timer_start(text, date, int) from anon;
grant  execute on function public.timer_start(text, date, int) to authenticated;

revoke execute on function public.timer_status() from public;
revoke execute on function public.timer_status() from anon;
grant  execute on function public.timer_status() to authenticated;

revoke execute on function public.timer_stop() from public;
revoke execute on function public.timer_stop() from anon;
grant  execute on function public.timer_stop() to authenticated;

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
