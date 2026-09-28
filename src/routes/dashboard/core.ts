// Client foundation: constants, shared state, formatting, DOM and icon helpers,
// loading and empty states, popovers, the theme toggle, section navigation,
// UTC date-range helpers, and the range preset controls.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const CORE_JS = String.raw`
const API = "/observability/api";
// Where every admin action lives now (#8). Items with a drilldown key link here
// instead of opening an in-page list.
const ADMIN_PORTAL = "https://app.nemar.org/admin";
const SVG_NS = "http://www.w3.org/2000/svg";
// Enough rows for the full size histogram (23 log bins). Truncating a histogram
// misrepresents the distribution rather than merely abbreviating it.
const BREAKDOWN_MAX = 24;
const BREAKDOWN_VISIBLE = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const state = {
  snapshot: null,
  snapshotFailed: false,
  audience: null,
  audienceLoading: true,
  audienceFailed: false,
  audienceInvalid: false,
  series: null,
  history: {}
};

// ---------- formatting ----------
function humanBytes(n) {
  if (!n || n < 1) return "0 B";
  const u = ["B","kB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
}
function num(n) { return Number(n).toLocaleString("en-US"); }
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
function compact(n) {
  if (!Number.isFinite(n)) return "Unknown";
  return Math.abs(n) < 10000 ? Math.round(n).toLocaleString("en-US") : compactFormatter.format(n);
}
function fmt(metric) {
  if (metric.unit === "bytes") return humanBytes(metric.value);
  if (metric.unit === "percent") return num(metric.value) + "%";
  return num(metric.value);
}
function pct(value, total) {
  if (!total) return null;
  return Math.round((value / total) * 1000) / 10;
}
function parseDay(day) { return new Date(day + "T00:00:00Z"); }
function shortDay(day) { const d = parseDay(day); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate(); }
function longDay(day) { const d = parseDay(day); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
function rangeText(start, end) {
  if (start === end) return longDay(start);
  if (start.slice(0, 4) === end.slice(0, 4)) return shortDay(start) + " to " + longDay(end);
  return longDay(start) + " to " + longDay(end);
}
function formatDateTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "an unknown time";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
function relativeTime(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  return days + " days ago";
}
function plural(count, one, many) { return num(count) + " " + (count === 1 ? one : many); }

// ---------- DOM helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(function (key) { e.setAttribute(key, String(attrs[key])); });
  return e;
}
const ICONS = {
  ok: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z", "M5.4 8.2l1.8 1.8 3.5-3.9"],
  warn: ["M7.13 2.6a1 1 0 0 1 1.74 0l5.5 9.7a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z", "M8 6.2v3.1", "M8 11.5v.05"],
  error: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z", "M5.9 5.9l4.2 4.2", "M10.1 5.9l-4.2 4.2"],
  neutral: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z", "M5.5 8h5"],
  partial: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z", "M8 4.5v7"],
  info: ["M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z", "M8 7.3v3.7", "M8 5v.05"],
  external: ["M6.5 3.5h6v6", "M12.5 3.5L4 12"],
  up: ["M8 12.5v-9", "M4.5 7L8 3.5 11.5 7"],
  down: ["M8 3.5v9", "M4.5 9L8 12.5 11.5 9"],
  flat: ["M3.5 8h9"]
};
function icon(name, cls) {
  const s = svgEl("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true", focusable: "false", class: "icon" + (cls ? " " + cls : "") });
  (ICONS[name] || ICONS.neutral).forEach(function (d) { s.appendChild(svgEl("path", { d: d })); });
  return s;
}
const SEVERITY_TEXT = { ok: "Healthy", warn: "Warning", error: "Error", info: "Info" };
function severityIcon(severity) {
  return icon(severity === "ok" ? "ok" : severity === "warn" ? "warn" : severity === "error" ? "error" : "neutral", "sev-icon sev-" + (severity || "info"));
}
function badge(tone, text, iconName) {
  const b = el("span", "badge badge-" + tone);
  b.appendChild(icon(iconName || (tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "error" ? "error" : "neutral")));
  b.appendChild(el("span", null, text));
  return b;
}
// An info popover. The copy behind it is the honesty caveat for a number, kept
// out of the main view but one click away.
function infoDisclosure(label, content) {
  const details = el("details", "popover info");
  const summary = el("summary", "info-trigger");
  summary.setAttribute("aria-label", label);
  summary.appendChild(icon("info"));
  details.appendChild(summary);
  const panel = el("div", "popover-panel info-panel");
  (Array.isArray(content) ? content : [content]).forEach(function (text) {
    if (text) panel.appendChild(el("p", null, text));
  });
  details.appendChild(panel);
  return details;
}
function disclosure(summaryText, cls) {
  const details = el("details", "more" + (cls ? " " + cls : ""));
  details.appendChild(el("summary", null, summaryText));
  return details;
}
function srOnly(text) { return el("span", "sr-only", text); }
function skeletonBlock(cls) { return el("div", "skeleton " + (cls || "")); }
function markRefreshing(root, skeletonFactory) {
  if (root.dataset.ready === "true") {
    root.classList.add("is-refreshing");
  } else {
    root.textContent = "";
    root.appendChild(skeletonFactory());
  }
  root.setAttribute("aria-busy", "true");
}
function settle(root) {
  root.textContent = "";
  root.classList.remove("is-refreshing");
  root.removeAttribute("aria-busy");
  root.dataset.ready = "true";
}
function stateMessage(root, tone, title, body, retry) {
  root.textContent = "";
  root.classList.remove("is-refreshing");
  root.removeAttribute("aria-busy");
  root.dataset.ready = "false";
  const box = el("div", "empty-state empty-" + tone);
  box.appendChild(icon(tone === "error" ? "error" : "info"));
  const text = el("div", "empty-text");
  text.appendChild(el("p", "empty-title", title));
  if (body) text.appendChild(el("p", "empty-body", body));
  if (retry) {
    const button = el("button", "button button-quiet", "Try again");
    button.type = "button";
    button.addEventListener("click", retry);
    text.appendChild(button);
  }
  box.appendChild(text);
  root.appendChild(box);
}
function chartSkeleton() {
  const wrap = el("div", "card skeleton-card");
  wrap.appendChild(skeletonBlock("skeleton-title"));
  wrap.appendChild(skeletonBlock("skeleton-chart"));
  return wrap;
}
function gridSkeleton() {
  const wrap = el("div", "skeleton-grid");
  for (let i = 0; i < 2; i++) {
    const card = el("div", "card skeleton-card");
    card.appendChild(skeletonBlock("skeleton-title"));
    card.appendChild(skeletonBlock("skeleton-line"));
    card.appendChild(skeletonBlock("skeleton-line short"));
    wrap.appendChild(card);
  }
  return wrap;
}
function geoSkeleton() {
  const wrap = el("div", "geo-layout");
  const map = el("div", "card skeleton-card");
  map.appendChild(skeletonBlock("skeleton-map"));
  const side = el("div", "card skeleton-card");
  side.appendChild(skeletonBlock("skeleton-title"));
  side.appendChild(skeletonBlock("skeleton-value"));
  for (let i = 0; i < 5; i++) side.appendChild(skeletonBlock("skeleton-line"));
  wrap.appendChild(map); wrap.appendChild(side);
  return wrap;
}
function metricIndex(snap) {
  const index = {};
  (snap && Array.isArray(snap.sections) ? snap.sections : []).forEach(function (section) {
    (section.metrics || []).forEach(function (metric) { index[metric.key] = metric; });
  });
  return index;
}
function cardId(key) { return "card-" + String(key).replace(/[^a-z0-9_-]/gi, "-"); }

