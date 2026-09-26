// The dashboard page: one server-rendered HTML document with embedded CSS and a
// self-contained client script (DOM-built, no framework). It fetches
// /observability/api/snapshot and renders tiles. That is all it does.
//
// ZERO AUTH, ZERO WRITES (#8). This page holds no credential and performs no
// mutation. The approve/deny/delete controls and the paste-your-`nm_…`-API-key
// prompt are both gone: every action lives in the website admin portal on
// app.nemar.org, behind an HttpOnly host-scoped session cookie. A spoof of this
// origin now has nothing to steal and nothing to trigger.
//
// Tiles that have a `drilldown` key link out to the admin portal instead of
// opening a list here. GET /api/drilldown/:key still exists for programmatic
// use (Bearer, admin-only) and is removed in phase 3 (#13) once the website
// carries equivalent dataset-health lists (phase 2: nemar-cli#1032 + website#195).
//
// The client script deliberately avoids template literals and innerHTML for
// data (uses createElement/textContent) so it is safe inside this TS template
// and free of injection from dataset ids / labels.

const CLIENT_JS = String.raw`
const API = "/observability/api";
// Where every admin action lives now (#8). Tiles with a drilldown key link here
// instead of opening an in-page list.
const ADMIN_PORTAL = "https://app.nemar.org/admin";
function humanBytes(n) {
  if (!n || n < 1) return "0 B";
  const u = ["B","KB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
}
function fmt(metric) {
  if (metric.unit === "bytes") return humanBytes(metric.value);
  if (metric.unit === "percent") return Number(metric.value).toLocaleString() + "%";
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

// A breakdown can be denominated differently from its tile: "Most read
// datasets" is a count of datasets whose bars are bytes each. metric.breakdown_unit
// carries that; absent, the bars share the tile's unit.
function renderBreakdown(parent, items, unit) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const fmtVal = unit === "bytes" ? humanBytes : function (v) { return Number(v).toLocaleString(); };
  const list = el("div", "breakdown");
  items.slice(0, 8).forEach(function (it) {
    const row = el("div", "bd-row");
    row.appendChild(el("span", "bd-label", it.label));
    const barWrap = el("span", "bd-bar");
    const bar = el("span", "bd-fill");
    bar.style.width = Math.max(2, (it.value / max) * 100) + "%";
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(el("span", "bd-val", fmtVal(it.value)));
    list.appendChild(row);
  });
  if (items.length > 8) list.appendChild(el("div", "bd-more", "+" + (items.length - 8) + " more"));
  parent.appendChild(list);
}

function tile(metric) {
  const t = el("div", "tile sev-" + (metric.severity || "info"));
  const heading = el("div", "tile-heading");
  heading.appendChild(el("div", "tile-label", metric.label));
  if (metric.severity === "warn" || metric.severity === "error") {
    const status = el("span", "tile-status status-" + metric.severity, metric.severity === "warn" ? "Warning" : "Error");
    status.setAttribute("role", "status");
    heading.appendChild(status);
  }
  t.appendChild(heading);
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
  if (metric.breakdown && metric.breakdown.length) renderBreakdown(t, metric.breakdown, metric.breakdown_unit || metric.unit);
  // A drilldown key used to open an in-page list gated by a pasted API token.
  // The list now lives in the admin portal behind a session cookie, so the tile
  // links there instead of asking anyone for a credential (#8).
  if (metric.drilldown) {
    const cta = el("a", "tile-cta", "Manage in admin portal ->");
    cta.href = ADMIN_PORTAL;
    cta.target = "_blank"; cta.rel = "noopener";
    t.appendChild(cta);
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

function isoDay(date) { return date.toISOString().slice(0, 10); }
function shiftDay(day, offset) { const d = new Date(day + "T00:00:00.000Z"); d.setUTCDate(d.getUTCDate() + offset); return isoDay(d); }
function rangeFor(days) { const end = isoDay(new Date()); return { start: shiftDay(end, 1 - days), end: end }; }
function loadSeries() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("series"); root.textContent = "";
  if (!start || !end || start > end) { root.appendChild(el("p", "muted", "Choose a valid UTC date range.")); return; }
  fetch(API + "/timeseries?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (r) { if (!r.ok) throw new Error("Could not load daily series."); return r.json(); })
    .then(function (payload) { renderSeries(payload, start, end); })
    .catch(function (err) { console.error("[ui] daily series render failed:", err); root.appendChild(el("p", "muted", "Could not load daily series.")); });
}
function renderSeries(payload, start, end) {
  const root = document.getElementById("series"); root.textContent = "";
  if (!payload.series.length) { root.appendChild(el("p", "muted", "No daily series in this range.")); return; }
  payload.series.forEach(function (series) {
    const card = el("section", "series-card");
    card.appendChild(el("h3", null, series.label));
    const updated = Date.parse(series.updated_at);
    const stale = !Number.isFinite(updated) || Date.now() - updated > series.freshness_after_hours * 3600000;
    card.appendChild(el("p", stale ? "series-meta stale" : "series-meta", series.source + " / " + series.section + " · " + series.unit + " · UTC coverage " + series.coverage_start + " to " + series.coverage_end + " · updated " + series.updated_at + " · " + (stale ? "stale" : "fresh")));
    const grouping = document.getElementById("grouping").value;
    const buckets = seriesBuckets(series, start, end, grouping);
    card.appendChild(chart(series, buckets, grouping));
    card.appendChild(valuesTable(series, buckets));
    root.appendChild(card);
  });
}
function seriesBuckets(series, start, end, grouping) {
  const values = new Map(series.points.map(function (p) { return [p.date, p.value]; }));
  const buckets = []; let cursor = start;
  while (cursor <= end) {
    let bucketEnd = cursor;
    if (grouping === "week") { const dow = new Date(cursor + "T00:00:00Z").getUTCDay(); bucketEnd = shiftDay(cursor, 6 - ((dow + 6) % 7)); }
    if (grouping === "month") { const d = new Date(cursor + "T00:00:00Z"); bucketEnd = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); }
    if (bucketEnd > end) bucketEnd = end;
    let sum = 0; let complete = true;
    for (let d = cursor; d <= bucketEnd; d = shiftDay(d, 1)) {
      if (d < series.coverage_start || d > series.coverage_end || !values.has(d)) complete = false;
      else sum += values.get(d);
    }
    buckets.push({ start: cursor, end: bucketEnd, label: cursor === bucketEnd ? cursor : cursor + " – " + bucketEnd, value: complete ? sum : null });
    cursor = shiftDay(bucketEnd, 1);
  }
  return buckets;
}
function seriesValue(value, unit) {
  if (value === null) return "Unknown";
  if (unit === "bytes") return value.toLocaleString() + " B (" + humanBytes(value) + ")";
  return Number(value).toLocaleString();
}
function valuesTable(series, buckets) {
  const details = el("details", "series-values");
  details.appendChild(el("summary", null, "Show exact values (" + buckets.length + " periods)"));
  const table = el("table", null);
  const head = el("thead", null); const heading = el("tr", null);
  heading.appendChild(el("th", null, "UTC period"));
  heading.appendChild(el("th", null, "Value (" + series.unit + ")"));
  head.appendChild(heading); table.appendChild(head);
  const body = el("tbody", null);
  buckets.forEach(function (bucket) {
    const row = el("tr", null);
    row.appendChild(el("td", null, bucket.label));
    row.appendChild(el("td", null, seriesValue(bucket.value, series.unit)));
    body.appendChild(row);
  });
  table.appendChild(body); details.appendChild(table);
  return details;
}
function chart(series, buckets, grouping) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 250"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", series.label + " by " + grouping + " in " + series.unit); svg.classList.add("series-chart");
  const observed = buckets.filter(function (b) { return b.value !== null; });
  const max = Math.max(1, ...observed.map(function (b) { return b.value; }));
  const points = buckets.map(function (b, i) { return { bucket: b, x: 58 + (i * 800 / Math.max(1, buckets.length - 1)), y: 205 - ((b.value === null ? 0 : b.value) / max) * 175, value: b.value }; });
  let path = ""; let active = false;
  points.forEach(function (p) { if (p.value === null) { active = false; return; } path += (active ? " L" : " M") + p.x + " " + p.y; active = true; });
  for (let i = 0; i <= 4; i++) {
    const y = 205 - (i * 175 / 4);
    const grid = document.createElementNS(svg.namespaceURI, "path"); grid.setAttribute("d", "M58 " + y + " H858"); grid.setAttribute("stroke", "#52606f"); grid.setAttribute("stroke-opacity", i === 0 ? "0.8" : "0.35"); grid.setAttribute("fill", "none"); svg.appendChild(grid);
    const tick = document.createElementNS(svg.namespaceURI, "text"); tick.setAttribute("x", "52"); tick.setAttribute("y", y + 4); tick.setAttribute("text-anchor", "end"); tick.textContent = series.unit === "bytes" ? humanBytes(max * i / 4) : Math.round(max * i / 4).toLocaleString(); svg.appendChild(tick);
  }
  if (path) { const line = document.createElementNS(svg.namespaceURI, "path"); line.setAttribute("d", path); line.setAttribute("stroke", "#4aa3ff"); line.setAttribute("stroke-width", "3"); line.setAttribute("fill", "none"); svg.appendChild(line); }
  points.forEach(function (p, i) {
    if (p.value !== null) {
      const dot = document.createElementNS(svg.namespaceURI, "circle"); dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("r", "3"); dot.setAttribute("fill", "#4aa3ff"); dot.setAttribute("tabindex", "0"); dot.setAttribute("aria-label", p.bucket.label + ": " + seriesValue(p.value, series.unit));
      const title = document.createElementNS(svg.namespaceURI, "title"); title.textContent = p.bucket.label + " · " + seriesValue(p.value, series.unit); dot.appendChild(title); svg.appendChild(dot);
    }
    if (buckets.length < 20 || i % Math.ceil(buckets.length / 12) === 0) { const label = document.createElementNS(svg.namespaceURI, "text"); label.setAttribute("x", p.x); label.setAttribute("y", "230"); label.setAttribute("text-anchor", "middle"); label.textContent = p.bucket.start.slice(5); svg.appendChild(label); }
  });
  const gap = buckets.some(function (b) { return b.value === null; });
  const knownTotal = observed.reduce(function (a, b) { return a + b.value; }, 0);
  const note = document.createElementNS(svg.namespaceURI, "text"); note.setAttribute("x", "58"); note.setAttribute("y", "18"); note.textContent = (gap ? "Known total · " : "Range total · ") + seriesValue(knownTotal, series.unit) + (gap ? " · gaps are unknown" : ""); svg.appendChild(note);
  return svg;
}

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

load();
const initialRange = rangeFor(30);
document.getElementById("range-start").value = initialRange.start;
document.getElementById("range-end").value = initialRange.end;
document.querySelectorAll("[data-range]").forEach(function (button) { button.addEventListener("click", function () { const r = rangeFor(Number(button.dataset.range)); document.getElementById("range-start").value = r.start; document.getElementById("range-end").value = r.end; loadSeries(); }); });
document.getElementById("range-start").addEventListener("change", loadSeries);
document.getElementById("range-end").addEventListener("change", loadSeries);
document.getElementById("grouping").addEventListener("change", loadSeries);
loadSeries();
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
header .portal { color: var(--muted); font-size: 13px; text-decoration: none;
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; }
header .portal:hover { color: var(--fg); border-color: var(--accent); }
main { padding: 20px 24px 60px; max-width: 1200px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px 18px 18px; margin-bottom: 18px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.card-head .src { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.tile { background: var(--panel-2); border: 1px solid var(--border); border-left-width: 3px;
  border-radius: 10px; padding: 12px 13px; }
.tile.sev-ok { border-left-color: var(--ok); }
.tile.sev-warn { border-left-color: var(--warn); }
.tile.sev-error { border-left-color: var(--error); }
.tile.sev-info { border-left-color: var(--info); }
.tile-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.tile-label { color: var(--muted); font-size: 12.5px; margin-bottom: 6px; }
.tile-status { border-radius: 4px; flex: none; font-size: 9px; font-weight: 700; letter-spacing: .04em; padding: 2px 5px; text-transform: uppercase; }
.tile-status.status-warn { background: rgba(210,153,34,.16); color: #f0c65a; }
.tile-status.status-error { background: rgba(248,81,73,.16); color: #ff8178; }
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
.series-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 16px; }
.series-controls label { display: grid; color: var(--muted); font-size: 12px; gap: 3px; }
.series-controls button, .series-controls input, .series-controls select { color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.series-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin: 12px 0; padding: 14px; overflow: hidden; }
.series-card h3 { margin: 0; font-size: 14px; }
.series-meta { color: var(--muted); font-size: 11px; margin: 4px 0; }
.series-meta.stale { color: var(--warn); }
.series-chart { display: block; width: 100%; min-height: 150px; }
.series-chart text { fill: var(--muted); font-size: 11px; }
.series-values { color: var(--muted); font-size: 12px; margin-top: 8px; }
.series-values summary { cursor: pointer; }
.series-values table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.series-values th, .series-values td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.series-values th:last-child, .series-values td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 600px) { header { padding: 12px; flex-wrap: wrap; } main { padding: 14px 12px 40px; } #meta { display: none; } }
`;

export function renderDashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NEMAR Observability</title><meta name="robots" content="noindex"><style>${STYLES}</style></head><body><header><h1>NEMAR Observability</h1><span class="sub">dataset &amp; pipeline health</span><span class="spacer"></span><span id="meta"></span><a class="portal" href="https://app.nemar.org/admin" target="_blank" rel="noopener">Admin portal &rarr;</a></header><main><div id="sections"></div><section class="card"><h2>Daily usage</h2><div class="series-controls"><button type="button" data-range="7">7 days</button><button type="button" data-range="30">30 days</button><button type="button" data-range="90">90 days</button><button type="button" data-range="365">365 days</button><label>Start (UTC)<input id="range-start" type="date"></label><label>End (UTC)<input id="range-end" type="date"></label><label>Group<select id="grouping"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label></div><div id="series" aria-live="polite"></div></section></main><script>${CLIENT_JS}</script></body></html>`;
}
