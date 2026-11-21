-- Автостоп таймера в конце дня (клиент v44).
-- Безопасно запускать повторно: CREATE OR REPLACE / IF NOT EXISTS.
-- Данные не удаляются и не переписываются, кроме одного случая, ради которого
-- миграция и написана: таймер, забытый на прошлый день, закрывается полуночью
-- того дня, когда он был запущен.
--
-- Что здесь:
--   1. tracker_tz() — часовой пояс трекера, по умолчанию Europe/Moscow;
--   2. timer_day_end() — «конец дня» таймера в этом поясе, одна логика на всех;
--   3. timer_start больше не принимает прошедшую/будущую дату;
--   4. timer_status и timer_stop считают натикавшее до конца дня, а не до now();
--      timer_stop возвращает auto_capped = true, если упёрся в потолок;
--   5. timer_close_due() — одна остановка для клиента и для крона;
--   6. timers_autostop() + pg_cron каждые 5 минут — забытые таймеры закрываются
--      без участия человека. Копии логики нет: и крон, и ручной стоп зовут
--      одну и ту же функцию.

-- ─────────── 1. часовой пояс трекера ───────────
-- Отдельная функция, чтобы пояс менялся в одном месте. Europe/Moscow взят
-- по умолчанию: трекер живёт по московскому времени, и полночь у него
-- наступает тогда же, когда у человека.

create or replace function public.tracker_tz()
returns text
language sql
immutable
as $$
  select coalesce(nullif(current_setting('tracker.timezone', true), ''), 'Europe/Moscow');
$$;

comment on function public.tracker_tz() is
  'Часовой пояс трекера. Меняется через alter database ... set tracker.timezone = ''...''.';

-- ─────────── 2. конец дня таймера ───────────
-- Таймер с даты D не идёт в D+1: он живёт до 00:00 следующего дня по поясу
-- трекера. Если started_at вдруг оказался позже этой границы (часы клиента
-- убежали вперёд, записи переехали), потолок не должен быть раньше старта —
-- поэтому greatest(now(), ...) не нужен, но elapsed ниже всё равно не бывает
-- отрицательным.
--
-- «date + interval '1 day'» в поясе DST-переходов даёт ровно следующую
-- календарную полночь, а не 24 часа: именно полночь здесь и нужна.

create or replace function public.timer_day_end(p_date date)
returns timestamptz
language sql
immutable
as $$
  select ((p_date + 1)::timestamp at time zone public.tracker_tz());
$$;

comment on function public.timer_day_end(date) is
  'Полночь, следующая за p_date, по часовому поясу трекера. Верхняя граница жизни таймера.';

-- ─────────── 3. старт только на сегодня ───────────
-- Раньше можно было запустить таймер на любую дату, и он «шёл» из прошлого,
-- накручивая часы задним числом. Теперь сервер принимает только текущую дату
-- по поясу трекера. Проверка на сервере, а не в клиенте: часовая зона и
-- подкрученные часы телефона клиента ничего не решают.

