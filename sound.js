/* Звуки достижений: синтез через Web Audio API.
   Аудиофайлов нет — не тянем вес, нет лицензий, работает офлайн.
   Всё создаётся лениво: AudioContext появляется только после действия
   пользователя, иначе iOS его приостановит. */

const SFX_KEY = "vp-tracker-sfx"; // "on" | "off"

let audioCtx = null;

function sfxEnabled() {
  try {
    return localStorage.getItem(SFX_KEY) !== "off";
  } catch {
    return true;
  }
}

function setSfxEnabled(on) {
  try {
    localStorage.setItem(SFX_KEY, on ? "on" : "off");
  } catch {
    /* приватный режим — просто не запомним */
  }
  if (on) primeAudio();
}

/* Создаём/будим контекст. Вызывать из обработчика клика. */
function primeAudio() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/* Одна нота с мягкой атакой и затуханием. */
function tone(ctx, freq, startAt, duration, gainPeak = 0.14, type = "sine") {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);

  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(gainPeak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/* Аккорд: несколько нот с рассинхроном — звучит «дороже», чем одна. */
function chord(ctx, freqs, step = 0.055, duration = 0.55, peak = 0.12, type = "sine") {
  const t0 = ctx.currentTime + 0.01;
  freqs.forEach((f, i) => tone(ctx, f, t0 + i * step, duration, peak, type));
}

/* ─────────── наборы звуков ─────────── */

const SFX = {
  /* отметка уровня: короткий мягкий «тик-блип» */
  mark() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [784, 1046], 0.045, 0.32, 0.085, "sine");
  },

  /* норма/максимум — чуть богаче */
  markGood() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [659, 880, 1175], 0.05, 0.42, 0.1, "sine");
  },

  /* кнопка «Отметить» в плашке «Сейчас» */
  tick() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [988], 0, 0.14, 0.06, "triangle");
  },

  /* день закрыт: восходящее арпеджио */
  dayClosed() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [523.25, 659.25, 783.99, 1046.5], 0.075, 0.9, 0.13, "sine");
  },

  /* достижение: мажорный аккорд с задержкой и «воздухом» сверху */
  achievement() {
    const ctx = primeAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.01;
    [523.25, 659.25, 783.99].forEach((f) => tone(ctx, f, t0, 0.7, 0.11, "sine"));
    [1046.5, 1318.5, 1567.98].forEach((f, i) => tone(ctx, f, t0 + 0.16 + i * 0.06, 0.85, 0.09, "triangle"));
  },

  /* тренировка отмечена: плотный, но короткий */
  workout() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [392, 523.25, 659.25], 0.06, 0.5, 0.11, "triangle");
  },

  /* ошибка / пустое поле: не пугающий, просто «не вышло» */
  nope() {
    const ctx = primeAudio();
    if (!ctx) return;
    chord(ctx, [330, 262], 0.07, 0.22, 0.09, "sine");
  },
};

/* Вызвать по имени, с учётом выключенного звука. */
function play(name) {
  if (!sfxEnabled()) return;
  const fn = SFX[name];
  if (typeof fn === "function") {
    try {
      fn();
    } catch {
      /* звук — не повод ломать интерфейс */
    }
  }
}

/* iOS требует, чтобы AudioContext был создан/разбужен внутри жеста.
   Один раз ловим первый тап и «прогреваем» его беззвучно. */
function initAudioOnFirstGesture() {
  const warm = () => {
    const ctx = primeAudio();
    if (ctx) {
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      const osc = ctx.createOscillator();
      osc.connect(g).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
    }
    document.removeEventListener("pointerdown", warm);
    document.removeEventListener("keydown", warm);
  };
  document.addEventListener("pointerdown", warm, { once: true });
  document.addEventListener("keydown", warm, { once: true });
}
