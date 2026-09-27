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

import {
  WORLD_COUNTRY_CODES_BY_NAME,
  WORLD_COUNTRY_NAMES,
  WORLD_COUNTRY_PATHS,
} from "../lib/world-map";

const WORLD_COUNTRY_PATHS_JSON = JSON.stringify(WORLD_COUNTRY_PATHS);
const WORLD_COUNTRY_NAMES_JSON = JSON.stringify(WORLD_COUNTRY_NAMES);
const WORLD_COUNTRY_CODES_BY_NAME_JSON = JSON.stringify(WORLD_COUNTRY_CODES_BY_NAME);

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
  const u = ["B","kB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
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
function infoDisclosure(label, content) {
  const details = el("details", "info-disclosure");
  const summary = el("summary", "info-icon", "i");
  summary.setAttribute("aria-label", label);
  details.appendChild(summary);
  details.appendChild(el("span", "info-content", content));
  return details;
}

// A breakdown can be denominated differently from its tile: "Most read
// datasets" is a count of datasets whose bars are bytes each. metric.breakdown_unit
// carries that; absent, the bars share the tile's unit.
function renderBreakdown(parent, items, unit, style) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const fmtVal = unit === "bytes" ? humanBytes : function (v) { return Number(v).toLocaleString(); };
  const ranked = style === "ranked";
  const list = el("div", "breakdown");
  function appendRows(target, rows) {
    rows.forEach(function (it) {
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
      target.appendChild(row);
    });
  }
  const visibleCount = ranked ? 5 : BREAKDOWN_MAX;
  appendRows(list, items.slice(0, visibleCount));
  parent.appendChild(list);
  if (ranked && items.length > visibleCount) {
    const details = el("details", "breakdown-more");
    details.appendChild(el("summary", null, "Show all " + items.length + " datasets"));
    const remaining = el("div", "breakdown");
    appendRows(remaining, items.slice(visibleCount, BREAKDOWN_MAX));
    details.appendChild(remaining);
    if (items.length > BREAKDOWN_MAX) details.appendChild(el("div", "bd-more", "+" + (items.length - BREAKDOWN_MAX) + " more"));
    parent.appendChild(details);
  }
}