create or replace function public.timer_start(
  p_block text, p_date date, p_base_min integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  u uuid := auth.uid();
  today date := (now() at time zone public.tracker_tz())::date;
  n integer;
  r jsonb;
  t record;
  capped timestamptz;
  elapsed int;
begin
  if u is null then raise exception 'not authenticated'; end if;
  if coalesce(btrim(p_block), '') = '' then raise exception 'block is required'; end if;

  -- Только сегодняшний день. Сравнение идёт с датой по поясу трекера,
  -- а не по UTC: иначе вечером в Москве «сегодня» уезжало бы на вчера.
  if p_date is distinct from today then
    raise exception 'timer_start: только текущая дата (сегодня %), получено %', today, p_date
      using errcode = 'check_violation';
  end if;

  insert into public.timers (user_id, block, date, started_at, base_min, updated_at)
  values (u, p_block, p_date, now(), greatest(coalesce(p_base_min, 0), 0), now())
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;

  /* Если таймер уже идёт (created = false), отдаём его как есть — но с честным
     elapsed: он тоже не может перевалить за полночь своего дня. */
  select * into t from public.timers where user_id = u;
  capped := public.timer_day_end(t.date);
  elapsed := floor(extract(epoch from (least(now(), capped) - t.started_at)) / 60)::int;
  if elapsed < 0 then elapsed := 0; end if;

  r := jsonb_build_object(
    'created', n > 0,
    'block', t.block, 'date', t.date, 'started_at', t.started_at, 'base_min', t.base_min,
    'now', now(),
    'day_end', capped,
    'elapsed_min', elapsed,
    'auto_capped', now() >= capped
  );
  return r;
end;
$function$;

revoke all on function public.timer_start(text, date, integer) from public, anon;
grant execute on function public.timer_start(text, date, integer) to authenticated;

-- ─────────── 4. статус: время не идёт дальше полуночи ───────────
-- Клиент рисует цифры из elapsed_min. Если считать до now(), забытый вчера
-- таймер показывал бы «20 часов» и человек думал, что так и надо.

create or replace function public.timer_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  u uuid := auth.uid();
  t record;
  r jsonb;
  capped timestamptz;
  elapsed int;
begin
  if u is null then raise exception 'not authenticated'; end if;

  select * into t from public.timers where user_id = u;
  if t is null then
    return jsonb_build_object('running', false, 'now', now());
  end if;

  capped := public.timer_day_end(t.date);
  elapsed := floor(extract(epoch from (least(now(), capped) - t.started_at)) / 60)::int;
  if elapsed < 0 then elapsed := 0; end if;

  r := jsonb_build_object(
    'running', true,
    'block', t.block,
    'date', t.date,
    'started_at', t.started_at,
    'base_min', t.base_min,
    'now', now(),
    'day_end', capped,
    'elapsed_min', elapsed,
    'auto_capped', now() >= capped
  );
  return r;
end;
$function$;

revoke all on function public.timer_status() from public, anon;
grant execute on function public.timer_status() to authenticated;

-- ─────────── 5. одна остановка на всех ───────────
-- И ручной стоп, и крон зовут timer_close_due(user). Внутри ровно одно место,
-- где считаются минуты и пишется день. Возврат: stopped, block, date, min,
-- elapsed_min, auto_capped, min_at, now.
--
-- Повторный вызов ничего не дублирует: строки таймера уже нет — stopped=false,
-- а день не трогается. Минуты кладутся через greatest(старое, base) + elapsed:
-- ровно как раньше, чтобы не потерять то, что уже записано.

create or replace function public.timer_close_due(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  t record;
  capped timestamptz;
  elapsed int;
  total int;
  stored int;
  auto_capped boolean;
  min_at bigint;
begin
  if p_user is null then raise exception 'timer_close_due: user is required'; end if;

  select * into t from public.timers where user_id = p_user for update;
  if t is null then
    return jsonb_build_object('stopped', false, 'now', now());
  end if;

  capped := public.timer_day_end(t.date);

  /* Потолок — полночь дня старта. «least(now(), полдень следующего дня)»:
     всё, что натикало после, к дню не относится. */
  elapsed := floor(extract(epoch from (least(now(), capped) - t.started_at)) / 60)::int;
  if elapsed < 0 then elapsed := 0; end if;

  /* auto_capped — признак «упёрлись в полночь», а не «просто остановили».
     По нему клиент говорит: «Таймер за {дата} остановлен в 00:00». */
  auto_capped := now() >= capped;

  select coalesce((hours -> t.block ->> 'min')::int, 0)
    into stored
    from public.days where user_id = p_user and date = t.date;

  total := greatest(coalesce(stored, 0), t.base_min) + elapsed;
  min_at := (extract(epoch from now()) * 1000)::bigint;

  insert into public.days (user_id, date, hours)
  values (p_user, t.date, jsonb_build_object(t.block,
            jsonb_build_object('min', total, 'minAt', min_at)))
  on conflict (user_id, date) do update
    set hours = coalesce(public.days.hours, '{}'::jsonb)
                || jsonb_build_object(t.block,
                     jsonb_build_object('min', total, 'minAt', min_at));

  delete from public.timers where user_id = p_user;

  return jsonb_build_object(
    'stopped', true,
    'block', t.block,
    'date', t.date,
    'min', total,
    'elapsed_min', elapsed,
    'auto_capped', auto_capped,
    'day_end', capped,
    'min_at', min_at,
    'now', now()
  );
end;
$function$;

/* Ручной стоп: та же логика, но пользователь берётся из сессии. */
create or replace function public.timer_stop()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  u uuid := auth.uid();
begin
  if u is null then raise exception 'not authenticated'; end if;
  return public.timer_close_due(u);
end;
$function$;

revoke all on function public.timer_close_due(uuid) from public, anon, authenticated;
revoke all on function public.timer_stop() from public, anon;
grant execute on function public.timer_stop() to authenticated;

-- ─────────── 6. крон: забытые таймеры закрываются сами ───────────
-- Каждые 5 минут, ночь напролёт. Работает по всем пользователям сразу:
-- строк таймеров немного (одна на человека), поэтому это дешевле, чем
-- заводить по заданию на каждого.

create or replace function public.timers_autostop()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  rec record;
  closed int := 0;
  res jsonb;
begin
  /* Только те, чей день уже кончился: сейчас позже полуночи их дня.
     Идущие сегодня таймеры не трогаем вообще. */
  for rec in
    select user_id from public.timers
     where now() >= public.timer_day_end(date)
  loop
    res := public.timer_close_due(rec.user_id);
    if (res ->> 'stopped')::boolean then
      closed := closed + 1;
    end if;
  end loop;
  return closed;
end;
$function$;

revoke all on function public.timers_autostop() from public, anon, authenticated;

-- pg_cron может быть не установлен (локальная база, новый проект).
-- Тогда миграция не падает: крон просто не заводится, а ручной стоп и
-- клиентский автостоп работают. Включить позже: create extension pg_cron;
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice 'pg_cron не включён (%): расписание не создано', sqlerrm;
    end;

    /* Имя задания постоянное, чтобы повторный запуск миграции не плодил копии. */
    begin
      perform cron.unschedule('timers_autostop');
    exception when others then
      null; -- задания не было
    end;

    begin
      perform cron.schedule('timers_autostop', '*/5 * * * *', 'select public.timers_autostop()');
    exception when others then
      raise notice 'cron.schedule недоступен (%): автостоп остаётся на клиенте и ручном стопе', sqlerrm;
    end;
  else
    raise notice 'pg_cron недоступен: автостоп остаётся на клиенте и ручном стопе';
  end if;
end $$;

-- ─────────── 7. разовый догон ───────────
-- Если прямо сейчас висит таймер, запущенный вчера, закроем его сразу,
-- не дожидаясь первого тика крона: человек увидит честные минуты,
-- а не «идёт 20 часов».
select public.timers_autostop();
