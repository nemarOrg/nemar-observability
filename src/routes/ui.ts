// The dashboard page: one server-rendered HTML document with embedded CSS and a
// self-contained client script (DOM-built, no framework). The script fetches
// /observability/api/snapshot, renders tiles, and opens admin drill-downs using
// an API key the admin pastes (stored in localStorage). Drill-down requests
// carry the key as a Bearer token; the public snapshot never includes private
// dataset ids.
//
// The client script deliberately avoids template literals and innerHTML for
// data (uses createElement/textContent) so it is safe inside this TS template
// and free of injection from dataset ids / labels.

const CLIENT_JS = String.raw`
const API = "/observability/api";
const KEY_STORE = "nemar_obs_key";
const WW2 = "https://ww2.nemar.org/dataset/";

function getKey() { return localStorage.getItem(KEY_STORE) || ""; }
function setKey(v) { if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE); }

function humanBytes(n) {
  if (!n || n < 1) return "0 B";
  const u = ["B","KB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
}
function fmt(metric) {
  if (metric.unit === "bytes") return humanBytes(metric.value);
  return Number(metric.value).toLocaleString();
}
function pct(value, total) {
  if (!total) return null;
  return Math.round((value / total) * 1000) / 10;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function renderBreakdown(parent, items) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const list = el("div", "breakdown");
  items.slice(0, 8).forEach(function (it) {
    const row = el("div", "bd-row");
    row.appendChild(el("span", "bd-label", it.label));
    const barWrap = el("span", "bd-bar");
    const bar = el("span", "bd-fill");
    bar.style.width = Math.max(2, (it.value / max) * 100) + "%";
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(el("span", "bd-val", Number(it.value).toLocaleString()));
    list.appendChild(row);
  });
  if (items.length > 8) list.appendChild(el("div", "bd-more", "+" + (items.length - 8) + " more"));
  parent.appendChild(list);
}

function tile(metric) {
  const t = el("div", "tile sev-" + (metric.severity || "info"));
  if (metric.drilldown) { t.classList.add("clickable"); t.tabIndex = 0; }
  t.appendChild(el("div", "tile-label", metric.label));
  const valRow = el("div", "tile-value");
  valRow.appendChild(el("span", "v", fmt(metric)));
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "pct", p + "%"));
  t.appendChild(valRow);
  if (metric.total != null && metric.unit !== "bytes") {
    const barWrap = el("div", "pbar");
    const fill = el("div", "pfill");
    fill.style.width = Math.min(100, p || 0) + "%";
    barWrap.appendChild(fill);
    t.appendChild(barWrap);
  }
  if (metric.hint) t.appendChild(el("div", "tile-hint", metric.hint));
  if (metric.breakdown && metric.breakdown.length) renderBreakdown(t, metric.breakdown);
  if (metric.drilldown) {
    const open = function () { openDrilldown(metric.drilldown, metric.label); };
    t.addEventListener("click", open);
    t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    t.appendChild(el("div", "tile-cta", "View details ->"));
  }
  return t;
}

function renderSnapshot(snap) {
  const root = document.getElementById("sections");
  root.textContent = "";
  if (snap.section_errors && snap.section_errors.length) {
    const bar = el("div", "errbar");
    bar.appendChild(el("strong", null, "Some sections failed to load: "));
    bar.appendChild(el("span", null, snap.section_errors.map(function (e) { return e.key; }).join(", ")));
    bar.appendChild(el("span", " errbar-hint", " (data shown may be incomplete)"));
    root.appendChild(bar);
  }
  snap.sections.forEach(function (section) {
    const card = el("section", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, section.label));
    head.appendChild(el("span", "src", section.source));
    card.appendChild(head);
    const grid = el("div", "tiles");
    section.metrics.forEach(function (m) { grid.appendChild(tile(m)); });
    card.appendChild(grid);
    root.appendChild(card);
  });
  const ts = el("span", null, "Updated " + new Date(snap.generated_at).toLocaleString());
  const meta = document.getElementById("meta");
  meta.textContent = "";
  meta.appendChild(ts);
}

function drawerEl() { return document.getElementById("drawer"); }
function closeDrawer() { drawerEl().classList.remove("open"); }

function datasetLink(item) {
  const wrap = el("div", "dl-links");
  const a = el("a", "dl-link", item.dataset_id);
  a.href = WW2 + encodeURIComponent(item.dataset_id);
  a.target = "_blank"; a.rel = "noopener";
  wrap.appendChild(a);
  if (item.github_repo) {
    const g = el("a", "dl-gh", "repo");
    // Build via URL so a stray scheme (e.g. javascript:) in github_repo can't
    // become the href scheme -- it lands in the pathname, encoded.
    try {
      const u = new URL("https://github.com/");
      u.pathname = "/" + item.github_repo;
      g.href = u.href;
      g.target = "_blank"; g.rel = "noopener";
      wrap.appendChild(g);
    } catch (e) { /* skip a malformed repo */ }
  }
  return wrap;
}

function renderDrilldown(result) {
  const body = document.getElementById("drawer-body");
  body.textContent = "";
  if (!result.items.length) { body.appendChild(el("p", "muted", "Nothing here — all clear.")); return; }
  const table = el("table", "dl-table");
  result.items.forEach(function (item) {
    const tr = el("tr");
    const td1 = el("td");
    if (item.dataset_id) td1.appendChild(datasetLink(item));
    else td1.appendChild(el("span", null, item.username || JSON.stringify(item)));
    tr.appendChild(td1);
    const detail = item.name || item.email || item.status || item.last_error || "";
    tr.appendChild(el("td", "dl-detail", detail));
    table.appendChild(tr);
  });
  body.appendChild(table);
}

function openDrilldown(key, label) {
  const d = drawerEl();
  d.classList.add("open");
  document.getElementById("drawer-title").textContent = label;
  const body = document.getElementById("drawer-body");
  body.textContent = "";
  const apiKey = getKey();
  if (!apiKey) {
    body.appendChild(el("p", "muted", "Admin sign-in required to view the list. Click 'Admin' above and paste your NEMAR API key."));
    return;
  }
  body.appendChild(el("p", "muted", "Loading..."));
  fetch(API + "/drilldown/" + encodeURIComponent(key), { headers: { Authorization: "Bearer " + apiKey } })
    .then(function (r) {
      if (r.status === 401) { body.textContent = ""; body.appendChild(el("p", "muted", "Not authorized. Your API key is missing, invalid, or not an admin key.")); return null; }
      if (!r.ok) { body.textContent = ""; body.appendChild(el("p", "muted", "Failed to load (" + r.status + ").")); return null; }
      return r.json();
    })
    .then(function (result) { if (result) renderDrilldown(result); })
    .catch(function () { body.textContent = ""; body.appendChild(el("p", "muted", "Network error.")); });
}

function refreshAdminBtn() {
  const btn = document.getElementById("admin-btn");
  btn.textContent = getKey() ? "Admin: on" : "Admin";
  btn.classList.toggle("on", !!getKey());
}

function setupAdmin() {
  document.getElementById("admin-btn").addEventListener("click", function () {
    const current = getKey();
    const next = window.prompt(current ? "Update or clear your NEMAR admin API key (empty to sign out):" : "Paste your NEMAR admin API key (stored in this browser only):", current);
    if (next === null) return;
    setKey(next.trim());
    refreshAdminBtn();
  });
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  refreshAdminBtn();
}

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

setupAdmin();
load();
`;

