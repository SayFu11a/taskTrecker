/* Независимая выпуклая линза для золотых блоков намаза.
   Не меняет glass.js, его spring physics, refract filter или CSS-переменные. */
(function () {
  "use strict";

  var SELECTOR = ".timeline .tl-namaz";
  var LENS_CLASS = "tl-namaz-bulge";
  var active = null;
  var observer = null;

  function attach(root) {
    if (!root || !root.querySelectorAll) return;
    var nodes = [];
    if (root.matches && root.matches(SELECTOR)) nodes.push(root);
    var found = root.querySelectorAll(SELECTOR);
    for (var i = 0; i < found.length; i++) nodes.push(found[i]);

    nodes.forEach(function (el) {
      if (el.querySelector("." + LENS_CLASS)) return;
      var lens = document.createElement("span");
      lens.className = LENS_CLASS;
      lens.setAttribute("aria-hidden", "true");
      el.appendChild(lens);
    });
  }

  function setPosition(el, event) {
    var lens = el.querySelector("." + LENS_CLASS);
    if (!lens) return;
    var rect = el.getBoundingClientRect();
    var x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    var y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    el.style.setProperty("--namaz-bulge-x", x.toFixed(1) + "px");
    el.style.setProperty("--namaz-bulge-y", y.toFixed(1) + "px");
  }

  function deactivate() {
    if (!active) return;
    active.classList.remove("namaz-bulge-active");
    active = null;
  }

  document.addEventListener("pointerover", function (event) {
    if (event.pointerType === "touch") return;
    var el = event.target && event.target.closest ? event.target.closest(SELECTOR) : null;
    if (el === active) return;
    deactivate();
    if (!el) return;
    attach(el);
    active = el;
    setPosition(el, event);
    el.classList.add("namaz-bulge-active");
  }, { passive: true });

  document.addEventListener("pointermove", function (event) {
    if (event.pointerType === "touch") {
      var touchEl = event.target && event.target.closest ? event.target.closest(SELECTOR) : null;
      if (touchEl) {
        if (active !== touchEl) {
          deactivate();
          attach(touchEl);
          active = touchEl;
          touchEl.classList.add("namaz-bulge-active");
        }
        setPosition(touchEl, event);
      }
      return;
    }
    var el = event.target && event.target.closest ? event.target.closest(SELECTOR) : null;
    if (!el) {
      deactivate();
      return;
    }
    if (el !== active) {
      deactivate();
      attach(el);
      active = el;
      el.classList.add("namaz-bulge-active");
    }
    setPosition(el, event);
  }, { passive: true });

  document.addEventListener("pointerout", function (event) {
    if (!active || !event.target || !event.target.closest) return;
    var from = event.target.closest(SELECTOR);
    var to = event.relatedTarget && event.relatedTarget.closest
      ? event.relatedTarget.closest(SELECTOR)
      : null;
    if (from === active && to !== active) deactivate();
  }, { passive: true });

  document.addEventListener("pointerup", function (event) {
    if (event.pointerType === "touch") deactivate();
  }, { passive: true });
  document.addEventListener("pointercancel", deactivate, { passive: true });
  window.addEventListener("blur", deactivate);

  function observeTimeline() {
    var timeline = document.getElementById("timeline");
    if (!timeline || !("MutationObserver" in window)) return;
    attach(timeline);
    observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        for (var i = 0; i < record.addedNodes.length; i++) {
          var node = record.addedNodes[i];
          if (node.nodeType === 1) attach(node);
        }
      });
    });
    observer.observe(timeline, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeTimeline, { once: true });
  } else {
    observeTimeline();
  }
})();
