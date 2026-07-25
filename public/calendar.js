/* Custom date-range picker — replaces native <input type="date"> pairs.
 * Usage: RangePicker.init('from-id', 'to-id', {presets:[7,30]})
 * The native inputs stay in the DOM (hidden) so all existing code that
 * reads their .value keeps working unchanged; this just controls how
 * the value gets set.
 */
(function () {
  var MONTHS = ["Січень","Лютий","Березень","Квітень","Травень","Червень","Липень","Серпень","Вересень","Жовтень","Листопад","Грудень"];
  var WEEKDAYS = ["Пн","Вт","Ср","Чт","Пт","Сб","Нд"];
  var CAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>';

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtISO(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fmtShort(d) { return pad(d.getDate()) + "." + pad(d.getMonth() + 1); }
  function fmtFull(d) { return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear(); }
  function parseISO(s) {
    if (!s) return null;
    var p = s.split("-");
    if (p.length !== 3) return null;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d.getTime()) ? null : d;
  }
  function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function init(fromId, toId, opts) {
    opts = opts || {};
    var fromEl = document.getElementById(fromId), toEl = document.getElementById(toId);
    if (!fromEl || !toEl || fromEl.dataset.rpInit) return;
    fromEl.dataset.rpInit = "1";

    var presets = opts.presets || [7, 30];
    var placeholder = opts.placeholder || "Обрати період";

    fromEl.style.display = "none";
    toEl.style.display = "none";

    var wrap = document.createElement("div");
    wrap.className = "rp-wrap";
    wrap.innerHTML =
      '<button type="button" class="rp-trigger"><span class="rp-ico">' + CAL_ICON + '</span><span class="rp-label placeholder">' + placeholder + '</span></button>' +
      '<div class="rp-panel" hidden>' +
        '<div class="rp-head"><b class="rp-month"></b><div class="rp-nav"><button type="button" class="rp-prev">‹</button><button type="button" class="rp-next">›</button></div></div>' +
        '<div class="rp-weekdays">' + WEEKDAYS.map(function (w) { return "<span>" + w + "</span>"; }).join("") + '</div>' +
        '<div class="rp-days"></div>' +
        '<div class="rp-foot"><div class="rp-presets">' + presets.map(function (p) { return '<span data-days="' + p + '">' + p + ' дн.</span>'; }).join("") + '</div><button type="button" class="rp-apply">Застосувати</button></div>' +
      '</div>';
    toEl.insertAdjacentElement("afterend", wrap);

    var trigger = wrap.querySelector(".rp-trigger");
    var panel = wrap.querySelector(".rp-panel");
    var label = wrap.querySelector(".rp-label");
    var monthLabel = wrap.querySelector(".rp-month");
    var daysGrid = wrap.querySelector(".rp-days");

    var rangeStart = parseISO(fromEl.value);
    var rangeEnd = parseISO(toEl.value);
    var viewMonth = rangeStart || new Date();
    viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);

    function refreshLabel() {
      var s = parseISO(fromEl.value), e = parseISO(toEl.value);
      if (s && e) { label.textContent = fmtShort(s) + " — " + fmtFull(e); label.classList.remove("placeholder"); }
      else if (s) { label.textContent = fmtFull(s) + " — …"; label.classList.remove("placeholder"); }
      else { label.textContent = placeholder; label.classList.add("placeholder"); }
    }

    // Intercept external .value assignment (e.g. a "✕ clear" button doing
    // el.value='') so the trigger label stays in sync without touching
    // any existing onclick handlers.
    [fromEl, toEl].forEach(function (el) {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (!desc || el.dataset.rpValueHooked) return;
      el.dataset.rpValueHooked = "1";
      Object.defineProperty(el, "value", {
        get: function () { return desc.get.call(this); },
        set: function (v) { desc.set.call(this, v); refreshLabel(); },
        configurable: true
      });
    });

    function renderDays() {
      monthLabel.textContent = MONTHS[viewMonth.getMonth()] + " " + viewMonth.getFullYear();
      var firstDow = (viewMonth.getDay() + 6) % 7; // Monday = 0
      var daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
      var daysInPrevMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 0).getDate();
      var today = startOfDay(new Date());
      var cells = [];
      for (var i = firstDow - 1; i >= 0; i--) cells.push({ d: daysInPrevMonth - i, muted: true });
      for (var d = 1; d <= daysInMonth; d++) cells.push({ d: d, muted: false, date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d) });
      var remain = (7 - (cells.length % 7)) % 7;
      for (var j = 1; j <= remain; j++) cells.push({ d: j, muted: true });

      daysGrid.innerHTML = cells.map(function (c) {
        if (c.muted) return '<div class="rp-day muted">' + c.d + "</div>";
        var cls = ["rp-day"];
        if (sameDay(c.date, today)) cls.push("today");
        if (rangeStart && sameDay(c.date, rangeStart)) cls.push("selected", "range-start");
        if (rangeEnd && sameDay(c.date, rangeEnd)) cls.push("selected", "range-end");
        if (rangeStart && rangeEnd && c.date > rangeStart && c.date < rangeEnd) cls.push("in-range");
        return '<div class="' + cls.join(" ") + '" data-date="' + fmtISO(c.date) + '">' + c.d + "</div>";
      }).join("");
    }

    function open() {
      rangeStart = parseISO(fromEl.value);
      rangeEnd = parseISO(toEl.value);
      viewMonth = new Date((rangeEnd || rangeStart || new Date()).getFullYear(), (rangeEnd || rangeStart || new Date()).getMonth(), 1);
      renderDays();
      panel.hidden = false;
      trigger.classList.add("open");
    }
    function close() {
      panel.hidden = true;
      trigger.classList.remove("open");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (panel.hidden) open(); else close();
    });

    document.addEventListener("click", function (e) {
      if (!panel.hidden && !wrap.contains(e.target)) close();
    });

    wrap.querySelector(".rp-prev").addEventListener("click", function (e) {
      e.stopPropagation();
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
      renderDays();
    });
    wrap.querySelector(".rp-next").addEventListener("click", function (e) {
      e.stopPropagation();
      viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
      renderDays();
    });

    daysGrid.addEventListener("click", function (e) {
      var cell = e.target.closest(".rp-day:not(.muted)");
      if (!cell) return;
      e.stopPropagation();
      var clicked = parseISO(cell.dataset.date);
      if (!rangeStart || (rangeStart && rangeEnd)) {
        rangeStart = clicked; rangeEnd = null;
      } else if (clicked < rangeStart) {
        rangeEnd = rangeStart; rangeStart = clicked;
      } else {
        rangeEnd = clicked;
      }
      renderDays();
    });

    wrap.querySelectorAll(".rp-presets span").forEach(function (p) {
      p.addEventListener("click", function (e) {
        e.stopPropagation();
        var days = parseInt(p.dataset.days, 10);
        var end = startOfDay(new Date());
        var start = new Date(end.getTime() - (days - 1) * 86400000);
        fromEl.value = fmtISO(start);
        toEl.value = fmtISO(end);
        close();
      });
    });

    wrap.querySelector(".rp-apply").addEventListener("click", function (e) {
      e.stopPropagation();
      if (rangeStart) fromEl.value = fmtISO(rangeStart);
      if (rangeEnd) toEl.value = fmtISO(rangeEnd);
      close();
    });

    refreshLabel();
  }

  window.RangePicker = { init: init };
})();