const STYLES = String.raw`
:root {
  --bg: #0f1216; --panel: #161b22; --panel-2: #1c2230; --border: #2a3340;
  --fg: #e7edf3; --muted: #8b97a6; --accent: #4aa3ff;
  --ok: #2ea043; --warn: #d29922; --error: #f85149; --info: #6e7b8a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); }
header { display: flex; align-items: center; gap: 16px; padding: 18px 24px;
  border-bottom: 1px solid var(--border); position: sticky; top: 0; background: rgba(15,18,22,.9);
  backdrop-filter: blur(6px); z-index: 5; }
header h1 { font-size: 18px; margin: 0; font-weight: 650; }
header .sub { color: var(--muted); font-size: 13px; }
header .spacer { flex: 1; }
#meta { color: var(--muted); font-size: 12px; margin-right: 4px; }
#admin-btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
#admin-btn.on { border-color: var(--ok); color: var(--ok); }
main { padding: 20px 24px 60px; max-width: 1200px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px 18px 18px; margin-bottom: 18px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.card-head .src { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.tile { background: var(--panel-2); border: 1px solid var(--border); border-left-width: 3px;
  border-radius: 10px; padding: 12px 13px; }
.tile.clickable { cursor: pointer; }
.tile.clickable:hover { border-color: var(--accent); }
.tile.sev-ok { border-left-color: var(--ok); }
.tile.sev-warn { border-left-color: var(--warn); }
.tile.sev-error { border-left-color: var(--error); }
.tile.sev-info { border-left-color: var(--info); }
.tile-label { color: var(--muted); font-size: 12.5px; margin-bottom: 6px; }
.tile-value { display: flex; align-items: baseline; gap: 8px; }
.tile-value .v { font-size: 26px; font-weight: 680; letter-spacing: -.01em; }
.tile-value .pct { color: var(--muted); font-size: 13px; }
.pbar { height: 4px; background: #0c1015; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.pfill { height: 100%; background: var(--accent); }
.tile-hint { color: var(--muted); font-size: 11.5px; margin-top: 7px; line-height: 1.35; }
.tile-cta { color: var(--accent); font-size: 12px; margin-top: 8px; }
.breakdown { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.bd-row { display: grid; grid-template-columns: 76px 1fr 46px; align-items: center; gap: 6px; font-size: 11.5px; }
.bd-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: #0c1015; height: 7px; border-radius: 4px; overflow: hidden; }
.bd-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.bd-val { text-align: right; color: var(--fg); }
.bd-more { color: var(--muted); font-size: 11px; margin-top: 2px; }
.muted { color: var(--muted); }
.errbar { background: rgba(248,81,73,.12); border: 1px solid var(--error); color: #ffd7d4;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.errbar-hint { color: var(--muted); }
#drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(460px, 92vw);
  background: var(--panel); border-left: 1px solid var(--border); transform: translateX(100%);
  transition: transform .18s ease; z-index: 20; display: flex; flex-direction: column; }
#drawer.open { transform: translateX(0); box-shadow: -20px 0 50px rgba(0,0,0,.4); }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.drawer-head h3 { margin: 0; font-size: 15px; flex: 1; }
#drawer-close { background: none; border: none; color: var(--muted); font-size: 22px; cursor: pointer; line-height: 1; }
#drawer-body { padding: 14px 18px; overflow: auto; }
.dl-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dl-table td { padding: 7px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.dl-links { display: flex; gap: 8px; align-items: center; }
.dl-gh { font-size: 11px; color: var(--muted); }
.dl-detail { color: var(--muted); }
`;

export function renderDashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NEMAR Observability</title><meta name="robots" content="noindex"><style>${STYLES}</style></head><body><header><h1>NEMAR Observability</h1><span class="sub">dataset &amp; pipeline health</span><span class="spacer"></span><span id="meta"></span><button id="admin-btn">Admin</button></header><main><div id="sections"></div></main><aside id="drawer"><div class="drawer-head"><h3 id="drawer-title"></h3><button id="drawer-close" aria-label="Close">&times;</button></div><div id="drawer-body"></div></aside><script>${CLIENT_JS}</script></body></html>`;
}
