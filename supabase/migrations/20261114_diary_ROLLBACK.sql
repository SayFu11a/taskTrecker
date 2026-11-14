-- Откат ИИ-дневника. ВНИМАНИЕ: удаляет все записи дневника, цели, подзадачи
-- и результаты анализа из базы. Сделай экспорт JSON в приложении заранее.
-- Таблицы days, settings, timers, push_subscriptions не затрагиваются.

drop table if exists public.goal_subtasks cascade;
drop table if exists public.goals         cascade;
drop table if exists public.diary_entries cascade;
drop table if exists public.ai_analyses   cascade;
drop table if exists public.ai_usage      cascade;

drop function if exists public.ai_usage_hit(uuid, int);
drop function if exists public.ai_usage_refund(uuid);
drop function if exists public.diary_guard_stale();
