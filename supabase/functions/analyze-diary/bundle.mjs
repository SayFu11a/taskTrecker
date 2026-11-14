#!/usr/bin/env node
/* Собирает Edge Function в один самодостаточный файл.
   Зачем: index.ts импортирует "./validate.ts", а загрузка через Supabase API/MCP
   относительные .ts не принимает (CLI без этого требует --use-api).
   Источник правды — index.ts + validate.ts; здесь только склейка.

   Запуск:  node supabase/functions/analyze-diary/bundle.mjs > /tmp/analyze-diary.ts
   Проверка: npx esbuild /tmp/analyze-diary.ts --target=es2022 --outfile=/dev/null
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

/* Убирает из src импорты, указывающие на "./validate.ts", оставляя остальные
   (например, npm-импорт supabase-js). Разбор построчный, с учётом многострочных
   import { ... } from "..." — регулярка тут ошибается, поэтому руками. */
function dropLocalImports(src) {
  const out = [];
  let block = [];
  let depth = 0;
  for (const line of src.split("\n")) {
    const startsImport = /^\s*import\b/.test(line);
    if (depth > 0 || startsImport) {
      block.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      const finished = depth <= 0 && /from\s+"[^"]+"\s*;?\s*$/.test(line);
      if (finished) {
        const text = block.join("\n");
        const local = /"\.[/\\]/.test(text) && /validate\.ts/.test(text);
        const typeOnly = /^\s*import\s+type\b/.test(block[0]);
        if (!local && !typeOnly) out.push(...block);
        block = [];
        depth = 0;
      }
      continue;
    }
    out.push(line);
  }
  if (block.length) out.push(...block);
  return out.join("\n");
}

const validate = readFileSync(join(dir, "validate.ts"), "utf8");
const index = readFileSync(join(dir, "index.ts"), "utf8");

// 1. validate.ts без export-префиксов: после склейки это уже один модуль
const local = validate.replace(
  /^export\s+(?=(const|let|var|function|class|async function|type|interface)\b)/gm,
  "",
);

// 2. index.ts без относительных импортов (всё уже вставлено выше)
const main = dropLocalImports(index);

const header = `// Сгенерировано скриптом supabase/functions/analyze-diary/bundle.mjs из index.ts + validate.ts.
// Правки вносить в источники; этот файл заливается в Supabase как тело analyze-diary.
`;

process.stdout.write(header + "\n" + local.trim() + "\n\n" + main.trim() + "\n");
