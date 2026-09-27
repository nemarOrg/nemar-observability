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
// Enough rows for the full size histogram (23 log bins). Truncating a histogram
// misrepresents the distribution rather than merely abbreviating it; the older
// cap of 8 also clipped the modality list, which had no reason to be clipped.
const BREAKDOWN_MAX = 24;
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
function renderBreakdown(parent, items, unit, style) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const fmtVal = unit === "bytes" ? humanBytes : function (v) { return Number(v).toLocaleString(); };
  const ranked = style === "ranked";
  const list = el("div", "breakdown");
  items.slice(0, BREAKDOWN_MAX).forEach(function (it) {
    const row = el("div", ranked ? "bd-row bd-ranked" : "bd-row");
    row.appendChild(el("span", "bd-label", it.label));
    // A ranked list prints its value; a bar there would restate it, and one
    // dominant entry would flatten the rest into identical stubs.
    if (!ranked) {
      const barWrap = el("span", "bd-bar");
      const bar = el("span", "bd-fill");
      bar.style.width = Math.max(2, (it.value / max) * 100) + "%";
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
    }
    row.appendChild(el("span", "bd-val", fmtVal(it.value)));
    list.appendChild(row);
  });
  if (items.length > BREAKDOWN_MAX) list.appendChild(el("div", "bd-more", "+" + (items.length - BREAKDOWN_MAX) + " more"));
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
  if (metric.breakdown && metric.breakdown.length) renderBreakdown(t, metric.breakdown, metric.breakdown_unit || metric.unit, metric.breakdown_style);
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
    const grid = el("div", "tiles" + (section.layout === "split" ? " split" : ""));
    section.metrics.forEach(function (m) { grid.appendChild(tile(m)); });
    card.appendChild(grid);
    root.appendChild(card);
  });
  const ts = el("span", null, "Latest state generated " + new Date(snap.generated_at).toLocaleString());
  const meta = document.getElementById("health-meta");
  meta.textContent = "";
  meta.appendChild(ts);
}

