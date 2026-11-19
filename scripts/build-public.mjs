#!/usr/bin/env node
/* Сборка папки public/ для Vercel.
 *
 * Раньше сайт отдавался прямо из корня репозитория (outputDirectory: "."),
 * поэтому по /README.md, /supabase/schema.sql и /supabase/functions/... открывались
 * служебные файлы. Теперь в public/ попадает только то, что нужно сайту:
 * файлы из корня с расширением из списка ниже. Папки не копируются вообще.
 *
 * После копирования скрипт сверяет public/ со списком SHELL из sw.js:
 * пропавший файл должен ронять сборку, а не давать 404 на проде.
 *
 * Запуск: node scripts/build-public.mjs
 */

import { readdir, rm, mkdir, copyFile, readFile, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public");

/* Что вообще может быть на сайте. Новый файл сайта в корне с таким расширением
   подхватится сам — правки в скрипте не нужны. */
const EXTENSIONS = new Set([
  ".html", ".js", ".css", ".json",
  ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".txt", ".webmanifest",
]);

/* Служебное: лежит в корне, но на сайте не нужно. */
const SKIP_NAMES = new Set(["vercel.json", "package.json", "package-lock.json"]);

const fail = (message) => {
  console.error("\n✖ " + message);
  process.exit(1);
};

const exists = (file) =>
  access(file, FS.F_OK).then(() => true, () => false);

/* ─────────── 1. пересобрать public/ с нуля ─────────── */

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const entries = await readdir(ROOT, { withFileTypes: true });
const copied = [];
const skipped = [];

for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  /* только файлы в корне: папки (supabase, scripts, .git) не копируем */
  if (!entry.isFile()) continue;
  /* точка в начале — скрытое служебное (.gitignore и т.п.) */
  if (entry.name.startsWith(".")) continue;
  if (SKIP_NAMES.has(entry.name)) continue;

  const ext = path.extname(entry.name).toLowerCase();
  if (!EXTENSIONS.has(ext)) {
    skipped.push(entry.name);
    continue;
  }

  await copyFile(path.join(ROOT, entry.name), path.join(OUT, entry.name));
  copied.push(entry.name);
}

if (!copied.includes("index.html")) {
  fail("в корне нет index.html — публиковать нечего.");
}

/* ─────────── 2. сверить public/ со списком SHELL из sw.js ─────────── */

const swPath = path.join(ROOT, "sw.js");
const sw = await readFile(swPath, "utf8").catch(() => "");
if (!sw) fail("не прочитать sw.js — без него нельзя проверить состав public/.");

const shellBlock = sw.match(/const\s+SHELL\s*=\s*\[([\s\S]*?)\];/);
if (!shellBlock) fail("в sw.js не найден массив SHELL — сборка остановлена.");

const shellFiles = [...shellBlock[1].matchAll(/["']\.\/([^"']*)["']/g)]
  .map((match) => match[1].trim())
  .filter((name) => name && name !== "/" && name !== ".");

if (!shellFiles.length) fail("список SHELL в sw.js пуст — проверь формат записей (\"./файл\").");

const missing = [];
for (const name of shellFiles) {
  if (!(await exists(path.join(OUT, name)))) missing.push(name);
}

if (missing.length) {
  fail(
    "в public/ не попали файлы из SHELL (sw.js):\n" +
      missing.map((name) => "    - " + name).join("\n") +
      "\n  На сайте они дали бы 404, а офлайн-кэш остался бы без них.\n" +
      "  Проверь: файл есть в корне? у него разрешённое расширение? он не в SKIP_NAMES?"
  );
}

/* Заодно всё, на что ссылается index.html: <script src> и <link href>.
   Иначе новый скрипт в разметке без файла даст 404 уже на проде. */
const indexHtml = await readFile(path.join(OUT, "index.html"), "utf8");
const referenced = [
  ...indexHtml.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g),
  ...indexHtml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/g),
]
  .map((match) => match[1])
  .filter((url) => !/^(?:https?:)?\/\//.test(url) && !url.startsWith("data:"))
  .map((url) => url.replace(/^\.?\//, "").split(/[?#]/)[0])
  .filter((name) => name);

const missingRefs = [];
for (const name of new Set(referenced)) {
  if (!(await exists(path.join(OUT, name)))) missingRefs.push(name);
}

if (missingRefs.length) {
  fail(
    "index.html ссылается на файлы, которых нет в public/:\n" +
      missingRefs.map((name) => "    - " + name).join("\n") +
      "\n  Такой файл отдал бы 404 на проде."
  );
}

/* ─────────── 3. отчёт ─────────── */

console.log(`✔ public/ собрана: ${copied.length} файлов`);
console.log("  " + copied.join("\n  "));
if (skipped.length) {
  console.log(`\n  не копировались (служебные или не тот тип): ${skipped.join(", ")}`);
}
console.log(`\n  сверено с SHELL из sw.js: ${shellFiles.length} файлов, все на месте.`);
console.log(`  сверено со ссылками index.html: ${new Set(referenced).size} файлов, все на месте.`);
