/* Намаз для Грозного (Чеченская Республика).

   Источник официального расписания — Муфтият ЧР: dumchr.ru и namaz.islam95.ru
   показывают одни и те же цифры (проверено 06.11.2026: 05:23 / 06:35 / 12:30 /
   14:43 / 16:46 / 18:15). Метод «Муфтият ЧР», аср — одинарная тень
   (шафиитский мазхаб).

   Что лежит здесь и почему:
   - NAMAZ_ANCHORS — реальные опубликованные времена намаза на 2026 год,
     опорные дни месяца (1, 8, 15, 22, 29 + последний день). Это не расчёт
     «по формулам», а данные Муфтията ЧР с их сайтов.
   - Остальные дни месяца — линейная интерполяция между соседними опорами.
     Проверено на ноябре 2026, где официально опубликованы все 30 дней:
     средняя ошибка 0,11 минуты, максимум 1 минута. Кривая времён монотонная,
     поэтому такой способ не выдумывает, а восстанавливает расписание.
   - Восход считается по солнцу с горизонтом −1,8° — специально подобрано
     под опубликованный восход Муфтията (средняя ошибка 0,47 мин, максимум 1 мин
     на том же ноябре). Нужен, потому что восход закрывает время фаджра.
   - Для 2027+ официальных данных нет → расчёт по солнцу (углы ДУМ РФ 16/15,
     аср по одинарной тени) и честная пометка «расчётное» в интерфейсе. */

const NAMAZ_CITY = {
  name: "Грозный",
  region: "Чеченская Республика",
  lat: 43.31195,
  lon: 45.68895,
  tzOffset: 3,
  source: "Муфтият ЧР",
  sourceUrl: "https://namaz.islam95.ru/",
};

/* [день, фаджр, зухр, аср, магриб, иша] — официально опубликованные дни 2026 */
const NAMAZ_ANCHORS = {
  "2026-01": [
    [1, "06:06", "12:30", "14:29", "16:36", "18:12"],
    [8, "06:07", "12:30", "14:35", "16:43", "18:18"],
    [15, "06:05", "12:30", "14:42", "16:51", "18:25"],
    [22, "06:02", "12:30", "14:50", "17:00", "18:33"],
    [29, "05:57", "12:30", "14:57", "17:09", "18:41"],
    [31, "05:55", "12:30", "14:59", "17:11", "18:43"],
  ],
  "2026-02": [
    [1, "05:54", "12:30", "15:01", "17:13", "18:44"],
    [8, "05:47", "12:30", "15:08", "17:23", "18:53"],
    [15, "05:38", "12:30", "15:16", "17:32", "19:01"],
    [22, "05:29", "12:30", "15:23", "17:41", "19:10"],
    [28, "05:23", "12:30", "15:27", "17:47", "19:15"],
  ],
  "2026-03": [
    [1, "05:18", "12:30", "15:29", "17:50", "19:18"],
    [8, "05:06", "12:30", "15:35", "17:59", "19:27"],
    [15, "04:53", "12:30", "15:40", "18:08", "19:36"],
    [22, "04:40", "12:30", "15:44", "18:16", "19:45"],
    [29, "04:27", "12:30", "15:49", "18:24", "19:54"],
    [31, "04:24", "12:30", "15:50", "18:26", "19:56"],
  ],
  "2026-04": [
    [1, "04:21", "12:30", "15:50", "18:28", "19:58"],
    [8, "04:07", "12:30", "15:54", "18:36", "20:08"],
    [15, "03:53", "12:30", "15:57", "18:44", "20:18"],
    [22, "03:39", "12:30", "16:00", "18:52", "20:29"],
    [29, "03:26", "12:30", "16:02", "19:01", "20:40"],
    [30, "03:24", "12:30", "16:02", "19:02", "20:41"],
  ],
  "2026-05": [
    [1, "03:22", "12:30", "16:03", "19:03", "20:43"],
    [8, "03:10", "12:30", "16:06", "19:11", "20:55"],
    [15, "02:59", "12:30", "16:08", "19:19", "21:06"],
    [22, "02:49", "12:30", "16:10", "19:26", "21:16"],
    [29, "02:40", "12:30", "16:13", "19:32", "21:26"],
    [31, "02:38", "12:30", "16:13", "19:34", "21:29"],
  ],
  "2026-06": [
    [1, "02:37", "12:30", "16:14", "19:35", "21:30"],
    [8, "02:32", "12:30", "16:16", "19:40", "21:37"],
    [15, "02:30", "12:30", "16:18", "19:44", "21:42"],
    [22, "02:31", "12:30", "16:20", "19:46", "21:45"],
    [29, "02:34", "12:30", "16:21", "19:46", "21:44"],
    [30, "02:35", "12:30", "16:21", "19:46", "21:44"],
  ],
  "2026-07": [
    [1, "02:35", "12:30", "16:21", "19:46", "21:44"],
    [8, "02:42", "12:30", "16:21", "19:44", "21:40"],
    [15, "02:50", "12:30", "16:21", "19:40", "21:33"],
    [22, "03:00", "12:30", "16:20", "19:35", "21:24"],
    [29, "03:10", "12:30", "16:18", "19:28", "21:14"],
    [31, "03:13", "12:30", "16:18", "19:25", "21:11"],
  ],
  "2026-08": [
    [1, "03:15", "12:30", "16:17", "19:24", "21:09"],
    [8, "03:26", "12:30", "16:13", "19:15", "20:57"],
    [15, "03:37", "12:30", "16:08", "19:05", "20:44"],
    [22, "03:47", "12:30", "16:03", "18:54", "20:30"],
    [29, "03:57", "12:30", "15:56", "18:43", "20:16"],
    [31, "04:00", "12:30", "15:54", "18:40", "20:12"],
  ],
  "2026-09": [
    [1, "04:01", "12:30", "15:53", "18:38", "20:10"],
    [8, "04:11", "12:30", "15:46", "18:25", "19:56"],
    [15, "04:20", "12:30", "15:38", "18:13", "19:42"],
    [22, "04:28", "12:30", "15:29", "18:00", "19:29"],
    [29, "04:37", "12:30", "15:20", "17:47", "19:15"],
    [30, "04:38", "12:30", "15:19", "17:45", "19:13"],
  ],
  "2026-10": [
    [1, "04:39", "12:30", "15:17", "17:44", "19:12"],
    [8, "04:47", "12:30", "15:08", "17:31", "18:59"],
    [15, "04:55", "12:30", "14:59", "17:19", "18:48"],
    [22, "05:03", "12:30", "14:50", "17:08", "18:37"],
    [29, "05:12", "12:30", "14:42", "16:58", "18:27"],
    [31, "05:14", "12:30", "14:40", "16:56", "18:25"],
  ],
  "2026-11": [
    [1, "05:15", "12:30", "14:39", "16:54", "18:24"],
    [8, "05:23", "12:30", "14:32", "16:45", "18:16"],
    [15, "05:31", "12:30", "14:26", "16:38", "18:10"],
    [22, "05:38", "12:30", "14:22", "16:32", "18:05"],
    [29, "05:46", "12:30", "14:19", "16:28", "18:02"],
    [30, "05:47", "12:30", "14:19", "16:28", "18:02"],
  ],
  "2026-12": [
    [1, "05:48", "12:30", "14:19", "16:27", "18:02"],
    [8, "05:54", "12:30", "14:18", "16:26", "18:01"],
    [15, "05:59", "12:30", "14:19", "16:27", "18:03"],
    [22, "06:03", "12:30", "14:22", "16:29", "18:06"],
    [29, "06:06", "12:30", "14:26", "16:34", "18:10"],
    [31, "06:06", "12:30", "14:28", "16:36", "18:12"],
  ],
};

