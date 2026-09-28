// Pre-redesign renderers kept working while their replacements land. Each
// later module retires part of this file; it goes away entirely once the
// snapshot sections are rebuilt.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const LEGACY_JS = String.raw`
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
  details.appendChild(el("p", "audience-note", "Selected-range totals are queried from each source; visitors and sessions are not added across days. Umami country sessions cover one completed UTC day. Cloudflare request locations cover completed days in the selected range, with small daily values withheld before totals are combined."));
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
    "Requests to NEMAR",
    payload.cloudflare,
    "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests, and bots or repeat clients also count. This is not a count of people, sessions, page views, or completed downloads. Some requests have no reported country.",
    [{ key: "requests", label: "Requests" }]
  ));
  root.appendChild(grid);
}
let geographySourceKey = "cloudflare";
function normalizeCountryLabel(label) {
  return typeof label === "string"
    ? label.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/gi, "").toLowerCase()
    : "";
}
function countryCode(label) {
  if (typeof label !== "string") return null;
  const code = label.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code) && (WORLD_COUNTRY_PATHS[code] || WORLD_COUNTRY_MARKERS[code])) return code;
  const mappedCode = WORLD_COUNTRY_CODES_BY_NAME[normalizeCountryLabel(label)];
  return typeof mappedCode === "string"
    && (WORLD_COUNTRY_PATHS[mappedCode] || WORLD_COUNTRY_MARKERS[mappedCode])
    ? mappedCode
    : null;
}
function countryName(label) {
  const code = countryCode(label);
  if (!code) return label;
  return (WORLD_COUNTRY_NAMES[code] && WORLD_COUNTRY_NAMES[code][0]) || label;
}
function positionFloatingTooltip(tooltip, frame, clientX, clientY) {
  const rect = frame.getBoundingClientRect();
  tooltip.style.maxWidth = Math.max(0, rect.width - 16) + "px";
  tooltip.style.transform = "translateX(-50%)";
  const half = tooltip.offsetWidth / 2;
  const left = Math.min(rect.width - half - 8, Math.max(half + 8, clientX - rect.left));
  const pointerY = clientY - rect.top;
  const tooltipHeight = tooltip.offsetHeight;
  const roomBelow = rect.height - pointerY - 12;
  const roomAbove = pointerY - 12;
  const showBelow = roomBelow >= tooltipHeight || roomBelow >= roomAbove;
  const proposedTop = showBelow ? pointerY + 12 : pointerY - tooltipHeight - 12;
  const top = Math.min(
    Math.max(8, rect.height - tooltipHeight - 8),
    Math.max(8, proposedTop),
  );
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}
function geographySources(payload) {
  return [
    { key: "cloudflare", label: "Cloudflare requests", unit: "requests", totalLabel: "Requests to NEMAR", total: payload.cloudflare.country_requests, source: payload.cloudflare },
    { key: "umami", label: "Website sessions", unit: "anonymous sessions", totalLabel: "Anonymous unique sessions", total: payload.umami.visitors, source: payload.umami }
  ];
}
function hasCountryData(item) {
  return Boolean(item.source.country_coverage);
}
function renderGeography(payload, start, end) {
  const root = document.getElementById("geography");
  root.textContent = "";
  const sources = geographySources(payload);
  const requested = sources.find(function (item) { return item.key === geographySourceKey; });
  const active = (requested && hasCountryData(requested) ? requested : null)
    || sources.find(hasCountryData)
    || requested
    || sources[0];
  geographySourceKey = active.key;
  const countryCoverage = active.source.country_coverage;
  const period = countryCoverage && countryCoverage.start && countryCoverage.end
    ? countryCoverage.start === countryCoverage.end
      ? countryCoverage.start
      : countryCoverage.start + " – " + countryCoverage.end
    : start === end ? start : start + " – " + end;
  document.querySelector(".geography-period").textContent = "Map period · " + period + " UTC";
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
    const sourceStatus = available && item.key === "umami" && start !== end
      ? "Single day only"
      : available && item.key === "umami" && end >= isoDay(new Date())
        ? "Completed day only"
        : audienceStatus(item.source.status);
    button.appendChild(el("span", "geography-source-status", sourceStatus));
    button.addEventListener("click", function () {
      geographySourceKey = item.key;
      renderGeography(payload, start, end);
    });
    sourceTabs.appendChild(button);
  });
  root.appendChild(sourceTabs);

  const countries = Array.isArray(active.source.countries) ? active.source.countries : [];
  const coded = new Map();
  countries.forEach(function (row) {
    const code = countryCode(row && row.label);
    if (code && (WORLD_COUNTRY_PATHS[code] || WORLD_COUNTRY_MARKERS[code])
      && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) {
      coded.set(code, (coded.get(code) || 0) + row.value);
    }
  });
  const maximum = Math.max(1, ...coded.values());
  const layout = el("div", "geography-layout");
  const mapFrame = el("div", "geography-map-frame");
  const tooltip = el("div", "geography-tooltip");
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  mapFrame.appendChild(tooltip);
  function hideMapTooltip() {
    tooltip.textContent = "";
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  }
  function showMapTooltip(detail, clientX, clientY) {
    tooltip.textContent = detail;
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
    positionFloatingTooltip(tooltip, mapFrame, clientX, clientY);
  }
  function attachMapTooltip(element, detail) {
    element.setAttribute("aria-describedby", "geography-country-tooltip");
    tooltip.id = "geography-country-tooltip";
    element.addEventListener("pointerenter", function (event) {
      showMapTooltip(detail, event.clientX, event.clientY);
    });
    element.addEventListener("pointermove", function (event) {
      showMapTooltip(detail, event.clientX, event.clientY);
    });
    element.addEventListener("pointerleave", hideMapTooltip);
    element.addEventListener("focus", function () {
      const rect = element.getBoundingClientRect();
      showMapTooltip(detail, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    element.addEventListener("blur", hideMapTooltip);
  }
  function styleMapLocation(element, code, value) {
    if (value === undefined) {
      element.setAttribute("fill", "#27313d");
      element.setAttribute("aria-hidden", "true");
      return;
    }
    const strength = Math.log1p(value) / Math.log1p(maximum);
    element.setAttribute("fill", "rgba(74, 163, 255, " + (0.22 + 0.78 * strength).toFixed(3) + ")");
    element.setAttribute("tabindex", "0");
    const detail = period + " UTC · " + countryName(code) + " · " + audienceNumber(value) + " " + active.unit;
    element.setAttribute("aria-label", detail);
    const title = document.createElementNS(svg.namespaceURI, "title");
    title.textContent = detail;
    element.appendChild(title);
    attachMapTooltip(element, detail);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 500");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", active.label + " by country from " + period + " UTC");
  svg.classList.add("geography-map");
  Object.keys(WORLD_COUNTRY_PATHS).forEach(function (code) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", WORLD_COUNTRY_PATHS[code]);
    path.setAttribute("class", "map-country");
    styleMapLocation(path, code, coded.get(code));
    svg.appendChild(path);
  });
  Object.keys(WORLD_COUNTRY_MARKERS).forEach(function (code) {
    const coordinates = WORLD_COUNTRY_MARKERS[code];
    const marker = document.createElementNS(svg.namespaceURI, "circle");
    marker.setAttribute("cx", String(coordinates[0]));
    marker.setAttribute("cy", String(coordinates[1]));
    marker.setAttribute("r", "4");
    marker.setAttribute("class", "map-country-marker");
    styleMapLocation(marker, code, coded.get(code));
    svg.appendChild(marker);
  });
  mapFrame.appendChild(svg);
  layout.appendChild(mapFrame);

  const summary = el("aside", "geography-summary");
  summary.appendChild(el("span", "geography-summary-label", active.totalLabel));
  summary.appendChild(el("strong", "geography-summary-value", audienceNumber(active.total)));
  summary.appendChild(el("p", "geography-summary-date", "Country activity · " + period + " UTC"));
  summary.appendChild(infoDisclosure("About location data", active.key === "cloudflare"
    ? "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests; repeat clients, bots, and other automated traffic also count. This is not a count of people, sessions, or completed downloads."
    : "Umami counts anonymous unique-session estimates. A session is not an identified person, and sessions without a reported country are not shown."));
  const hasWithheldValues = active.source.suppressed_small_countries === true;
  const hint = el("p", "geography-map-hint", coded.size
    ? "Showing reported values for " + coded.size + " countries. Small or unreported values may be omitted."
    : hasWithheldValues
      ? "Country values are withheld under the privacy threshold; no country location is shown."
      : countries.length
        ? "Country values were reported, but none match a location on the map."
        : active.source.note || "No country values were reported for this source and period.");
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
  const coverage = countryCoverage && countryCoverage.start && countryCoverage.end
    ? countryCoverage.start + " to " + countryCoverage.end + " UTC"
    : "Unavailable";
  sourceDetails.appendChild(el("p", null, "Source " + active.label + " · country coverage " + coverage + " · status " + audienceStatus(active.source.status) + "."));
  sourceDetails.appendChild(el("p", null, active.key === "cloudflare"
    ? "Cloudflare request totals follow the selected date range, use completed UTC days for the map, and suppress small country values per day before adding reportable daily totals. Requests can include bots and repeat clients. NEMAR S3 bytes are bucket-wide and have no country attribution."
    : "Umami country values are anonymous unique-session estimates for one completed UTC day. They are not added across days or described as identified people."));
  if (active.source.note) sourceDetails.appendChild(el("p", null, active.source.note));
  root.appendChild(sourceDetails);
}
function loadAudience() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("audience");
  const geography = document.getElementById("geography");
  const requestId = ++audienceRequestId;
  root.textContent = "";
  geography.textContent = "";
  if (!start || !end || start > end) {
    root.appendChild(el("p", "muted", "Choose a valid UTC date range."));
    geography.appendChild(el("p", "muted", "Choose a valid UTC date range to view country activity."));
    return;
  }
  const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000 + 1;
  if (!Number.isFinite(days) || days > 3660) {
    root.appendChild(el("p", "muted", "Choose a valid UTC date range of 3,660 days or fewer."));
    geography.appendChild(el("p", "muted", "Choose a valid UTC date range to view country activity."));
    return;
  }
  root.appendChild(el("p", "muted", "Loading audience and country metrics…"));
  geography.appendChild(el("p", "muted", "Loading country activity for the selected dates…"));
  fetch(API + "/audience?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load audience metrics.");
      return response.json();
    })
    .then(function (payload) {
      if (requestId !== audienceRequestId) return;
      if (document.getElementById("range-start").value !== start || document.getElementById("range-end").value !== end) return;
      renderAudience(payload);
      renderGeography(payload, start, end);
    })
    .catch(function () {
      if (requestId !== audienceRequestId) return;
      root.textContent = "";
      root.appendChild(el("p", "muted", "Could not load audience metrics."));
      const geography = document.getElementById("geography");
      geography.textContent = "";
      geography.appendChild(el("p", "muted", "Could not load country activity."));
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
  if (key === "cf") return { key: "cf", label: "How much traffic does Cloudflare handle?", description: "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests, and automated traffic is included. Request and byte totals do not represent people, sessions, or completed downloads." };
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
  const wrapper = el("div", "series-chart-wrap");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 900 250"); svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", seriesDisplayLabel(series) + " by " + grouping + " in " + series.unit);
  svg.setAttribute("aria-description", description);
  svg.classList.add("series-chart");
  const tooltip = el("div", "series-tooltip");
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  function hideTooltip() {
    tooltip.textContent = "";
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  }
  function showTooltip(detail, clientX, clientY) {
    tooltip.textContent = detail;
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
    positionFloatingTooltip(tooltip, wrapper, clientX, clientY);
  }
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
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      const detail = p.bucket.label + " UTC · " + seriesDisplayLabel(series) + " · " + seriesValue(p.value, series.unit)
        + (series.unit === "bytes" ? " (" + exactSeriesValue(p.value, series.unit) + ")" : "");
      dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("r", "5.5"); dot.setAttribute("class", "series-point"); dot.setAttribute("tabindex", "0"); dot.setAttribute("aria-label", detail);
      const title = document.createElementNS(svg.namespaceURI, "title"); title.textContent = detail; dot.appendChild(title);
      dot.addEventListener("pointerenter", function (event) { showTooltip(detail, event.clientX, event.clientY); });
      dot.addEventListener("pointermove", function (event) { showTooltip(detail, event.clientX, event.clientY); });
      dot.addEventListener("pointerleave", hideTooltip);
      dot.addEventListener("focus", function () {
        const rect = dot.getBoundingClientRect();
        showTooltip(detail, rect.left + rect.width / 2, rect.top + rect.height / 2);
      });
      dot.addEventListener("blur", hideTooltip);
      svg.appendChild(dot);
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
  wrapper.appendChild(svg);
  wrapper.appendChild(tooltip);
  return wrapper;
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
