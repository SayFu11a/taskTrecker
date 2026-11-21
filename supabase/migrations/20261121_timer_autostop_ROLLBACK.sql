-- Откат 20261121_timer_autostop.sql.
-- Возвращает поведение до автостопа: таймер снова считается до now(),
-- timer_start снова принимает любую дату, задание крона снимается.
-- Функция timer_close_due остаётся (её никто не зовёт) — удалять её не
-- обязательно, но если нужно чисто, раскомментируйте drop в конце.

-- ─────────── 1. снять задание крона ───────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('timers_autostop');
    exception when others then
      null; -- задания не было
    end;
  end if;
end $$;

-- ─────────── 2. вернуть старт без проверки даты ───────────
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

revoke all on function public.timer_start(text, date, integer) from public, anon;
grant execute on function public.timer_start(text, date, integer) to authenticated;

-- ─────────── 3. вернуть статус без потолка ───────────
create or replace function public.timer_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
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
$function$;

revoke all on function public.timer_status() from public, anon;
grant execute on function public.timer_status() to authenticated;

-- ─────────── 4. вернуть стоп без потолка ───────────
create or replace function public.timer_stop()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
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
  if elapsed > 720 then elapsed := 720; end if;

  select coalesce((hours -> t.block ->> 'min')::int, 0)
    into stored
    from public.days where user_id = u and date = t.date;

  total := greatest(coalesce(stored, 0), t.base_min) + elapsed;

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
$function$;

revoke all on function public.timer_stop() from public, anon;
grant execute on function public.timer_stop() to authenticated;

-- ─────────── 5. убрать служебные функции ───────────
drop function if exists public.timers_autostop();
drop function if exists public.timer_close_due(uuid);
drop function if exists public.timer_day_end(date);
drop function if exists public.tracker_tz();

-- Данные, уже записанные автостопом, остаются: откат возвращает поведение,
-- а не переписывает историю минут.