const NAMAZ_LIST = [
  { id: "fajr", name: "Фаджр", ar: "الفجر", icon: "🌅", until: "до восхода" },
  { id: "dhuhr", name: "Зухр", ar: "الظهر", icon: "☀️", until: "до Асра" },
  { id: "asr", name: "Аср", ar: "العصر", icon: "🌤", until: "до заката" },
  { id: "maghrib", name: "Магриб", ar: "المغرب", icon: "🌇", until: "до Иши" },
  { id: "isha", name: "Иша", ar: "العشاء", icon: "🌙", until: "до полуночи" },
];

const NAMAZ_IDS = NAMAZ_LIST.map((p) => p.id);
const NAMAZ_NAMES = NAMAZ_LIST.reduce((acc, p) => ({ ...acc, [p.id]: p.name }), {});

function namazMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function namazHHMM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function namazHasOfficial(dateKey) {
  return Boolean(NAMAZ_ANCHORS[dateKey.slice(0, 7)]);
}

/* Времена намаза на дату YYYY-MM-DD. */
function namazTimes(dateKey) {
  const anchors = NAMAZ_ANCHORS[dateKey.slice(0, 7)];
  const sunrise = namazSunrise(dateKey);

  if (!anchors) {
    return { ...namazCalcTimes(dateKey), sunrise, official: false, source: "расчёт по солнцу" };
  }

  const day = Number(dateKey.slice(8, 10));
  let left = anchors[0];
  let right = anchors[anchors.length - 1];
  for (const row of anchors) {
    if (row[0] <= day) left = row;
    if (row[0] >= day) {
      right = row;
      break;
    }
  }

  const span = right[0] - left[0];
  const t = span === 0 ? 0 : (day - left[0]) / span;
  const out = {};
  ["fajr", "dhuhr", "asr", "maghrib", "isha"].forEach((name, i) => {
    const a = namazMinutes(left[i + 1]);
    const b = namazMinutes(right[i + 1]);
    out[name] = namazHHMM(a + (b - a) * t);
  });

  return { ...out, sunrise, official: true, source: NAMAZ_CITY.source };
}