function tile(metric) {
  const t = el("div", "tile sev-" + (metric.severity || "info"));
  const heading = el("div", "tile-heading");
  heading.appendChild(el("div", "tile-label", metric.label));
  if (metric.hint) heading.appendChild(infoDisclosure("About " + metric.label, metric.hint));
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
function audienceSourceCard(title, source, definitions, metrics) {
  const card = el("article", "audience-source");
  const heading = el("div", "audience-source-heading");
  heading.appendChild(el("h3", null, title));
  const statusClass = ["available", "partial", "unconfigured", "unavailable"].indexOf(source.status) >= 0 ? source.status : "unknown";
  heading.appendChild(el("span", "audience-status audience-status-" + statusClass, audienceStatus(source.status)));
  heading.appendChild(infoDisclosure("About " + title, definitions));
  card.appendChild(heading);
  const measures = el("div", "audience-measures");
  metrics.forEach(function (metric) { audienceMeasure(measures, metric.label, source[metric.key]); });
  card.appendChild(measures);
  const details = el("details", "audience-source-details");
  details.appendChild(el("summary", null, "Coverage and source details"));
  const coverage = source.coverage && source.coverage.start && source.coverage.end
    ? source.coverage.start + " to " + source.coverage.end + " UTC"
    : "Unavailable";
  details.appendChild(el("p", "audience-coverage", "Measured coverage: " + coverage));
  if (source.note) details.appendChild(el("p", "audience-note", source.note));
  card.appendChild(details);
  return card;
}
function audienceEvents(parent, report) {
  const section = el("details", "audience-events");
  const status = report && typeof report.status === "string" ? report.status : "unavailable";
  section.appendChild(el("summary", null, "Website interactions · " + audienceStatus(status)));
  section.appendChild(infoDisclosure("About website interactions", "Events are recorded only after consent. Event-associated visitors are anonymous distinct sessions, not identified people."));
  const coverage = report && report.coverage && report.coverage.start && report.coverage.end
    ? "Verified event coverage: " + report.coverage.start + " to " + report.coverage.end + " UTC"
    : "Verified event coverage: unavailable";
  section.appendChild(el("p", "audience-coverage", coverage));

  const labels = {
    citation_click: "Citation clicks",
    viewer_open: "Viewer opens",
    viewer_interaction: "Viewer interactions",
    upload_started: "Upload starts",
    upload_completed: "Upload completions"
  };
  const rows = Array.isArray(report && report.metrics) ? report.metrics : [];
  const table = el("table", "audience-event-table");
  const headRow = el("tr");
  ["Interaction", "Events", "Anonymous sessions"].forEach(function (label) {
    headRow.appendChild(el("th", null, label));
  });
  const thead = el("thead"); thead.appendChild(headRow); table.appendChild(thead);
  const body = el("tbody");
  rows.forEach(function (metric) {
    if (!metric || !Object.prototype.hasOwnProperty.call(labels, metric.name)) return;
    const row = el("tr");
    row.appendChild(el("th", null, labels[metric.name]));
    row.appendChild(el("td", null, audienceNumber(metric.events)));
    row.appendChild(el("td", null, audienceNumber(metric.visitors)));
    body.appendChild(row);
  });
  table.appendChild(body);
  section.appendChild(table);
  if (report && report.note) section.appendChild(el("p", "audience-note", report.note));
  parent.appendChild(section);
}
function renderAudience(payload) {
  const root = document.getElementById("audience");
  root.textContent = "";
  const observedAt = typeof payload.observed_at === "string" ? new Date(payload.observed_at) : null;
  const observationLabel =
    observedAt && Number.isFinite(observedAt.getTime())
      ? observedAt.toISOString()
      : "unavailable";
  const details = el("details", "audience-observation-details");
  details.appendChild(el("summary", null, "How these measures work"));
  details.appendChild(el("p", "audience-note", "Selected-range totals are queried from each source; visitors and sessions are not added across days. Country location data is available in the map for one completed UTC day, with small values withheld."));
  details.appendChild(el("p", "audience-coverage", "Sources last checked: " + observationLabel + " (UTC)."));
  root.appendChild(details);
  const grid = el("div", "audience-grid");
  const umamiCard = audienceSourceCard(
    "Website activity",
    payload.umami,
    "Umami visitors are anonymous unique-session estimates, not identified people. Visits use a separate visit identifier. Country estimates are not an exclusive partition; unreported countries are omitted.",
    [
      { key: "visitors", label: "Visitors (unique sessions)" },
      { key: "visits", label: "Visits" },
      { key: "pageviews", label: "Page views" }
    ]
  );
  audienceEvents(umamiCard, payload.umami.event_metrics);
  grid.appendChild(umamiCard);
  grid.appendChild(audienceSourceCard(
    "Cloudflare edge requests",
    payload.cloudflare,
    "Counts are zone-wide Cloudflare HTTP requests by country. They can include bots and repeat clients; they are not unique visitors or completed downloads. Unreported country values are omitted.",
    [{ key: "requests", label: "Requests" }]
  ));
  root.appendChild(grid);
}
let geographyRequestId = 0;
let geographySourceKey = "cloudflare";
function normalizeCountryLabel(label) {
  return typeof label === "string"
    ? label.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/gi, "").toLowerCase()
    : "";
}
function countryCode(label) {
  if (typeof label !== "string") return null;
  const code = label.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code) && WORLD_COUNTRY_PATHS[code]) return code;
  const mappedCode = WORLD_COUNTRY_CODES_BY_NAME[normalizeCountryLabel(label)];
  return typeof mappedCode === "string" ? mappedCode : null;
}
function countryName(label) {
  const code = countryCode(label);
  if (!code) return label;
  return (WORLD_COUNTRY_NAMES[code] && WORLD_COUNTRY_NAMES[code][0]) || label;
}
function geographySources(payload) {
  return [
    { key: "cloudflare", label: "Cloudflare requests", unit: "requests", source: payload.cloudflare },
    { key: "umami", label: "Website sessions", unit: "anonymous sessions", source: payload.umami }
  ];
}
function hasCountryData(item) {
  return (Array.isArray(item.source.countries) && item.source.countries.length > 0)
    || item.source.suppressed_small_countries === true;
}
function renderGeography(payload, date) {
  const root = document.getElementById("geography");
  root.textContent = "";
  const sources = geographySources(payload);
  const requested = sources.find(function (item) { return item.key === geographySourceKey; });
  const active = (requested && hasCountryData(requested) ? requested : null)
    || sources.find(hasCountryData)
    || requested
    || sources[0];
  geographySourceKey = active.key;
  const sourceTabs = el("div", "geography-sources");
  sourceTabs.setAttribute("role", "group");
  sourceTabs.setAttribute("aria-label", "Choose a location data source");
  sources.forEach(function (item) {
    const button = el("button", "geography-source", item.label);
    const hasValues = hasCountryData(item);
    const available = item.source.status === "available" || item.source.status === "partial";
    button.type = "button";
    button.disabled = !available || !hasValues;
    button.setAttribute("aria-pressed", String(item.key === active.key));
    button.appendChild(el("span", "geography-source-status", audienceStatus(item.source.status)));
    button.addEventListener("click", function () {
      geographySourceKey = item.key;
      renderGeography(payload, date);
    });
    sourceTabs.appendChild(button);
  });
  root.appendChild(sourceTabs);

  const countries = Array.isArray(active.source.countries) ? active.source.countries : [];
  const coded = new Map();
  countries.forEach(function (row) {
    const code = countryCode(row && row.label);
    if (code && WORLD_COUNTRY_PATHS[code] && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) {
      coded.set(code, (coded.get(code) || 0) + row.value);
    }
  });
  const maximum = Math.max(1, ...coded.values());
  const layout = el("div", "geography-layout");
  const mapFrame = el("div", "geography-map-frame");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 500");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", active.label + " by country on " + date + " UTC");
  svg.classList.add("geography-map");
  Object.keys(WORLD_COUNTRY_PATHS).forEach(function (code) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", WORLD_COUNTRY_PATHS[code]);
    path.setAttribute("class", "map-country");
    const value = coded.get(code);
    if (value !== undefined) {
      const strength = Math.log1p(value) / Math.log1p(maximum);
      path.setAttribute("fill", "rgba(74, 163, 255, " + (0.22 + 0.78 * strength).toFixed(3) + ")");
      path.setAttribute("tabindex", "0");
      const detail = countryName(code) + ": " + audienceNumber(value) + " " + active.unit;
      path.setAttribute("aria-label", detail);
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = detail;
      path.appendChild(title);
    } else {
      path.setAttribute("fill", "#27313d");
      path.setAttribute("aria-hidden", "true");
    }
    svg.appendChild(path);
  });
  mapFrame.appendChild(svg);
  layout.appendChild(mapFrame);

  const summary = el("aside", "geography-summary");
  const values = active.source.requests ?? active.source.visitors;
  const totalLabel = active.key === "cloudflare" ? "Edge requests" : "Anonymous sessions";
  summary.appendChild(el("span", "geography-summary-label", totalLabel));
  summary.appendChild(el("strong", "geography-summary-value", audienceNumber(values)));
  summary.appendChild(el("p", "geography-summary-date", "Country activity · " + date + " UTC"));
  summary.appendChild(infoDisclosure("About location data", active.key === "cloudflare"
    ? "Cloudflare counts zone-wide edge requests, including repeat clients and automated traffic. This is not a visitor or completed-download count."
    : "Umami counts anonymous unique-session estimates. A session is not an identified person, and sessions without a reported country are not shown."));
  const hasWithheldValues = active.source.suppressed_small_countries === true;
  const hint = el("p", "geography-map-hint", coded.size
    ? "Showing reported values for " + coded.size + " countries. Small or unreported values may be omitted."
    : hasWithheldValues
      ? "Country values are withheld under the privacy threshold; no country location is shown."
      : countries.length
        ? "Country values were reported, but none match a location on the map."
        : "No country values were reported for this source and date.");
  summary.appendChild(hint);
  const legend = el("div", "geography-map-legend");
  legend.appendChild(el("span", null, "Fewer"));
  legend.appendChild(el("span", "geography-map-legend-scale"));
  legend.appendChild(el("span", null, "More"));
  summary.appendChild(legend);
  layout.appendChild(summary);
  root.appendChild(layout);

  if (countries.length) {
    const details = el("details", "geography-values");
    details.appendChild(el("summary", null, "View country totals (" + countries.length + ")"));
    const table = el("table", null);
    const head = el("thead");
    const header = el("tr");
    header.appendChild(el("th", null, "Country"));
    header.appendChild(el("th", null, active.unit));
    head.appendChild(header); table.appendChild(head);
    const body = el("tbody");
    countries.forEach(function (row) {
      const tr = el("tr");
      tr.appendChild(el("th", null, countryName(row.label)));
      tr.appendChild(el("td", null, audienceNumber(row.value)));
      body.appendChild(tr);
    });
    table.appendChild(body); details.appendChild(table); root.appendChild(details);
  }

  const sourceDetails = el("details", "geography-details");
  sourceDetails.appendChild(el("summary", null, "Coverage and map details"));
  const coverage = active.source.coverage && active.source.coverage.start && active.source.coverage.end
    ? active.source.coverage.start + " to " + active.source.coverage.end + " UTC"
    : "Unavailable";
  sourceDetails.appendChild(el("p", null, "Source " + active.label + " · coverage " + coverage + " · status " + audienceStatus(active.source.status) + "."));
  sourceDetails.appendChild(el("p", null, "The map uses one completed UTC day. Country values below 10 are grouped as “Other / withheld” only when their combined total reaches 10; smaller combined totals are omitted. NEMAR S3 byte totals are bucket-wide and have no country attribution."));
  if (active.source.note) sourceDetails.appendChild(el("p", null, active.source.note));
  root.appendChild(sourceDetails);
}
function loadGeography() {
  const input = document.getElementById("geography-date");
  const date = input.value;
  const root = document.getElementById("geography");
  const requestId = ++geographyRequestId;
  if (!date || date >= isoDay(new Date())) {
    root.textContent = "";
    root.appendChild(el("p", "muted", "Choose a completed UTC day to view locations."));
    return;
  }
  root.textContent = "";
  root.appendChild(el("p", "muted", "Loading country activity…"));
  fetch(API + "/audience?start=" + encodeURIComponent(date) + "&end=" + encodeURIComponent(date))
    .then(function (response) {
      if (!response.ok) throw new Error("Location data returned HTTP " + response.status + ".");
      return response.json();
    })
    .then(function (payload) {
      if (requestId !== geographyRequestId || input.value !== date) return;
      renderGeography(payload, date);
    })
    .catch(function (error) {
      if (requestId !== geographyRequestId) return;
      console.error("[observability] Country activity request failed", error);
      root.textContent = "";
      root.appendChild(el("p", "muted", "Could not load country activity."));
    });
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
function syncRangePresets() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  document.querySelectorAll("[data-range]").forEach(function (button) {
    const range = rangeFor(Number(button.dataset.range));
    button.setAttribute("aria-pressed", String(start === range.start && end === range.end));
  });
}
function loadSelectedRange() { syncRangePresets(); loadSeries(); loadAudience(); }
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
    ? "UTC · today may be incomplete"
    : "UTC · complete days through " + end;
  if (!payload.series.length) { root.appendChild(el("p", "muted", "No reporting series were returned for this range. Coverage is unavailable here; this does not mean usage was zero.")); return; }
  const groups = new Map();
  payload.series.forEach(function (series) {
    const plane = seriesPlane(series);
    if (!groups.has(plane.key)) groups.set(plane.key, { plane: plane, series: [] });
    groups.get(plane.key).series.push(series);
  });
  groups.forEach(function (group) {
    const card = el("section", "series-card");
    const groupHeading = el("div", "series-heading");
    groupHeading.appendChild(el("h3", null, group.plane.label));
    groupHeading.appendChild(infoDisclosure("About " + group.plane.label, group.plane.description));
    card.appendChild(groupHeading);
    group.series.forEach(function (series, index) {
      const measure = index === 0 ? card : el("article", "series-measure");
      measure.appendChild(el("h4", null, seriesDisplayLabel(series)));
      const lastDay = series.latest_observation_date;
      const lastPeriodEnd = lastDay ? Date.parse(lastDay + "T00:00:00Z") + 86400000 : NaN;
      const stale = !Number.isFinite(lastPeriodEnd) || Date.now() - lastPeriodEnd > series.freshness_after_hours * 3600000;
      const grouping = document.getElementById("grouping").value;
      const buckets = seriesBuckets(series, start, end, grouping);
      measure.appendChild(chart(series, buckets, grouping, start, end, group.plane.description));
      const sourceDetails = el("details", "series-source-details");
      sourceDetails.appendChild(el("summary", null, "Source and coverage · " + (stale ? "stale" : "current")));
      sourceDetails.appendChild(el("p", stale ? "series-meta stale" : "series-meta", "Source " + series.source + " · one value per day (UTC) · data covers " + series.coverage_start + " to " + series.coverage_end + " · latest day counted " + (lastDay || "none") + " · updated " + series.updated_at + "."));
      measure.appendChild(sourceDetails);
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
  if (key === "egress") return { key: "egress", label: "How much data did NEMAR return?", description: "Bytes returned by the NEMAR S3 bucket across all NEMAR data planes. This includes visitor reads and internal operations such as Zarr conversions, so it is not a count of completed visitor downloads. The metric has no user or country attribution." };
  const section = series.section || "unknown section";
  return { key: "other:" + section, label: "Additional source: " + section, description: "Source " + (series.source || "unknown") + " reports its own additive daily measures. Measures remain separate; missing observations are unknown, not zero." };
}
function seriesDisplayLabel(series) {
  return String(series.section || "").toLowerCase() === "egress" ? "NEMAR downloads" : series.label;
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
  if (unit === "bytes") return humanBytes(value);
  return Number(value).toLocaleString();
}
function exactSeriesValue(value, unit) {
  if (value === null) return "Unknown";
  if (unit === "bytes") return Number(value).toLocaleString() + " B";
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
    row.appendChild(el("td", null, exactSeriesValue(bucket.value, series.unit)));
    body.appendChild(row);
  });
  table.appendChild(body); details.appendChild(table);
  return details;
}
function chart(series, buckets, grouping, start, end, description) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 250"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", seriesDisplayLabel(series) + " by " + grouping + " in " + series.unit);
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
const geographyDate = shiftDay(isoDay(new Date()), -1);
document.getElementById("geography-date").value = geographyDate;
document.getElementById("geography-date").max = geographyDate;
document.getElementById("geography-date").addEventListener("change", loadGeography);
loadSelectedRange();
loadGeography();
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
main { padding: 20px 24px 60px; max-width: 1680px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 15px 16px 16px; margin-bottom: 14px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.card-head .src { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; align-items: start; }
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
.info-disclosure { position: relative; display: inline-flex; flex: none; }
.info-icon { display: inline-grid; place-items: center; width: 19px; height: 19px; border: 1px solid var(--border); border-radius: 50%; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 700; line-height: 1; list-style: none; }
.info-icon::-webkit-details-marker { display: none; }
.info-icon:hover, .info-icon:focus-visible { border-color: var(--accent); color: var(--fg); }
.info-content { position: absolute; z-index: 10; top: 25px; left: 0; width: min(320px, 78vw); padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: #111820; box-shadow: 0 8px 24px rgba(0,0,0,.35); color: var(--fg); font-size: 12px; font-weight: 400; line-height: 1.45; }
.tile .info-content { right: 0; left: auto; }
.tile-status { border-radius: 4px; flex: none; font-size: 9px; font-weight: 700; letter-spacing: .04em; padding: 2px 5px; text-transform: uppercase; }
.tile-status.status-warn { background: rgba(210,153,34,.16); color: #f0c65a; }
.tile-status.status-error { background: rgba(248,81,73,.16); color: #ff8178; }
.tile-value { display: flex; align-items: baseline; gap: 8px; }
.tile-value .v { font-size: 26px; font-weight: 680; letter-spacing: -.01em; }
.tile-value .pct { color: var(--muted); font-size: 13px; }
.pbar { height: 4px; background: #0c1015; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.pfill { height: 100%; background: var(--accent); }
.tile-cta { color: var(--accent); font-size: 12px; margin-top: 8px; }
.breakdown { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.bd-row { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; font-size: 11.5px; }
.bd-ranked { grid-template-columns: 1fr auto; gap: 12px; }
.bd-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: #0c1015; height: 7px; border-radius: 4px; overflow: hidden; }
.bd-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.bd-val { text-align: right; color: var(--fg); white-space: nowrap; }
.bd-more { color: var(--muted); font-size: 11px; margin-top: 2px; }
.breakdown-more { color: var(--muted); font-size: 11px; margin-top: 5px; }
.breakdown-more summary, .range-help summary, .audience-source-details summary, .audience-events summary, .audience-observation-details summary, .series-source-details summary, .series-values summary, .geography-values summary, .geography-details summary { cursor: pointer; }
.muted { color: var(--muted); }
.errbar { background: rgba(248,81,73,.12); border: 1px solid var(--error); color: #ffd7d4;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.errbar-hint { color: var(--muted); }
.series-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 16px; }
.series-controls label { display: grid; color: var(--muted); font-size: 12px; gap: 3px; }
.series-controls button, .series-controls input, .series-controls select { color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.series-controls button { cursor: pointer; }
.series-controls button:hover, .series-controls button:focus-visible { border-color: var(--accent); }
.series-controls button[aria-pressed="true"] { border-color: var(--accent); background: rgba(74,163,255,.14); color: var(--fg); }
.range-help { color: var(--muted); font-size: 11px; margin: -7px 0 10px; }
.range-help p { max-width: 760px; margin: 6px 0 0; }
.audience-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.audience-source { min-width: 0; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 13px; }
.audience-source-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.audience-source h3 { margin: 0; font-size: 14px; }
.audience-status { flex: none; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 650; }
.audience-status-available { background: rgba(46,160,67,.16); color: #65d17a; }
.audience-status-partial { background: rgba(210,153,34,.16); color: #f0c65a; }
.audience-status-unconfigured, .audience-status-unavailable, .audience-status-unknown { background: rgba(139,151,166,.16); color: var(--muted); }
.audience-coverage, .audience-note { color: var(--muted); font-size: 11.5px; line-height: 1.45; margin: 8px 0; }
.audience-observation-details { color: var(--muted); font-size: 11px; margin: 0 0 10px; }
.audience-source-details { color: var(--muted); font-size: 11px; margin-top: 8px; }
.audience-measures { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 12px 0; }
.audience-measure { display: grid; gap: 3px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
.audience-measure-label { color: var(--muted); font-size: 10.5px; }
.audience-measure-value { font-size: 18px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.audience-note { margin-bottom: 0; }
.audience-events { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 8px; color: var(--muted); font-size: 11px; }
.audience-events summary { display: flex; justify-content: space-between; gap: 8px; }
.audience-event-table { border-collapse: collapse; font-size: 11px; margin-top: 8px; width: 100%; }
.audience-event-table th, .audience-event-table td { border-bottom: 1px solid var(--border); padding: 5px; text-align: left; }
.audience-event-table th:not(:first-child), .audience-event-table td { font-variant-numeric: tabular-nums; }
.series-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin: 14px 0 10px; padding: 14px; }
.series-heading { display: flex; align-items: center; gap: 8px; }
.series-card h3 { margin: 0; font-size: 15px; }
.series-card h4, .series-measure h4 { margin: 4px 0 0; font-size: 14px; }
.series-measure { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 10px; }
.health-intro { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.health-meta { color: var(--muted); font-size: 12px; margin: -4px 0 12px; }
.range-note { color: var(--muted); font-size: 12px; margin: -8px 0 12px; }
.series-meta { color: var(--muted); font-size: 11px; margin: 4px 0; }
.series-meta.stale { color: var(--warn); }
.series-source-details { color: var(--muted); font-size: 11px; margin-top: 4px; }
.series-chart { display: block; width: 100%; min-height: 150px; }
.series-chart text { fill: var(--muted); font-size: 11px; }
.series-values { color: var(--muted); font-size: 12px; margin-top: 8px; }
.series-values summary { cursor: pointer; }
.series-values table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.series-values th, .series-values td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.series-values th:last-child, .series-values td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.geography-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.geography-heading h2 { margin: 0; font-size: 15px; }
.geography-heading .health-intro { margin: 4px 0 0; }
.geography-heading label { display: grid; margin-left: auto; color: var(--muted); font-size: 12px; gap: 3px; }
.geography-heading input { color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.geography-sources { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.geography-source { display: flex; align-items: center; gap: 8px; color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; cursor: pointer; font: inherit; font-size: 12px; }
.geography-source[aria-pressed="true"] { border-color: var(--accent); background: rgba(74,163,255,.12); }
.geography-source:disabled { opacity: .55; cursor: not-allowed; }
.geography-source-status { color: var(--muted); font-size: 10px; }
.geography-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(190px, .65fr); gap: 14px; align-items: center; }
.geography-map-frame { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: #111820; }
.geography-map { display: block; width: 100%; height: auto; }
.map-country { stroke: #111820; stroke-width: 1; stroke-linejoin: round; }
.map-country[tabindex="0"] { cursor: pointer; }
.map-country[tabindex="0"]:hover, .map-country[tabindex="0"]:focus { stroke: var(--fg); stroke-width: 2; outline: none; }
.geography-summary { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); }
.geography-summary-label, .geography-summary-date { color: var(--muted); font-size: 11px; }
.geography-summary-value { font-size: 24px; font-variant-numeric: tabular-nums; }
.geography-summary-date, .geography-map-hint, .geography-map-legend { margin: 0; }
.geography-map-hint { color: var(--muted); font-size: 11px; }
.geography-map-legend { display: grid; grid-template-columns: auto minmax(50px, 1fr) auto; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; }
.geography-map-legend-scale { height: 7px; border-radius: 999px; background: linear-gradient(90deg, rgba(74,163,255,.22), rgba(74,163,255,1)); }
.geography-values, .geography-details { color: var(--muted); font-size: 11px; margin-top: 10px; }
.geography-values table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.geography-values th, .geography-values td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.geography-values td:last-child, .geography-values th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.geography-details p { margin: 6px 0; }
@media (max-width: 600px) { header { padding: 12px; flex-wrap: wrap; } main { padding: 14px 12px 40px; } #meta { display: none; } }
@media (max-width: 720px) { .audience-grid { grid-template-columns: 1fr; } .geography-layout { grid-template-columns: 1fr; } .geography-heading { align-items: flex-start; flex-wrap: wrap; } .geography-heading label { margin-left: 0; } }
`;

export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NEMAR Observability</title>
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <h1>NEMAR Observability</h1>
    <span class="sub">usage and latest dataset &amp; pipeline health</span>
    <span class="spacer"></span>
    <a class="portal" href="https://app.nemar.org/admin" target="_blank" rel="noopener">Admin portal &rarr;</a>
  </header>
  <main>
    <section class="card usage-card">
      <h2>How is NEMAR being used?</h2>
      <p class="health-intro">Daily totals from each reporting source.</p>
      <div class="series-controls">
        <button type="button" data-range="7">Last 7 days</button>
        <button type="button" data-range="30">Last 30 days</button>
        <button type="button" data-range="90">Last 90 days</button>
        <button type="button" data-range="365">Last 365 days</button>
        <label>Start date (UTC)<input id="range-start" type="date"></label>
        <label>End date (UTC)<input id="range-end" type="date"></label>
        <label>View by<select id="grouping"><option value="day">Day</option><option value="week">Calendar week</option><option value="month">Calendar month</option></select></label>
      </div>
      <p id="range-note" class="range-note">UTC · complete days through yesterday</p>
      <details class="range-help">
        <summary>How to read these charts</summary>
        <p>Counts and bytes can be grouped by week or month. Visitor and session totals are queried for the selected range and are not added across days.</p>
      </details>
      <div id="series" aria-live="polite"></div>
    </section>
    <section class="card">
      <h2>What activity happens on the website?</h2>
      <p class="health-intro">Website and edge activity for the selected dates.</p>
      <div id="audience" aria-live="polite"><p class="muted">Loading audience metrics…</p></div>
    </section>
    <section class="card geography-card">
      <div class="geography-heading">
        <div>
          <h2>Where do visitors and requests come from?</h2>
          <p class="health-intro">Reported activity by country.</p>
        </div>
        <label>Map date (UTC)<input id="geography-date" type="date"></label>
        <details class="info-disclosure">
          <summary class="info-icon" aria-label="About the location map">i</summary>
          <span class="info-content">Website sessions and Cloudflare edge requests are separate measures. S3 bucket downloads include internal reads and have no location data.</span>
        </details>
      </div>
      <div id="geography" aria-live="polite"><p class="muted">Loading country activity…</p></div>
    </section>
    <section class="card">
      <h2>What is the latest state of datasets and pipelines?</h2>
      <p class="health-intro">Latest snapshot.</p>
      <p id="health-meta" class="health-meta" aria-live="polite">Loading latest-state snapshot…</p>
      <div id="sections"></div>
    </section>
  </main>
  <script>const WORLD_COUNTRY_PATHS = ${WORLD_COUNTRY_PATHS_JSON};const WORLD_COUNTRY_NAMES = ${WORLD_COUNTRY_NAMES_JSON};const WORLD_COUNTRY_CODES_BY_NAME = ${WORLD_COUNTRY_CODES_BY_NAME_JSON};${CLIENT_JS}</script>
</body>
</html>`;
}
