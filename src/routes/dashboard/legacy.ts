// Pre-redesign renderers kept working while their replacements land. Each
// later module retires part of this file; it goes away entirely once the
// snapshot sections are rebuilt.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const LEGACY_JS = String.raw`
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

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("health-meta").textContent = "Could not load latest-state snapshot.";
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

`;