// ---------- popovers, theme, navigation ----------
function clampPopover(details) {
  const panel = details.querySelector(".popover-panel");
  if (!panel) return;
  panel.style.transform = "";
  const rect = panel.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  let shift = 0;
  if (rect.right > viewport - 8) shift = viewport - 8 - rect.right;
  if (rect.left + shift < 8) shift = 8 - rect.left;
  if (shift) panel.style.transform = "translateX(" + Math.round(shift) + "px)";
}
document.addEventListener("toggle", function (event) {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("popover") || !details.open) return;
  document.querySelectorAll("details.popover[open]").forEach(function (other) {
    if (other !== details && !other.contains(details)) other.open = false;
  });
  clampPopover(details);
}, true);
document.addEventListener("click", function (event) {
  document.querySelectorAll("details.popover[open]").forEach(function (details) {
    if (!details.contains(event.target)) details.open = false;
  });
});
document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape") return;
  document.querySelectorAll("details.popover[open]").forEach(function (details) {
    details.open = false;
    const summary = details.querySelector("summary");
    if (summary && details.contains(document.activeElement)) summary.focus();
  });
});

const themeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function effectiveTheme() {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen === "light" || chosen === "dark") return chosen;
  return themeQuery && themeQuery.matches ? "dark" : "light";
}
function syncThemeToggle() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  button.setAttribute("aria-label", "Switch to " + next + " theme");
  button.setAttribute("title", "Switch to " + next + " theme");
}
// The choice lasts for this page view only: the page stores nothing in the
// browser, so a reload follows the system setting again.
document.getElementById("theme-toggle").addEventListener("click", function () {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", next);
  syncThemeToggle();
});
if (themeQuery && themeQuery.addEventListener) themeQuery.addEventListener("change", syncThemeToggle);
syncThemeToggle();

document.querySelectorAll(".nav-menu a").forEach(function (link) {
  link.addEventListener("click", function () {
    const menu = link.closest("details");
    if (menu) menu.open = false;
  });
});
if ("IntersectionObserver" in window) {
  const navObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      document.querySelectorAll("[data-nav-link]").forEach(function (link) {
        if (link.getAttribute("href") === "#" + id) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      });
    });
  }, { rootMargin: "-35% 0px -60% 0px" });
  document.querySelectorAll("main > section[id]").forEach(function (section) { navObserver.observe(section); });
}

// ---------- date range ----------
function isoDay(date) { return date.toISOString().slice(0, 10); }
function shiftDay(day, offset) { const d = new Date(day + "T00:00:00.000Z"); d.setUTCDate(d.getUTCDate() + offset); return isoDay(d); }
function rangeFor(days) { const end = shiftDay(isoDay(new Date()), -1); return { start: shiftDay(end, 1 - days), end: end }; }
function presetFor(start, end) {
  const presets = [7, 30, 90, 365];
  for (let i = 0; i < presets.length; i++) {
    const r = rangeFor(presets[i]);
    if (r.start === start && r.end === end) return presets[i];
  }
  return null;
}

// ---------- range controls ----------
function syncRangePresets() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  let matched = false;
  document.querySelectorAll("[data-range]").forEach(function (button) {
    const range = rangeFor(Number(button.dataset.range));
    const pressed = start === range.start && end === range.end;
    if (pressed) matched = true;
    button.setAttribute("aria-pressed", String(pressed));
  });
  const custom = document.getElementById("range-custom");
  if (custom) custom.classList.toggle("is-active", !matched);
  const summary = document.getElementById("range-summary");
  if (summary) summary.textContent = start && end && start <= end ? rangeText(start, end) + " (UTC)" : "Choose a valid date range";
}
function loadSelectedRange() { syncRangePresets(); loadSeries(); loadAudience(); }
`;
