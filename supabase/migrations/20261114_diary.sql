-- ИИ-дневник, этап 1: записи дня, цели, подзадачи, результаты анализа, лимиты.
-- Применять вручную: Supabase → SQL Editor → New query → вставить целиком → Run.
-- Безопасно запускать повторно (IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS).
-- Откат: 20261114_diary_ROLLBACK.sql. Существующие таблицы не затрагиваются.
--
-- Синхронизация построчная, как у таблицы days:
--   * updated_at ставит клиент (время правки) — по нему решается, чья версия новее;
--   * триггер diary_guard_stale молча отбрасывает устаревшую запись (гонок нет);
--   * server_at ставит база — по нему устройства забирают только новое;
--   * удаление — мягкое (deleted_at), чтобы оно доезжало на другие устройства.

-- ─────────── записи дневника: по строке на дату ───────────
create table if not exists public.diary_entries (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  entry_date date        not null,
  body       text        not null default '' check (char_length(body) <= 20000),
  fields     jsonb       not null default '{}'::jsonb
             check (jsonb_typeof(fields) = 'object' and octet_length(fields::text) <= 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_at  timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, entry_date)
);
create index if not exists diary_entries_user_server_idx on public.diary_entries (user_id, server_at);

-- ─────────── цели ───────────
create table if not exists public.goals (
  id                 uuid        primary key,
  user_id            uuid        not null references auth.users (id) on delete cascade,
  title              text        not null check (char_length(btrim(title)) between 1 and 200),
  description        text        not null default '' check (char_length(description) <= 2000),
  priority           text        not null default 'unknown' check (priority in ('main', 'secondary', 'unknown')),
  urgent             boolean     not null default false,
  category           text        not null default 'other'
                     check (category in ('learning', 'career', 'health', 'finance', 'personal', 'other')),
  deadline           date,
  status             text        not null default 'not_started'
                     check (status in ('not_started', 'in_progress', 'postponed', 'done', 'cancelled')),
  reason             text        not null default '' check (char_length(reason) <= 1000),
  recommendations    jsonb       not null default '[]'::jsonb
                     check (jsonb_typeof(recommendations) = 'array' and octet_length(recommendations::text) <= 6000),
  source_dates       jsonb       not null default '[]'::jsonb
                     check (jsonb_typeof(source_dates) = 'array' and octet_length(source_dates::text) <= 4000),
  source_analysis_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  server_at          timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists goals_user_server_idx on public.goals (user_id, server_at);

-- ─────────── подзадачи ───────────
create table if not exists public.goal_subtasks (
  id                uuid        primary key,
  goal_id           uuid        not null references public.goals (id) on delete cascade,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  title             text        not null check (char_length(btrim(title)) between 1 and 300),
  estimated_minutes int         check (estimated_minutes is null or estimated_minutes between 1 and 1440),
  done              boolean     not null default false,
  position          int         not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  server_at         timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists goal_subtasks_goal_idx   on public.goal_subtasks (goal_id);
create index if not exists goal_subtasks_user_server_idx on public.goal_subtasks (user_id, server_at);

-- ─────────── результаты анализа ИИ ───────────
-- Строки создаёт ТОЛЬКО Edge Function (service role). Клиент может лишь
-- менять feedback («это не так», «принято») и удалять свои строки.
create table if not exists public.ai_analyses (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  entry_date date        not null,
  input_hash text        not null check (char_length(input_hash) = 64),
  model      text        not null default '',
  result     jsonb       not null,
  feedback   jsonb       not null default '{}'::jsonb
             check (jsonb_typeof(feedback) = 'object' and octet_length(feedback::text) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_at  timestamptz not null default now(),
  unique (user_id, input_hash)
);
create index if not exists ai_analyses_user_date_idx   on public.ai_analyses (user_id, entry_date, created_at desc);
create index if not exists ai_analyses_user_server_idx on public.ai_analyses (user_id, server_at);

-- ─────────── суточный лимит запросов к ИИ ───────────
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default ((now() at time zone 'utc')::date),
  count   int  not null default 0,
  primary key (user_id, day)
);

-- ─────────── защита: каждый видит только своё ───────────
alter table public.diary_entries enable row level security;
alter table public.goals         enable row level security;
alter table public.goal_subtasks enable row level security;
alter table public.ai_analyses   enable row level security;
alter table public.ai_usage      enable row level security;

drop policy if exists "diary_entries: своё" on public.diary_entries;
create policy "diary_entries: своё" on public.diary_entries
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "goals: своё" on public.goals;
create policy "goals: своё" on public.goals
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Подзадачу нельзя привязать к чужой цели.
drop policy if exists "goal_subtasks: своё" on public.goal_subtasks;
create policy "goal_subtasks: своё" on public.goal_subtasks
  for all
  using  (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid())
  );

drop policy if exists "ai_analyses: читать своё" on public.ai_analyses;
create policy "ai_analyses: читать своё" on public.ai_analyses
  for select using (auth.uid() = user_id);

drop policy if exists "ai_analyses: менять своё" on public.ai_analyses;
create policy "ai_analyses: менять своё" on public.ai_analyses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "ai_analyses: удалять своё" on public.ai_analyses;
create policy "ai_analyses: удалять своё" on public.ai_analyses
  for delete using (auth.uid() = user_id);

drop policy if exists "ai_usage: читать своё" on public.ai_usage;
create policy "ai_usage: читать своё" on public.ai_usage
  for select using (auth.uid() = user_id);

-- ─────────── права на уровне таблиц (второй рубеж после RLS) ───────────
revoke all on public.diary_entries, public.goals, public.goal_subtasks,
              public.ai_analyses, public.ai_usage from anon;

grant select, insert, update, delete on public.diary_entries, public.goals, public.goal_subtasks to authenticated;

-- ai_analyses: клиент не создаёт строки и не меняет result — только feedback.
revoke insert, update on public.ai_analyses from authenticated;
grant select, delete on public.ai_analyses to authenticated;
grant update (feedback, updated_at) on public.ai_analyses to authenticated;

-- ai_usage: клиент только читает; счётчик двигает Edge Function.
revoke insert, update, delete on public.ai_usage from authenticated;
grant select on public.ai_usage to authenticated;

-- ─────────── защита от устаревших записей и кривых часов ───────────
-- 1) updated_at из будущего (сбитые часы устройства) подрезается до now():
--    иначе такую строку никто не смог бы обновить, пока время «не догонит».
-- 2) UPDATE с более старым updated_at молча пропускается (возврат NULL):
--    два устройства не затирают друг друга, побеждает более свежая правка.
-- 3) server_at — серверное время последнего принятого изменения; по нему
--    устройства забирают новое, не завися от своих часов.
create or replace function public.diary_guard_stale()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.updated_at is null or new.updated_at > now() + interval '5 minutes' then
    new.updated_at := now();
  end if;
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.server_at := now();
  return new;
