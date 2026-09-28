// Client foundation: constants, shared state, DOM and icon helpers, loading and
// empty states, popovers, the theme toggle, section navigation, and the range
// preset controls. Formatting, date arithmetic, and theme order live in the
// DOM-free modules (format.ts, range.ts, theme.ts) so the tests can run them.
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
const state = {
  snapshot: null,
  snapshotFailed: false,
  audience: null,
  audienceLoading: true,
  audienceFailed: false,
  audienceInvalid: false,
  // The equal-length period before the selected one, for comparisons.
  audiencePrior: null,
  series: null,
  seriesFailed: false,
  // Every reported day of every daily series, for the all-time strip.
  archive: null,
  archiveWindow: null,
  archiveFailed: false,
  history: {},
  historyFailed: {}
};

// Every read goes through here: a default GET to the public API (no method,
// body, or credentials), an HTTP failure reported with the server's own
// message when it sends one, and the answer's shape checked before anyone
// uses it (see model.ts).
function getJson(path, validate, what) {
  return fetch(API + path)
    .then(function (response) {
      if (response.ok) return response.json().catch(function () { throw unexpectedResponse(what); });
      return response.json().catch(function () { return null; }).then(function (body) {
        throw new Error(body && typeof body.error === "string" ? body.error : "Could not load " + what + ".");
      });
    })
    .then(function (body) {
      if (!validate(body)) throw unexpectedResponse(what);
      return body;
    });
}
// The sentence under an error title: an unexpected answer is named as such,
// anything else keeps the server's message when there is one.
function failureDetail(err, fallback) {
  if (err && err.unexpected) return ("The server sent an unexpected response. " + fallback).trim();
  // The title already says it could not load; repeat only a server's reason.
  const message = err && typeof err.message === "string" && err.message && !/^Could not load/.test(err.message)
    ? err.message.replace(/\.?$/, ". ")
    : "";
  return (message + fallback).trim();
}

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
  flat: ["M3.5 8h9"],
  check: ["M3.75 8.4l2.9 2.85 5.6-6"],
  dot: ["M8 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5z"]
};
function icon(name, cls) {
  const s = svgEl("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true", focusable: "false", class: "icon" + (cls ? " " + cls : "") });
  (ICONS[name] || ICONS.neutral).forEach(function (d) { s.appendChild(svgEl("path", { d: d })); });
  return s;
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
function scoped(cell, scope) { cell.setAttribute("scope", scope); return cell; }
// A rounded figure on screen with its exact value for screen readers, rather
// than in a title tooltip that touch and keyboard users never see.
function figure(tag, cls, visible, exact) {
  const node = el(tag, cls);
  if (!exact || exact === visible) { node.textContent = visible; return node; }
  const shown = el("span", null, visible);
  shown.setAttribute("aria-hidden", "true");
  node.appendChild(shown);
  node.appendChild(srOnly(exact));
  return node;
}
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

// Theme: no data-theme attribute means follow the system, live. The toggle
// cycles system and the two explicit themes, opposite of the system first so
// the first click always changes something, and lasts for this page view only:
// the page stores nothing in the browser. A host that sets data-theme on the
// root element (an embedding viewer) is respected as the starting choice.
const themeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function systemTheme() { return themeQuery && themeQuery.matches ? "dark" : "light"; }
function themeChoice() { return normalizeThemeChoice(document.documentElement.getAttribute("data-theme")); }
function effectiveTheme() {
  const chosen = themeChoice();
  return chosen === "system" ? systemTheme() : chosen;
}
function nextTheme() { return nextThemeFor(themeChoice(), systemTheme()); }
function syncThemeToggle() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;
  const choice = themeChoice();
  const next = nextTheme();
  button.setAttribute("data-mode", choice);
  const label = "Theme: " + (choice === "system" ? "system, currently " + effectiveTheme() : choice) + ". Switch to " + next + ".";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", choice === "system" ? "light dark" : choice);
}
document.getElementById("theme-toggle").addEventListener("click", function () {
  const next = nextTheme();
  if (next === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", next);
  syncThemeToggle();
});
if (themeQuery && themeQuery.addEventListener) themeQuery.addEventListener("change", syncThemeToggle);
if ("MutationObserver" in window) {
  new MutationObserver(syncThemeToggle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
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

// ---------- range controls ----------
function selectedRange() {
  return { start: document.getElementById("range-start").value, end: document.getElementById("range-end").value };
}
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
  const text = validRange(start, end) ? rangeText(start, end) : "";
  const summary = document.getElementById("range-summary");
  if (summary) summary.textContent = text ? text + " (UTC)" : "Choose a valid date range";
  // Every range-driven block names the dates it shows.
  document.querySelectorAll("[data-range-chip]").forEach(function (chip) { chip.textContent = text || "No valid range"; });
}
function loadSelectedRange() { syncRangePresets(); loadSeries(); loadAudience(); }
// One polite announcement per range once its figures have drawn, instead of
// every container reading itself out. The first load is not announced; the
// page is already being read from the top.
let announcedRange = null;
function announce(text) {
  const node = document.getElementById("range-announcer");
  if (node) node.textContent = text;
}
function announceRange() {
  const range = selectedRange();
  if (!validRange(range.start, range.end)) return;
  const key = range.start + "|" + range.end;
  const audienceReady = state.audience && !state.audienceLoading && state.audience.start === range.start && state.audience.end === range.end;
  const seriesReady = state.series && state.series.start === range.start && state.series.end === range.end;
  if (!audienceReady || !seriesReady || announcedRange === key) return;
  const first = announcedRange === null;
  announcedRange = key;
  if (!first) announce("Updated for " + rangeText(range.start, range.end) + ".");
}
function announceFailure() {
  const range = selectedRange();
  if (validRange(range.start, range.end)) announce("Some figures for " + rangeText(range.start, range.end) + " could not be shown.");
}
`;
