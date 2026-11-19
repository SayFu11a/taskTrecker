-- Откат миграции 20261117_sync_fixes.sql.

-- 2. Журнал напоминаний — удаляет только то, что создала миграция.
drop table if exists public.reminder_log;

-- 3. Триггерная функция возвращается к прежнему виду: обновлять updated_at
--    при любом UPDATE. Триггеры days_touch / settings_touch / push_subs_touch
--    продолжают работать как раньше.
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

-- 1. Колонку device_id в push_subscriptions НЕ удаляем: клиент уже пишет в неё,
--    и при откате он просто перестанет чистить дубли. Если всё же нужно убрать:
--      drop index if exists public.push_subs_user_device_idx;
--      alter table public.push_subscriptions drop column if exists device_id;