function isoDay(date) { return date.toISOString().slice(0, 10); }
function shiftDay(day, offset) { const d = new Date(day + "T00:00:00.000Z"); d.setUTCDate(d.getUTCDate() + offset); return isoDay(d); }
function rangeFor(days) { const end = shiftDay(isoDay(new Date()), -1); return { start: shiftDay(end, 1 - days), end: end }; }
let audienceRequestId = 0;
function audienceNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unknown";
}
function audienceStatus(status) {
  const labels = { available: "Measured", partial: "Partial coverage", unconfigured: "Not configured", unavailable: "Unavailable" };
  return labels[status] || "Unknown status";
}
function audienceMeasure(parent, label, value) {
  const card = el("div", "audience-measure");
  card.appendChild(el("span", "audience-measure-label", label));
  card.appendChild(el("strong", "audience-measure-value", audienceNumber(value)));
  parent.appendChild(card);
}
function audienceCountries(parent, rows, showCountries) {
  const section = el("div", "audience-countries");
  section.appendChild(el("h4", null, "Country breakdown"));
  if (!showCountries) {
    section.appendChild(el("p", "muted", "Country breakdowns are available only for single-day selections."));
    parent.appendChild(section);
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    section.appendChild(el("p", "muted", "No country values were returned. This does not mean there was no activity."));
    parent.appendChild(section);
    return;
  }
  const max = rows.reduce(function (largest, row) {
    return typeof row.value === "number" && Number.isFinite(row.value) ? Math.max(largest, row.value) : largest;
  }, 0) || 1;
  const list = el("div", "audience-country-list");
  rows.forEach(function (item) {
    if (!item || typeof item.label !== "string") return;
    const row = el("div", "audience-country-row");
    row.appendChild(el("span", "audience-country-label", item.label));
    const track = el("span", "audience-country-track");
    const fill = el("span", "audience-country-fill");
    const value = typeof item.value === "number" && Number.isFinite(item.value) ? item.value : 0;
    fill.style.width = Math.max(2, (value / max) * 100) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("strong", "audience-country-value", audienceNumber(item.value)));
    list.appendChild(row);
  });
  section.appendChild(list);
  parent.appendChild(section);
}
function audienceSourceCard(title, source, definitions, metrics, showCountries) {
  const card = el("article", "audience-source");
  const heading = el("div", "audience-source-heading");
  heading.appendChild(el("h3", null, title));
  const statusClass = ["available", "partial", "unconfigured", "unavailable"].indexOf(source.status) >= 0 ? source.status : "unknown";
  heading.appendChild(el("span", "audience-status audience-status-" + statusClass, audienceStatus(source.status)));
  card.appendChild(heading);
  card.appendChild(el("p", "audience-definition", definitions));
  const coverage = source.coverage && source.coverage.start && source.coverage.end
    ? "Measured coverage: " + source.coverage.start + " to " + source.coverage.end + " UTC"
    : "Measured coverage: unavailable";
  card.appendChild(el("p", "audience-coverage", coverage));
  const measures = el("div", "audience-measures");
  metrics.forEach(function (metric) { audienceMeasure(measures, metric.label, source[metric.key]); });
  card.appendChild(measures);
  audienceCountries(card, source.countries, showCountries);
  if (source.suppressed_small_countries) card.appendChild(el("p", "audience-note", "Small country values were withheld; values below 10 are combined only when their total reaches 10."));
  if (source.note) card.appendChild(el("p", "audience-note", source.note));
  return card;
}
function renderAudience(payload) {
  const root = document.getElementById("audience");
  root.textContent = "";
  const singleDay = payload.start === payload.end;
  const observedAt = typeof payload.observed_at === "string" ? new Date(payload.observed_at) : null;
  const observationLabel =
    observedAt && Number.isFinite(observedAt.getTime())
      ? "Sources observed at " + observedAt.toISOString() + " (UTC)"
      : "Source observation time unavailable.";
  root.appendChild(el("p", "audience-observed", observationLabel));
  root.appendChild(
    el(
      "p",
      "audience-range-note",
      singleDay
        ? "Country breakdowns are shown for this single UTC day."
        : "Country breakdowns are withheld for multi-day ranges to prevent overlapping-range differencing. Visitors and request totals still cover the selected range.",
    ),
  );
  const grid = el("div", "audience-grid");
  grid.appendChild(audienceSourceCard(
    "What website activity is recorded?",
    payload.umami,
    "Umami visitors are anonymous unique-session estimates, not identified people. Visits use a separate visit identifier. Country estimates are not an exclusive partition; unreported countries are omitted.",
    [
      { key: "visitors", label: "Visitors (unique sessions)" },
      { key: "visits", label: "Visits" },
      { key: "pageviews", label: "Page views" }
    ],
    singleDay
  ));
  grid.appendChild(audienceSourceCard(
    "Where do Cloudflare requests come from?",
    payload.cloudflare,
    "Counts are zone-wide Cloudflare HTTP requests by country. They can include bots and repeat clients; they are not unique visitors or completed downloads. Unreported country values are omitted.",
    [{ key: "requests", label: "Edge requests" }],
    singleDay
  ));
  root.appendChild(grid);
}
function loadAudience() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("audience");
  const requestId = ++audienceRequestId;
  root.textContent = "";
  if (!start || !end || start > end) {
    root.appendChild(el("p", "muted", "Choose a valid UTC date range."));
    return;
  }
  const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000 + 1;
  if (!Number.isFinite(days) || days > 3660) {
    root.appendChild(el("p", "muted", "Choose a valid UTC date range of 3,660 days or fewer."));
    return;
  }
  root.appendChild(el("p", "muted", "Loading audience and country metrics…"));
  fetch(API + "/audience?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load audience metrics.");
      return response.json();
    })
    .then(function (payload) {
      if (requestId !== audienceRequestId) return;
      if (document.getElementById("range-start").value !== start || document.getElementById("range-end").value !== end) return;
      renderAudience(payload);
    })
    .catch(function () {
      if (requestId !== audienceRequestId) return;
      root.textContent = "";
      root.appendChild(el("p", "muted", "Could not load audience metrics."));
    });
}
function loadSelectedRange() { loadSeries(); loadAudience(); }
let seriesRequestId = 0;
let pendingSeriesRange = null;
let cachedSeriesRange = null;
function loadSeries() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("series"); root.textContent = "";
  const requestId = ++seriesRequestId;
  pendingSeriesRange = null;
  if (!start || !end || start > end) { root.appendChild(el("p", "muted", "Choose a valid UTC date range.")); return; }
  const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000 + 1;
  if (!Number.isFinite(days) || days > 3660) {
    root.appendChild(el("p", "muted", "Choose a valid UTC date range of 3,660 days or fewer."));
    return;
  }
  if (cachedSeriesRange && cachedSeriesRange.start === start && cachedSeriesRange.end === end) {
    renderSeries(cachedSeriesRange.payload, start, end);
    return;
  }
  pendingSeriesRange = { start: start, end: end, requestId: requestId };
  fetch(API + "/timeseries?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return null; }).then(function (body) {
        throw new Error(body && body.error ? body.error : "Could not load daily series.");
      });
    })
    .then(function (payload) {
      if (requestId !== seriesRequestId) return;
      if (document.getElementById("range-start").value !== start || document.getElementById("range-end").value !== end) return;
      cachedSeriesRange = { start: start, end: end, payload: payload };
      renderSeries(payload, start, end);
    })
    .catch(function (err) {
      if (requestId !== seriesRequestId) return;
      console.error("[ui] daily series render failed:", err);
      root.appendChild(el("p", "muted", err && err.message ? err.message : "Could not load daily series."));
    })
    .finally(function () {
      if (pendingSeriesRange && pendingSeriesRange.requestId === requestId) pendingSeriesRange = null;
    });
}
function regroupSeries() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  if (cachedSeriesRange && cachedSeriesRange.start === start && cachedSeriesRange.end === end) {
    renderSeries(cachedSeriesRange.payload, start, end);
    return;
  }
  if (pendingSeriesRange && pendingSeriesRange.start === start && pendingSeriesRange.end === end) return;
  loadSeries();
}
function renderSeries(payload, start, end) {
  const root = document.getElementById("series"); root.textContent = "";
  const today = isoDay(new Date());
  const rangeNote = document.getElementById("range-note");
  rangeNote.textContent = end === today
    ? "This custom range includes today (UTC), which may be incomplete. Presets include complete UTC days through yesterday."
    : "Presets include complete UTC days through yesterday. Custom ranges use UTC dates and may include today.";
  if (!payload.series.length) { root.appendChild(el("p", "muted", "No reporting series were returned for this range. Coverage is unavailable here; this does not mean usage was zero.")); return; }
  const groups = new Map();
  payload.series.forEach(function (series) {
    const plane = seriesPlane(series);
    if (!groups.has(plane.key)) groups.set(plane.key, { plane: plane, series: [] });
    groups.get(plane.key).series.push(series);
  });
  groups.forEach(function (group) {
    const card = el("section", "series-card");
    card.appendChild(el("h3", null, group.plane.label));
    group.series.forEach(function (series, index) {
      const measure = index === 0 ? card : el("article", "series-measure");
      measure.appendChild(el("h4", null, series.label));
      const lastDay = series.latest_observation_date;
      const lastPeriodEnd = lastDay ? Date.parse(lastDay + "T00:00:00Z") + 86400000 : NaN;
      const stale = !Number.isFinite(lastPeriodEnd) || Date.now() - lastPeriodEnd > series.freshness_after_hours * 3600000;
      const grouping = document.getElementById("grouping").value;
      const buckets = seriesBuckets(series, start, end, grouping);
      measure.appendChild(chart(series, buckets, grouping, start, end, group.plane.description));
      if (index === 0) measure.appendChild(el("p", "plane-description", group.plane.description));
      measure.appendChild(el("p", stale ? "series-meta stale" : "series-meta", "Source " + series.source + " · " + series.unit + " per UTC day · declared coverage " + series.coverage_start + " to " + series.coverage_end + " · latest observed day " + (lastDay || "none") + " · last received by dashboard " + series.updated_at + " · " + (stale ? "stale" : "fresh")));
      measure.appendChild(valuesTable(series, buckets));
      if (index > 0) card.appendChild(measure);
    });
    root.appendChild(card);
  });
}
function seriesPlane(series) {
  const key = String(series.section || "").toLowerCase();
  if (key === "website") return { key: "website", label: "What activity is recorded on the website?", description: "Anonymous browser analytics record page views and action events. These are events, not unique people." };
  if (key === "access") return { key: "access", label: "How is data accessed through NEMAR?", description: "Server-side access counts represent requests or redirects. Archive redirects do not confirm completed downloads; response bytes are shown only where the server records them." };
  if (key === "cf") return { key: "cf", label: "What traffic reaches the Cloudflare edge?", description: "Edge requests and bytes can include bots and repeat clients. They do not represent unique people or completed downloads." };
  if (key === "egress") return { key: "egress", label: "How many bytes did S3 return?", description: "Bucket-level response bytes include conversion reads and do not identify a caller or prove a completed human download." };
  const section = series.section || "unknown section";
  return { key: "other:" + section, label: "Additional source: " + section, description: "Source " + (series.source || "unknown") + " reports its own additive daily measures. Measures remain separate; missing observations are unknown, not zero." };
}
function seriesBuckets(series, start, end, grouping) {
  const values = new Map(series.points.map(function (p) { return [p.date, p.value]; }));
  const buckets = []; let cursor = start;
  while (cursor <= end) {
    let calendarStart = cursor;
    let calendarEnd = cursor;
    if (grouping === "week") {
      const dow = new Date(cursor + "T00:00:00Z").getUTCDay();
      calendarStart = shiftDay(cursor, -((dow + 6) % 7));
      calendarEnd = shiftDay(calendarStart, 6);
    }
    if (grouping === "month") {
      const d = new Date(cursor + "T00:00:00Z");
      calendarStart = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
      calendarEnd = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    }
    const bucketStart = cursor > calendarStart ? cursor : calendarStart;
    const bucketEnd = end < calendarEnd ? end : calendarEnd;
    const partial = bucketStart !== calendarStart || bucketEnd !== calendarEnd;
    let sum = 0; let complete = true;
    for (let d = bucketStart; d <= bucketEnd; d = shiftDay(d, 1)) {
      if (d < series.coverage_start || d > series.coverage_end || !values.has(d)) complete = false;
      else sum += values.get(d);
    }
    const label = partial
      ? "Partial " + (grouping === "week" ? "week" : grouping === "month" ? "month" : "period") + " (" + bucketStart + (bucketStart === bucketEnd ? "" : " – " + bucketEnd) + ")"
      : grouping === "month"
        ? new Date(bucketStart + "T00:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
        : grouping === "week" ? "Week " + bucketStart + " – " + bucketEnd
          : bucketStart;
    buckets.push({ start: bucketStart, end: bucketEnd, label: label, value: complete ? sum : null, partial: partial });
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
function chart(series, buckets, grouping, start, end, description) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 250"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", series.label + " by " + grouping + " in " + series.unit);
  svg.setAttribute("aria-description", description);
  svg.classList.add("series-chart");
  const partialPeriods = buckets.filter(function (bucket) { return bucket.partial; }).map(function (bucket) { return bucket.label; });
  if (partialPeriods.length) {
    const description = document.createElementNS(svg.namespaceURI, "desc");
    description.textContent = "Partial calendar buckets: " + partialPeriods.join("; ");
    svg.appendChild(description);
  }
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
    if (buckets.length < 20 || i % Math.ceil(buckets.length / 12) === 0) { const label = document.createElementNS(svg.namespaceURI, "text"); label.setAttribute("x", p.x); label.setAttribute("y", "230"); label.setAttribute("text-anchor", "middle"); label.textContent = start.slice(0, 4) === end.slice(0, 4) ? p.bucket.start.slice(5) : p.bucket.start; svg.appendChild(label); }
  });
  const gap = buckets.some(function (b) { return b.value === null; });
  const observedPoints = series.points.filter(function (point) { return point.date >= start && point.date <= end; });
  const observedTotal = observedPoints.reduce(function (sum, point) { return sum + point.value; }, 0);
  const totalLabel = observedPoints.length === 0
    ? "Range total · Unknown (no observations)"
    : (gap ? "Observed total · " : "Range total · ") + seriesValue(observedTotal, series.unit) + (gap ? " · incomplete buckets plot as gaps" : "");
  const note = document.createElementNS(svg.namespaceURI, "text"); note.setAttribute("x", "58"); note.setAttribute("y", "18"); note.textContent = totalLabel; svg.appendChild(note);
  return svg;
}

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("health-meta").textContent = "Could not load latest-state snapshot.";
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

