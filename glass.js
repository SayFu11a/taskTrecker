/* Liquid glass для блоков намаза в «Каркасе дня».

   Отдельный модуль: app.js и styles.css не меняются. Блоки .tl-namaz каждый раз
   создаются заново в renderTimeline(), поэтому всё работает через делегирование
   на document, а не через слушатели на самих блоках.

   Что делает:
   1) пружинное «желе»: при наведении блок набухает к курсору и тянется
      за скоростью мыши, потом возвращается с лёгким перелётом;
   2) в Chromium (Chrome, Edge, Chrome на Android) строит карту смещений и
      подключает её через backdrop-filter: url(#…) — фон за кромкой стекла
      по-настоящему преломляется. В Safari и Firefox этого браузеры не умеют,
      там остаётся размытие + блики из glass.css;
   3) на телефоне нет hover: касание и удержание тянут блок так же;
   4) линза-выпуклость под курсором: круглое стекло, которое увеличивает
      и выпячивает всё рядом (на мыши и пере, на касании не показывается).

   Все значения уходят в CSS-переменные --gx --gy --sx --sy --lx --ly --tz,
   transform считает glass.css. */

(function () {
  "use strict";

  var SEL = ".tl-namaz";
  var RADIUS = 16; // должен совпадать с border-radius в glass.css
  var BEZEL = 16; // ширина «линзовой» кромки, px
  var NS = "http://www.w3.org/2000/svg";

  /* Чистая функция: куда смещать выборку фона в точке (x, y) блока w×h.
     Возвращает [rx, ry] в диапазоне -1..1 — единичный вектор «внутрь»,
     умноженный на силу линзы. У кромки сила 1, в глубине блока 0.
     Выборка из глубины даёт эффект увеличения: содержимое тянется к краю. */
  function displacementAt(x, y, w, h, r, bezel) {
    var px = x + 0.5 - w / 2;
    var py = y + 0.5 - h / 2;
    var qx = Math.abs(px) - (w / 2 - r);
    var qy = Math.abs(py) - (h / 2 - r);
    var ox = Math.max(qx, 0);
    var oy = Math.max(qy, 0);
    var outside = Math.sqrt(ox * ox + oy * oy);
    var sd = outside + Math.min(Math.max(qx, qy), 0) - r; // < 0 внутри
    var depth = -sd;
    if (!(depth > 0 && depth < bezel)) return [0, 0];

    var nx;
    var ny;
    if (outside > 0) {
      nx = (ox / outside) * (px < 0 ? -1 : 1);
      ny = (oy / outside) * (py < 0 ? -1 : 1);
    } else if (qx > qy) {
      nx = px < 0 ? -1 : 1;
      ny = 0;
    } else {
      nx = 0;
      ny = py < 0 ? -1 : 1;
    }

    var t = 1 - depth / bezel; // 1 у кромки → 0 в глубине
    var mag = t * t * (3 - 2 * t); // smoothstep
    return [-nx * mag, -ny * mag]; // внутрь
  }

  /* Радиальная линза (выпуклость под курсором), диаметр d.
     Вектор смещения направлен к центру: фон внутри увеличивается.
     Сила ρ·(1−ρ⁴): в центре 0, максимум на ≈0.67 радиуса, у кромки снова 0,
     поэтому линза плавно сливается с окружением. Нормировка 0.535 — максимум
     функции, так что длина вектора не больше 1. */
  function lensAt(x, y, d) {
    var c = d / 2;
    var dx = x + 0.5 - c;
    var dy = y + 0.5 - c;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var rho = dist / c;
    if (!(rho > 0 && rho < 1)) return [0, 0];
    var g = (rho * (1 - Math.pow(rho, 4))) / 0.535;
    return [(-dx / dist) * g, (-dy / dist) * g];
  }

  if (typeof document === "undefined") {
    /* запуск вне браузера (проверка математики в Node) */
    if (typeof module !== "undefined" && module.exports) module.exports = { displacementAt: displacementAt, lensAt: lensAt };
    return;
  }

  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  var ua = navigator.userAgent || "";
  /* backdrop-filter с SVG-фильтром работает только в Chromium */
  var canRefract = /Chrome\/\d+/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  /* ─────────── карта смещений и SVG-фильтр ─────────── */

  var svgDefs = null;
  var made = {};
  var madeCount = 0;
  var MAX_FILTERS = 24;

  function ensureDefs() {
    if (svgDefs) return svgDefs;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    svgDefs = document.createElementNS(NS, "defs");
    svg.appendChild(svgDefs);
    document.body.appendChild(svg);
    return svgDefs;
  }

  function makeMap(w, h, bezel) {
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(w, h);
    var d = img.data;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var v = displacementAt(x, y, w, h, RADIUS, bezel);
        var i = (y * w + x) * 4;
        d[i] = Math.round(128 + v[0] * 127);
        d[i + 1] = Math.round(128 + v[1] * 127);
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function resetFilters() {
    if (svgDefs) while (svgDefs.firstChild) svgDefs.removeChild(svgDefs.firstChild);
    made = {};
    madeCount = 0;
    var nodes = document.querySelectorAll(SEL);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute("data-lg");
      nodes[i].style.removeProperty("--lg-refract");
    }
  }

  function filterFor(w, h) {
    var id = "lg-" + w + "x" + h;
    if (made[id]) return id;
    if (madeCount >= MAX_FILTERS) resetFilters();

    var bezel = Math.max(6, Math.min(BEZEL, h / 2 - 2));
    var url;
    try {
      url = makeMap(w, h, bezel);
    } catch (e) {
      return null; // canvas запрещён — остаёмся на блюре
    }

    var f = document.createElementNS(NS, "filter");
    f.setAttribute("id", id);
    f.setAttribute("filterUnits", "userSpaceOnUse");
    f.setAttribute("primitiveUnits", "userSpaceOnUse");
    f.setAttribute("x", "0");
    f.setAttribute("y", "0");
    f.setAttribute("width", String(w));
    f.setAttribute("height", String(h));
    f.setAttribute("color-interpolation-filters", "sRGB");

    var feImg = document.createElementNS(NS, "feImage");
    feImg.setAttribute("href", url);
    feImg.setAttribute("x", "0");
    feImg.setAttribute("y", "0");
    feImg.setAttribute("width", String(w));
    feImg.setAttribute("height", String(h));
    feImg.setAttribute("preserveAspectRatio", "none");
    feImg.setAttribute("result", "map");

    var disp = document.createElementNS(NS, "feDisplacementMap");
    disp.setAttribute("in", "SourceGraphic");
    disp.setAttribute("in2", "map");
    /* максимальное смещение = scale / 2 */
    disp.setAttribute("scale", String(Math.round(bezel * 0.9 * 2)));
    disp.setAttribute("xChannelSelector", "R");
    disp.setAttribute("yChannelSelector", "G");

    f.appendChild(feImg);
    f.appendChild(disp);
    ensureDefs().appendChild(f);
    made[id] = true;
    madeCount++;
    return id;
  }

  function refract(el) {
    if (!canRefract) return;
    var w = el.offsetWidth; // размеры без transform
    var h = el.offsetHeight;
    if (w < 48 || h < 24) return; // вкладка скрыта
    var key = w + "x" + h;
    if (el.getAttribute("data-lg") === key) return;
    var id = filterFor(w, h);
    if (!id) return;
    el.style.setProperty("--lg-refract", "url(#" + id + ")");
    el.setAttribute("data-lg", key);
  }

  /* ─────────── пружинное желе ─────────── */

  var CH = ["gx", "gy", "sx", "sy", "lx", "ly", "tz"];
  var REST = { gx: 0, gy: 0, sx: 1, sy: 1, lx: 28, ly: -10, tz: 1 };
  var BASE_SX = 1.04; // блок набухает вширь немного, ввысь — заметно,
  var BASE_SY = 1.3; // чтобы стекло заходило на соседние строки
  var K = 0.17; // жёсткость пружины
  var DAMP = 0.74; // затухание: меньше — больше «желе»

  var states = new WeakMap();
  var live = new Set();
  var raf = 0;
  var active = null;

  function stateOf(el) {
    var s = states.get(el);
    if (!s) {
      s = { hover: false, press: false, nx: 0, ny: 0, lastX: 0, lastY: 0, hasLast: false, dvx: 0, dvy: 0 };
      CH.forEach(function (k) {
        s[k] = { p: REST[k], v: 0, t: REST[k] };
      });
      states.set(el, s);
    }
    return s;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function retarget(s) {
    if (!s.hover) {
      CH.forEach(function (k) {
        s[k].t = REST[k];
      });
      return;
    }
    var ex = Math.min(0.12, Math.abs(s.dvx) * 0.0055); // тянется по ходу мыши
    var ey = Math.min(0.14, Math.abs(s.dvy) * 0.011);
    var press = s.press ? 1 : 0;
    s.sx.t = BASE_SX + ex - ey * 0.45 - press * 0.05; // объём сохраняется: тянем одно — сужаем другое
    s.sy.t = BASE_SY + ey - ex * 0.35 - press * 0.16;
    s.gx.t = s.nx * 10;
    s.gy.t = s.ny * 5;
    s.lx.t = (s.nx * 0.5 + 0.5) * 100;
    s.ly.t = (s.ny * 0.5 + 0.5) * 100 - 28; // блик чуть выше курсора
    s.tz.t = 1.06;
  }

  function write(el, s) {
    var st = el.style;
    st.setProperty("--gx", s.gx.p.toFixed(2) + "px");
    st.setProperty("--gy", s.gy.p.toFixed(2) + "px");
    st.setProperty("--sx", s.sx.p.toFixed(4));
    st.setProperty("--sy", s.sy.p.toFixed(4));
    st.setProperty("--lx", s.lx.p.toFixed(1) + "%");
    st.setProperty("--ly", s.ly.p.toFixed(1) + "%");
    st.setProperty("--tz", s.tz.p.toFixed(4));
  }

  function clearVars(el) {
    ["--gx", "--gy", "--sx", "--sy", "--lx", "--ly", "--tz"].forEach(function (p) {
      el.style.removeProperty(p);
    });
  }

  function tick() {
    raf = 0;
    live.forEach(function (el) {
      if (!el.isConnected) {
        live.delete(el);
        return;
      }
      var s = states.get(el);
      s.dvx *= 0.86;
      s.dvy *= 0.86;
      retarget(s);

      var moving = false;
      CH.forEach(function (k) {
        var c = s[k];
        c.v += (c.t - c.p) * K;
        c.v *= DAMP;
        c.p += c.v;
        if (Math.abs(c.v) > 0.002 || Math.abs(c.t - c.p) > 0.002) moving = true;
      });
      write(el, s);

      if (!s.hover && !moving) {
        clearVars(el);
        el.classList.remove("lg-on");
        live.delete(el);
      } else if (s.hover && !moving && Math.abs(s.dvx) + Math.abs(s.dvy) < 0.5) {
        live.delete(el); // покой под курсором: цикл спит до следующего движения
      }
    });
    var lensMoving = lensStep();
    if (live.size || lensMoving) raf = requestAnimationFrame(tick);
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function track(el, s, e) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2 - s.gx.p;
    var cy = r.top + r.height / 2 - s.gy.p;
    s.nx = clamp((e.clientX - cx) / (el.offsetWidth / 2 || 1), -1, 1);
    s.ny = clamp((e.clientY - cy) / (el.offsetHeight / 2 || 1), -1, 1);
    if (s.hasLast) {
      s.dvx = clamp(e.clientX - s.lastX, -60, 60);
      s.dvy = clamp(e.clientY - s.lastY, -60, 60);
    }
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.hasLast = true;
  }

  function enter(el, e) {
    var s = stateOf(el);
    s.hover = true;
    s.hasLast = false;
    s.dvx = 0;
    s.dvy = 0;
    el.classList.add("lg-on");
    refract(el);
    if (reduceMotion) return;
    track(el, s, e);
    live.add(el);
    kick();
  }

  function move(el, e) {
    if (reduceMotion) return;
    var s = stateOf(el);
    track(el, s, e);
    live.add(el);
    kick();
  }

  function leave(el) {
    var s = states.get(el);
    if (!s) return;
    s.hover = false;
    s.press = false;
    if (reduceMotion) {
      el.classList.remove("lg-on");
      return;
    }
    live.add(el);
    kick();
  }

  function press(el, on) {
    if (reduceMotion) return;
    var s = stateOf(el);
    s.press = on;
    live.add(el);
    kick();
  }

  /* ─────────── выпуклость под курсором (линза) ───────────
     Круглое стекло ездит за курсором по блоку, как «чёрная дыра наоборот»:
     не втягивает, а выпячивает и увеличивает всё рядом — текст блока и
     соседние строки, куда линза заходит краями. Это отдельный элемент
     в <body>: его backdrop-filter видит всю страницу, включая сам блок.
     Скорость мыши растягивает линзу по ходу движения, нажатие сплющивает. */

  var LENS_D = 132; // диаметр, px (то же число в .lg-lens в glass.css)
  var LENS_MAX = 14; // максимальный сдвиг выборки фона у кромки линзы, px
  var lens = {
    el: null,
    on: false,
    press: false,
    hasLast: false,
    lastX: 0,
    lastY: 0,
    dvx: 0,
    dvy: 0,
    x: { p: 0, v: 0, t: 0 },
    y: { p: 0, v: 0, t: 0 },
    s: { p: 0, v: 0, t: 0 },
    sx: { p: 1, v: 0, t: 1 },
    sy: { p: 1, v: 0, t: 1 }
  };

  function makeLensMap(d) {
    var canvas = document.createElement("canvas");
    canvas.width = d;
    canvas.height = d;
    var ctx = canvas.getContext("2d");
    var img = ctx.createImageData(d, d);
    var data = img.data;
    for (var y = 0; y < d; y++) {
      for (var x = 0; x < d; x++) {
        var v = lensAt(x, y, d);
        var i = (y * d + x) * 4;
        data[i] = Math.round(128 + v[0] * 127);
        data[i + 1] = Math.round(128 + v[1] * 127);
        data[i + 2] = 128;
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function ensureLens() {
    if (lens.el) return lens.el;
    var el = document.createElement("div");
    el.className = "lg-lens";
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    lens.el = el;

    if (canRefract) {
      try {
        var f = document.createElementNS(NS, "filter");
        f.setAttribute("id", "lg-lens");
        f.setAttribute("filterUnits", "userSpaceOnUse");
        f.setAttribute("primitiveUnits", "userSpaceOnUse");
        f.setAttribute("x", "0");
        f.setAttribute("y", "0");
        f.setAttribute("width", String(LENS_D));
        f.setAttribute("height", String(LENS_D));
        f.setAttribute("color-interpolation-filters", "sRGB");

        var feImg = document.createElementNS(NS, "feImage");
        feImg.setAttribute("href", makeLensMap(LENS_D));
        feImg.setAttribute("x", "0");
        feImg.setAttribute("y", "0");
        feImg.setAttribute("width", String(LENS_D));
        feImg.setAttribute("height", String(LENS_D));
        feImg.setAttribute("preserveAspectRatio", "none");
        feImg.setAttribute("result", "map");

        var disp = document.createElementNS(NS, "feDisplacementMap");
        disp.setAttribute("in", "SourceGraphic");
        disp.setAttribute("in2", "map");
        disp.setAttribute("scale", String(LENS_MAX * 2)); // макс. сдвиг = scale / 2
        disp.setAttribute("xChannelSelector", "R");
        disp.setAttribute("yChannelSelector", "G");

        f.appendChild(feImg);
        f.appendChild(disp);
        ensureDefs().appendChild(f);
        el.style.setProperty("--lens-refract", "url(#lg-lens)");
      } catch (err) {
        /* без карты линза остаётся стеклянным пузырём с бликами */
      }
    }
    return el;
  }

  function spring(c, k, d) {
    c.v += (c.t - c.p) * k;
    c.v *= d;
    c.p += c.v;
    return Math.abs(c.v) > 0.002 || Math.abs(c.t - c.p) > 0.002;
  }

  /* true — линза ещё движется, и цикл должен продолжаться */
  function lensStep() {
    if (!lens.el) return false;
    lens.dvx *= 0.85;
    lens.dvy *= 0.85;
    var ex = Math.min(0.28, Math.abs(lens.dvx) * 0.012);
    var ey = Math.min(0.28, Math.abs(lens.dvy) * 0.012);
    var sq = lens.press ? 0.08 : 0;
    lens.s.t = lens.on ? 1 : 0;
    lens.sx.t = 1 + ex - ey * 0.4 - sq;
    lens.sy.t = 1 + ey - ex * 0.4 - sq;

    var moving = false;
    if (spring(lens.x, 0.3, 0.68)) moving = true; // небольшое запаздывание — «жидкость»
    if (spring(lens.y, 0.3, 0.68)) moving = true;
    if (spring(lens.s, 0.2, 0.7)) moving = true; // появление с лёгким перелётом
    if (spring(lens.sx, 0.22, 0.7)) moving = true;
    if (spring(lens.sy, 0.22, 0.7)) moving = true;

    var sc = Math.max(0, lens.s.p);
    var st = lens.el.style;
    st.transform =
      "translate3d(" + lens.x.p.toFixed(1) + "px," + lens.y.p.toFixed(1) + "px,0) scale(" +
      (lens.sx.p * sc).toFixed(3) + "," + (lens.sy.p * sc).toFixed(3) + ")";
    st.opacity = String(Math.min(1, sc * 1.5));
    st.visibility = sc < 0.01 && !lens.on ? "hidden" : "visible";
    return moving || Math.abs(lens.dvx) + Math.abs(lens.dvy) > 0.5;
  }

  function lensFollow(e) {
    if (reduceMotion || e.pointerType === "touch") return;
    if (!ensureLens()) return;
    if (!lens.on) {
      /* появляемся сразу под курсором, а не «прилетаем» из прошлой точки */
      lens.on = true;
      lens.x.p = lens.x.t = e.clientX;
      lens.y.p = lens.y.t = e.clientY;
      lens.x.v = lens.y.v = 0;
      lens.dvx = lens.dvy = 0;
      lens.hasLast = false;
    }
    if (lens.hasLast) {
      lens.dvx = clamp(e.clientX - lens.lastX, -80, 80);
      lens.dvy = clamp(e.clientY - lens.lastY, -80, 80);
    }
    lens.lastX = e.clientX;
    lens.lastY = e.clientY;
    lens.hasLast = true;
    lens.x.t = e.clientX;
    lens.y.t = e.clientY;
    kick();
  }

  function lensOff() {
    if (!lens.on) return;
    lens.on = false;
    lens.press = false;
    kick();
  }

  /* ─────────── события ─────────── */

  function blockOf(e) {
    return e.target && e.target.closest ? e.target.closest(SEL) : null;
  }

  document.addEventListener(
    "pointermove",
    function (e) {
      if (e.pointerType === "touch") {
        if (active) move(active, e); // палец ведёт блок
        return;
      }
      var el = blockOf(e);
      if (el !== active) {
        if (active) leave(active);
        active = el;
        if (el) enter(el, e);
      } else if (el) {
        move(el, e);
      }
      if (el) lensFollow(e);
      else lensOff();
    },
    { passive: true }
  );

  document.addEventListener(
    "pointerdown",
    function (e) {
      var el = blockOf(e);
      if (!el) return;
      if (e.pointerType !== "mouse" && active !== el) {
        if (active) leave(active);
        active = el;
        enter(el, e);
      }
      press(el, true);
      if (e.pointerType !== "touch") {
        lens.press = true; // нажатие слегка сплющивает линзу
        kick();
      }
    },
    { passive: true }
  );

  function release(e) {
    if (lens.press) {
      lens.press = false;
      kick();
    }
    if (!active) return;
    var el = active;
    press(el, false);
    if (e.pointerType && e.pointerType !== "mouse") {
      /* на телефоне hover нет: отпускаем стекло через мгновение */
      setTimeout(function () {
        if (active === el) {
          leave(el);
          active = null;
        }
      }, 600);
    }
  }
  document.addEventListener("pointerup", release, { passive: true });
  document.addEventListener("pointercancel", release, { passive: true });

  function dropActive() {
    lensOff();
    if (active) {
      leave(active);
      active = null;
    }
  }
  document.documentElement.addEventListener("mouseleave", dropActive);
  window.addEventListener("blur", dropActive);

  /* ─────────── прогрев карт ─────────── */

  var idle = window.requestIdleCallback
    ? function (fn) {
        window.requestIdleCallback(fn);
      }
    : function (fn) {
        setTimeout(fn, 120);
      };

  function warm() {
    idle(function () {
      var nodes = document.querySelectorAll(SEL);
      for (var i = 0; i < nodes.length; i++) refract(nodes[i]);
    });
  }

  var timeline = document.getElementById("timeline");
  if (canRefract && timeline && "MutationObserver" in window) {
    new MutationObserver(warm).observe(timeline, { childList: true });
    warm();
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(warm, 250);
  });
})();
