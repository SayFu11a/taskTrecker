# ИИ-дневник, этап 1: как подключить

Что внутри: вкладка «Дневник» (записи дня, цели и подзадачи, анализ ИИ, экспорт в JSON),
5 таблиц в Supabase, Edge Function `analyze-diary` (Gemini). Существующие таблицы,
таймер, намаз и отметки не затрагиваются.

## 1. Код в репозитории
```bash
git checkout -b feature/ai-diary          # от актуального main
# скопируй из пакета в корень репозитория:
#   diary.js, diary.css, apply_diary.py
#   supabase/migrations/20261114_diary.sql (+ _ROLLBACK.sql, README-diary.md)
#   supabase/functions/analyze-diary/ (index.ts, validate.ts)
python3 apply_diary.py                    # добавит вкладку в index.html, обновит sw.js и версию сборки
git add -A && git commit -m "ИИ-дневник: этап 1"
git push -u origin feature/ai-diary       # Vercel соберёт preview-деплой
```

## 2. База (Supabase → SQL Editor)
Вставь `20261114_diary.sql` целиком и нажми Run. Миграция только создаёт новые таблицы,
повторный запуск безопасен. Откат — `20261114_diary_ROLLBACK.sql` (удалит данные дневника,
сначала сделай экспорт JSON).

## 3. Ключ Gemini (бесплатно)
1. Открой Google AI Studio → «Get API key» → создай ключ. Банковская карта не нужна.
2. Положи его в Secrets функции (не в код и не в GitHub):
```bash
supabase secrets set GEMINI_API_KEY=ТВОЙ_КЛЮЧ --project-ref dzgututxrglgvcvduqqx
# необязательно:
supabase secrets set GEMINI_MODEL=gemini-3.1-flash-lite AI_DAILY_LIMIT=15 --project-ref dzgututxrglgvcvduqqx
supabase secrets set ALLOWED_ORIGINS="https://profession-tracker.vercel.app,https://ТВОЙ-PREVIEW.vercel.app" --project-ref dzgututxrglgvcvduqqx
```
Preview-адрес ветки нужно добавить в `ALLOWED_ORIGINS`, иначе браузер заблокирует запрос (CORS).

## 4. Деплой функции
```bash
supabase functions deploy analyze-diary --no-verify-jwt --project-ref dzgututxrglgvcvduqqx
```
`--no-verify-jwt` как у `send-reminders`: токен пользователя проверяется внутри функции,
без него она отвечает 401.

## 5. Проверка
1. Войди через Google (вкладка «Профиль»), открой «Дневник», напиши пару предложений —
   индикатор станет «Синхронизировано».
2. «Проанализировать» → появятся предложенные цели и гипотезы. Принять / изменить / отклонить.
3. Открой трекер на втором устройстве: запись и цели подтянутся.
4. Выключи сеть: дневник и цели работают, правки отправятся при возвращении сети.
5. В Supabase проверь RLS: под другим пользователем чужие строки не видны.

## Ограничения и заметки
- Бесплатный тариф Gemini может использовать отправленный текст для улучшения продуктов Google.
  Лимиты бесплатного тарифа Google больше не публикует в документации — смотри свои в AI Studio.
- Лимит на пользователя: `AI_DAILY_LIMIT` (по умолчанию 15 анализов в сутки, повтор с теми же
  данными лимит не тратит). Если ИИ не ответил, запрос возвращается.
- Сейчас нет: кнопка `i` формирует подсказку из сохранённых рекомендаций (отдельного запроса
  к ИИ нет), раздел «Аналитика» и недельные отчёты — этап 2–3.

## Как это подключено на практике (v42)

Инструкция выше описывает общий случай. В этом репозитории шаги 1, 2 и 4 уже сделаны
и выглядят так:

1. **Код** — в ветке, `apply_diary.py` отработал (вкладка, `sw.js` → `vp-tracker-v41`,
   `BUILD_LABEL` → «сборка v41»). Скрипт в репозиторий не кладётся: он одноразовый.
2. **`vercel.json`** — `buildCommand` больше не перечисляет файлы руками
   (список доходил до лимита схемы Vercel в 256 символов и деплой падал). Теперь
   `mkdir -p public && tar -cf - --exclude=public --exclude=.git . | tar -xf - -C public`:
   копируется всё, что есть в репозитории, новые файлы подхватываются сами.
3. **Миграция** — применена через Supabase MCP как `ai_diary_stage1`
   (5 таблиц, RLS, триггеры, `ai_usage_hit/refund`). SQL Editor не нужен.
4. **Edge Function** — задеплоена версией 3 как самодостаточный файл.
   `index.ts` импортирует `./validate.ts`, а загрузка через API/MCP относительные `.ts`
   не принимает, поэтому тело собирается скриптом:

   ```bash
   node supabase/functions/analyze-diary/bundle.mjs > /tmp/analyze-diary.ts
   npx esbuild /tmp/analyze-diary.ts --target=es2022 --outfile=/dev/null   # проверка синтаксиса
   # затем тело файла залить в analyze-diary (verify_jwt = false)
   supabase functions deploy analyze-diary --use-api --project-ref dzgututxrglgvcvduqqx
   ```

   `verify_jwt = false` уже выставлен. Проверка живости:
   ```sql
   select net.http_post(url := 'https://dzgututxrglgvcvduqqx.supabase.co/functions/v1/analyze-diary',
     headers := '{"Content-Type":"application/json"}'::jsonb,
     body := '{"entry_date":"2026-11-14"}'::jsonb);
   select status_code, content from net._http_response where id = <id>;
   ```
   До вставки ключа ответ — 500 `not_configured` (это норма).
5. **Ключ и CORS** — остаются за владельцем аккаунта (см. шаг 3 выше):
   `GEMINI_API_KEY`, при необходимости `GEMINI_MODEL`, `AI_DAILY_LIMIT`,
   `ALLOWED_ORIGINS` (туда добавить адрес preview-деплоя ветки).