end;
$$;

drop trigger if exists diary_entries_guard on public.diary_entries;
create trigger diary_entries_guard before insert or update on public.diary_entries
  for each row execute function public.diary_guard_stale();

drop trigger if exists goals_guard on public.goals;
create trigger goals_guard before insert or update on public.goals
  for each row execute function public.diary_guard_stale();

drop trigger if exists goal_subtasks_guard on public.goal_subtasks;
create trigger goal_subtasks_guard before insert or update on public.goal_subtasks
  for each row execute function public.diary_guard_stale();

drop trigger if exists ai_analyses_guard on public.ai_analyses;
create trigger ai_analyses_guard before insert or update on public.ai_analyses
  for each row execute function public.diary_guard_stale();

-- ─────────── счётчик запросов к ИИ (вызывает только Edge Function) ───────────
-- Возвращает новое значение счётчика или NULL, если суточный лимит исчерпан.
-- Увеличение атомарное: два параллельных запроса не проскочат мимо лимита.
create or replace function public.ai_usage_hit(p_user uuid, p_limit int)
returns int
language sql
security definer
set search_path = public, pg_catalog
as $$
  insert into public.ai_usage (user_id, day, count)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    set count = public.ai_usage.count + 1
    where public.ai_usage.count < p_limit
  returning count;
$$;

-- Вернуть списанный запрос, если ИИ не ответил по нашей/чужой вине.
create or replace function public.ai_usage_refund(p_user uuid)
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  update public.ai_usage
     set count = greatest(count - 1, 0)
   where user_id = p_user
     and day = (now() at time zone 'utc')::date;
$$;

revoke execute on function public.ai_usage_hit(uuid, int) from public, anon, authenticated;
revoke execute on function public.ai_usage_refund(uuid)   from public, anon, authenticated;
grant  execute on function public.ai_usage_hit(uuid, int) to service_role;
grant  execute on function public.ai_usage_refund(uuid)   to service_role;

revoke execute on function public.diary_guard_stale() from public, anon, authenticated;