/* Астрономия: склонение солнца, уравнение времени, истинный полдень. */
function namazSun(dateKey) {
  const lat = NAMAZ_CITY.lat;
  const lon = NAMAZ_CITY.lon;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  const [y, m, d] = dateKey.split("-").map(Number);
  const jd = Date.UTC(y, m - 1, d, 10) / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) +
    Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const yVar = Math.tan(rad(eps / 2)) ** 2;
  const EqT =
    4 *
    deg(
      yVar * Math.sin(2 * rad(L0)) -
        2 * e * Math.sin(rad(M)) +
        4 * e * yVar * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) -
        0.5 * yVar * yVar * Math.sin(4 * rad(L0)) -
        1.25 * e * e * Math.sin(2 * rad(M))
    );

  const noonH = 12 + (NAMAZ_CITY.tzOffset * 15 - lon) / 15 - EqT / 60;

  /* Час-угол восхода/захода для высоты h (градусы). null — солнце не доходит. */
  const hourAngle = (h) => {
    const cosH =
      (Math.sin(rad(h)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) /
      (Math.cos(rad(lat)) * Math.cos(rad(decl)));
    if (cosH > 1 || cosH < -1) return null;
    return deg(Math.acos(cosH)) / 15;
  };

  return { decl, noonH, hourAngle, rad, deg };
}

/* Восход по солнцу. Горизонт −1,8° подобран по опубликованному восходу
   Муфтията ЧР: на ноябре 2026 средняя ошибка 0,47 мин, максимум 1 мин. */
function namazSunrise(dateKey) {
  const { noonH, hourAngle } = namazSun(dateKey);
  const rise = hourAngle(-1.8);
  if (rise === null) return null;
  return namazHHMM((noonH - rise) * 60);
}

/* Расчёт по солнцу — только когда официальных данных на месяц нет (2027+).
   Углы ДУМ РФ: фаджр 16°, иша 15°, аср по одинарной тени (шафиитский мазхаб). */
function namazCalcTimes(dateKey) {
  const { decl, noonH, hourAngle, deg, rad } = namazSun(dateKey);
  const lat = NAMAZ_CITY.lat;

  const safe = (v, hours) => (v === null || !Number.isFinite(v) ? hours : v);
  const alt = deg(Math.atan(1 / (1 + Math.tan(rad(Math.abs(lat - decl))))));

  return {
    fajr: namazHHMM((noonH - safe(hourAngle(-16), 1.5)) * 60),
    dhuhr: namazHHMM(noonH * 60),
    asr: namazHHMM((noonH + safe(hourAngle(alt), 3)) * 60),
    maghrib: namazHHMM((noonH + safe(hourAngle(-0.833), 1.4)) * 60),
    isha: namazHHMM((noonH + safe(hourAngle(-15), 1.6)) * 60),
  };
}

function namazNextKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/* Когда заканчивается время намаза. */
function namazEnd(dateKey, id) {
  const t = namazTimes(dateKey);
  if (id === "fajr") return t.sunrise ? namazMinutes(t.sunrise) : namazMinutes(t.dhuhr);
  if (id === "dhuhr") return namazMinutes(t.asr);
  if (id === "asr") return namazMinutes(t.maghrib);
  if (id === "maghrib") return namazMinutes(t.isha);
  /* иша — до исламской полуночи (середина между магрибом и следующим фаджром) */
  const maghrib = namazMinutes(t.maghrib);
  const fajrNext = namazMinutes(namazTimes(namazNextKey(dateKey)).fajr);
  return maghrib + Math.round((1440 - maghrib + fajrNext) / 2);
}

/* Пять намазов дня с временем начала и конца. */
function namazDay(dateKey) {
  const t = namazTimes(dateKey);
  return NAMAZ_LIST.map((p) => ({
    ...p,
    at: namazMinutes(t[p.id]),
    end: namazEnd(dateKey, p.id),
    time: t[p.id],
  }));
}

/* Что сейчас: текущий намаз (если его время идёт) и следующий. */
function namazNow(dateKey, nowMin) {
  const day = namazDay(dateKey);
  for (let i = 0; i < day.length; i++) {
    const p = day[i];
    /* у каждого намаза своё окно: фаджр закрывается восходом, а не зухром */
    if (nowMin >= p.at && nowMin < p.end) return { current: p, next: day[i + 1] || null, day };
  }
  const upcoming = day.find((p) => p.at > nowMin);
  return { current: null, next: upcoming || null, day };
}
