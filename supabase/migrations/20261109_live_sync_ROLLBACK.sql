-- Откат живой синхронизации. Запускать ТОЛЬКО если нужно вернуться назад.
-- Внимание: отметки намаза, поставленные после перехода, лежат только в
-- namaz_marks (старый settings.namaz их не получал). Перед DROP TABLE
-- выгрузите их, если они нужны.

-- вернуть прежний timer_start (перезаписывает идущий таймер)
create or replace function public.timer_start(p_block text, p_date date, p_base_min integer default 0)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_catalog'
as $function$
declare u uuid := auth.uid(); r jsonb;
begin
  if u is null then raise exception 'not authenticated'; end if;
  if coalesce(btrim(p_block), '') = '' then raise exception 'block is required'; end if;
  insert into public.timers (user_id, block, date, started_at, base_min, updated_at)
  values (u, p_block, p_date, now(), greatest(coalesce(p_base_min, 0), 0), now())
  on conflict (user_id) do update set block = excluded.block, date = excluded.date, started_at = now(), base_min = excluded.base_min, updated_at = now();
  select jsonb_build_object('block', block, 'date', date, 'started_at', started_at, 'base_min', base_min, 'now', now(), 'elapsed_min', floor(extract(epoch from (now() - started_at)) / 60)) into r from public.timers where user_id = u;
  return r;
end; $function$;

alter publication supabase_realtime drop table public.timers;
alter publication supabase_realtime drop table public.namaz_marks;
drop function if exists public.namaz_set(date, text, boolean, timestamptz);
drop table if exists public.namaz_marks;
