-- Живая синхронизация таймера и намаза между устройствами.
-- Безопасно запускать повторно (всё идемпотентно).
-- Применять ПОСЛЕ выкладки нового timersync.js не обязательно, но желательно
-- в одном заходе: старый клиент с новыми функциями тоже работает.

-- ─────────── 1. Намаз: одна отметка = одна строка ───────────
-- Раньше все отметки лежали одним JSON в settings.namaz: два устройства
-- перезаписывали друг друга целиком, а снятая галочка «воскресала» при слиянии.
-- Теперь у каждой (день, молитва) своя строка со временем правки. Побеждает
-- более поздняя правка, снятие = строка done=false (не пропадает при слиянии).

create table if not exists public.namaz_marks (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  date       date        not null,
  prayer     text        not null,
  done       boolean     not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, date, prayer)
);

alter table public.namaz_marks enable row level security;

drop policy if exists "namaz_marks: своё" on public.namaz_marks;
create policy "namaz_marks: своё" on public.namaz_marks
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Писать в таблицу можно только через namaz_set(): время правки ставится
-- под контролем сервера. Напрямую клиенту нужно только читать.
revoke all on public.namaz_marks from anon, authenticated;
grant select on public.namaz_marks to authenticated;

-- Переносим то, что уже накоплено в settings.namaz
insert into public.namaz_marks (user_id, date, prayer, done, updated_at)
select s.user_id, d.key::date, p.key, true, s.updated_at
from public.settings s
cross join lateral jsonb_each(coalesce(s.namaz, '{}'::jsonb)) as d(key, value)
cross join lateral jsonb_each(
  case when jsonb_typeof(d.value) = 'object' then d.value else '{}'::jsonb end
) as p(key, value)
where d.key ~ '^\d{4}-\d{2}-\d{2}$'
  and p.value = 'true'::jsonb
on conflict (user_id, date, prayer) do nothing;

-- Поставить/снять отметку. p_at — когда человек реально нажал (клиент
-- подставляет время по серверным часам; нужно, чтобы правка, сделанная
-- офлайн, не перебила более свежую с другого устройства). В будущее
-- время не принимаем.
create or replace function public.namaz_set(
  p_date date, p_prayer text, p_done boolean, p_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  u uuid := auth.uid();
  at_ts timestamptz := least(coalesce(p_at, now()), now());
  r public.namaz_marks%rowtype;
begin
  if u is null then raise exception 'not authenticated'; end if;
  if p_date is null or coalesce(btrim(p_prayer), '') = '' then
    raise exception 'date and prayer are required';
  end if;

  insert into public.namaz_marks as m (user_id, date, prayer, done, updated_at)
  values (u, p_date, btrim(p_prayer), coalesce(p_done, true), at_ts)
  on conflict (user_id, date, prayer) do update
    set done = excluded.done, updated_at = excluded.updated_at
    where m.updated_at <= excluded.updated_at;

  -- Возвращаем итог, а не то, что прислали: если в базе правка новее,
  -- клиент увидит решение сервера.
  select * into r from public.namaz_marks
   where user_id = u and date = p_date and prayer = btrim(p_prayer);

  return jsonb_build_object(
    'date', r.date, 'prayer', r.prayer, 'done', r.done,
    'updated_at', r.updated_at, 'now', now()
  );
end;
$function$;

revoke all on function public.namaz_set(date, text, boolean, timestamptz) from public, anon;
grant execute on function public.namaz_set(date, text, boolean, timestamptz) to authenticated;

-- ─────────── 2. Таймер: старт больше не затирает идущий ───────────
-- Раньше повторный timer_start с другого устройства молча сбрасывал
-- started_at: набежавшие минуты терялись. Теперь, если таймер уже идёт,
-- он остаётся как был, а ответ говорит created=false. Вставка атомарна
-- (ON CONFLICT DO NOTHING по user_id), поэтому два одновременных старта
-- не могут оба «победить».

create or replace function public.timer_start(
  p_block text, p_date date, p_base_min integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare u uuid := auth.uid(); n integer; r jsonb;
begin
  if u is null then raise exception 'not authenticated'; end if;
  if coalesce(btrim(p_block), '') = '' then raise exception 'block is required'; end if;

  insert into public.timers (user_id, block, date, started_at, base_min, updated_at)
  values (u, p_block, p_date, now(), greatest(coalesce(p_base_min, 0), 0), now())
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;

  select jsonb_build_object(
    'created', n > 0,
    'block', block, 'date', date, 'started_at', started_at, 'base_min', base_min,
    'now', now(),
    'elapsed_min', floor(extract(epoch from (now() - started_at)) / 60)
  ) into r from public.timers where user_id = u;
  return r;
end;
$function$;

-- ─────────── 3. Realtime: устройства узнают об изменениях сразу ───────────
-- Событие служит лишь сигналом «перечитай»: истина всегда берётся из
-- timer_status() и таблицы namaz_marks, поэтому потерянное или
-- задвоенное событие ничего не ломает (на этот случай есть и опрос).

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'timers') then
    alter publication supabase_realtime add table public.timers;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'namaz_marks') then
    alter publication supabase_realtime add table public.namaz_marks;
  end if;
end $$;