load();
const initialRange = rangeFor(30);
document.getElementById("range-start").value = initialRange.start;
document.getElementById("range-end").value = initialRange.end;
document.querySelectorAll("[data-range]").forEach(function (button) { button.addEventListener("click", function () { const r = rangeFor(Number(button.dataset.range)); document.getElementById("range-start").value = r.start; document.getElementById("range-end").value = r.end; loadSelectedRange(); }); });
document.getElementById("range-start").addEventListener("change", loadSelectedRange);
document.getElementById("range-end").addEventListener("change", loadSelectedRange);
document.getElementById("grouping").addEventListener("change", regroupSeries);
loadSelectedRange();
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
/* Distribution + companion list: ~2/3 and ~1/3, stacking on narrow screens. */
.tiles.split { grid-template-columns: 2fr 1fr; }
@media (max-width: 720px) { .tiles.split { grid-template-columns: 1fr; } }
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
.bd-row { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; font-size: 11.5px; }
.bd-ranked { grid-template-columns: 1fr auto; gap: 12px; }
.bd-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: #0c1015; height: 7px; border-radius: 4px; overflow: hidden; }
.bd-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.bd-val { text-align: right; color: var(--fg); white-space: nowrap; }
.bd-more { color: var(--muted); font-size: 11px; margin-top: 2px; }
.muted { color: var(--muted); }
.errbar { background: rgba(248,81,73,.12); border: 1px solid var(--error); color: #ffd7d4;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.errbar-hint { color: var(--muted); }
.series-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 16px; }
.series-controls label { display: grid; color: var(--muted); font-size: 12px; gap: 3px; }
.series-controls button, .series-controls input, .series-controls select { color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.audience-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.audience-source { min-width: 0; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 13px; }
.audience-source-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.audience-source h3 { margin: 0; font-size: 14px; }
.audience-status { flex: none; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 650; }
.audience-status-available { background: rgba(46,160,67,.16); color: #65d17a; }
.audience-status-partial { background: rgba(210,153,34,.16); color: #f0c65a; }
.audience-status-unconfigured, .audience-status-unavailable, .audience-status-unknown { background: rgba(139,151,166,.16); color: var(--muted); }
.audience-definition, .audience-coverage, .audience-note { color: var(--muted); font-size: 11.5px; line-height: 1.45; margin: 8px 0; }
.audience-observed, .audience-range-note { color: var(--muted); font-size: 11.5px; margin: 0 0 8px; }
.audience-measures { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 12px 0; }
.audience-measure { display: grid; gap: 3px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
.audience-measure-label { color: var(--muted); font-size: 10.5px; }
.audience-measure-value { font-size: 18px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.audience-countries { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 8px; }
.audience-countries h4 { font-size: 12px; margin: 0 0 8px; }
.audience-country-list { display: grid; gap: 5px; }
.audience-country-row { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(50px, 1.4fr) auto; align-items: center; gap: 8px; font-size: 11px; }
.audience-country-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audience-country-track { height: 7px; background: #0c1015; border-radius: 5px; overflow: hidden; }
.audience-country-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.audience-country-value { min-width: 54px; text-align: right; font-variant-numeric: tabular-nums; }
.audience-note { margin-bottom: 0; }
.series-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin: 18px 0 12px; padding: 14px; overflow: hidden; }
.series-card h3 { margin: 0; font-size: 15px; }
.series-card h4, .series-measure h4 { margin: 4px 0 0; font-size: 14px; }
.series-measure { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 10px; }
.plane-description { color: var(--muted); font-size: 12px; margin: 3px 0 8px; }
.health-intro { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.health-meta { color: var(--muted); font-size: 12px; margin: -4px 0 12px; }
.range-note { color: var(--muted); font-size: 12px; margin: -8px 0 12px; }
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
@media (max-width: 720px) { .audience-grid { grid-template-columns: 1fr; } }
`;

export function renderDashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NEMAR Observability</title><meta name="robots" content="noindex"><style>${STYLES}</style></head><body><header><h1>NEMAR Observability</h1><span class="sub">usage and latest dataset &amp; pipeline health</span><span class="spacer"></span><a class="portal" href="https://app.nemar.org/admin" target="_blank" rel="noopener">Admin portal &rarr;</a></header><main><section class="card"><h2>How is NEMAR being used?</h2><p class="health-intro">Explore daily activity from each reporting source. Counts and bytes stay separate; this view does not add daily unique-visitor counts.</p><div class="series-controls"><button type="button" data-range="7">7 complete days</button><button type="button" data-range="30">30 complete days</button><button type="button" data-range="90">90 complete days</button><button type="button" data-range="365">365 complete days</button><label>Start date (UTC)<input id="range-start" type="date"></label><label>End date (UTC)<input id="range-end" type="date"></label><label>Group by<select id="grouping"><option value="day">Day</option><option value="week">Calendar week</option><option value="month">Calendar month</option></select></label></div><p id="range-note" class="range-note">Presets include complete UTC days through yesterday. Custom ranges use UTC dates and may include today.</p><p class="range-note">Day, week, and month grouping applies only to additive time series. Audience metrics are queried as selected-range totals.</p><div id="series" aria-live="polite"></div></section><section class="card"><h2>Where do visitors and requests come from?</h2><p class="health-intro">Country and summary values use the selected UTC dates. Umami session estimates and Cloudflare request counts are separate measures.</p><div id="audience" aria-live="polite"><p class="muted">Loading audience metrics…</p></div></section><section class="card"><h2>What is the latest state of datasets and pipelines?</h2><p class="health-intro">These health panels show the latest point-in-time snapshot. They do not change with the usage date range.</p><p id="health-meta" class="health-meta" aria-live="polite">Loading latest-state snapshot…</p><div id="sections"></div></section></main><script>${CLIENT_JS}</script></body></html>`;
}
