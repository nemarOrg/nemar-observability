// Reach section: the country map with its continuous color scale and legend
// (see scale.ts), the source switch, and the ranked country list.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const REACH_JS = String.raw`
// ---------- geography ----------
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
// Requests use the selected range. Website sessions map one completed day: the
// selected day itself, or for a longer range the newest closed day inside it once
// that day has loaded (state.geoDay), so the source says which day it shows.
function geographySources(payload) {
  const dayLoaded = state.geoDay && state.geoDay.payload ? state.geoDay : null;
  const umami = dayLoaded ? dayLoaded.payload.umami : payload.umami;
  return [
    { key: "cloudflare", label: "Requests", unit: "requests", totalLabel: "Requests to NEMAR", total: payload.cloudflare.country_requests, source: payload.cloudflare },
    { key: "umami", label: "Website sessions", unit: "anonymous sessions", totalLabel: "Anonymous unique sessions", total: umami.visitors, source: umami, day: dayLoaded ? dayLoaded.day : null }
  ];
}
function hasCountryData(item) {
  return Boolean(item.source.country_coverage);
}
const legendFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 });
function renderGeography(payload, start, end) {
  const root = document.getElementById("geography");
  settle(root);
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
      ? longDay(countryCoverage.start)
      : rangeText(countryCoverage.start, countryCoverage.end)
    : rangeText(start, end);
  const periodText = countryCoverage && countryCoverage.start && countryCoverage.end
    ? rangeText(countryCoverage.start, countryCoverage.end)
    : rangeText(start, end);
  document.querySelector(".geography-period").textContent = "Map period: " + periodText + " (UTC)";
  const toolbar = el("div", "geo-toolbar");
  const sourceTabs = el("div", "segmented geography-sources");
  sourceTabs.setAttribute("role", "group");
  sourceTabs.setAttribute("aria-label", "Choose a location data source");
  sources.forEach(function (item) {
    const button = el("button", "geography-source");
    button.appendChild(el("span", "geography-source-label", item.label));
    const hasValues = hasCountryData(item);
    const available = item.source.status === "available" || item.source.status === "partial";
    button.type = "button";
    button.disabled = !available || !hasValues;
    button.setAttribute("aria-pressed", String(item.key === active.key));
    const sourceStatus = available && item.key === "umami" && item.day
      ? "Newest closed day"
      : available && item.key === "umami" && start !== end
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
  toolbar.appendChild(sourceTabs);
  // Website analytics report countries for one completed UTC day at a time; say so once,
  // plainly, whenever the chosen dates are anything else.
  if (payload.country_breakdown_scope && payload.country_breakdown_scope !== "single_completed_day") {
    const websiteDay = sources.find(function (item) { return item.key === "umami"; }).day;
    toolbar.appendChild(el("span", "scope-chip scope-note", websiteDay
      ? "Website sessions map " + longDay(websiteDay) + " only, the newest completed UTC day in these dates"
      : "Website sessions map one completed UTC day only"));
  }
  root.appendChild(toolbar);

  const countries = Array.isArray(active.source.countries) ? active.source.countries : [];
  const coded = new Map();
  countries.forEach(function (row) {
    const code = countryCode(row && row.label);
    if (code && (WORLD_COUNTRY_PATHS[code] || WORLD_COUNTRY_MARKERS[code])
      && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) {
      coded.set(code, (coded.get(code) || 0) + row.value);
    }
  });
  const scale = mapScale(Array.from(coded.values()));
  const ranked = Array.from(coded.entries()).sort(function (a, b) { return b[1] - a[1]; });
  const total = typeof active.total === "number" && active.total > 0 ? active.total : 0;
  function shareText(value) {
    if (!total || !(value > 0)) return "";
    const share = (value / total) * 100;
    return (share < 1 ? "under 1" : String(Math.round(share))) + "% of the total";
  }
  function describe(code) {
    const value = coded.get(code);
    const share = shareText(value);
    return countryName(code) + ": " + audienceNumber(value) + " " + active.unit + (share ? " (" + share + ")" : "") + ", " + periodText + " (UTC)";
  }
  const layout = el("div", "geo-layout");
  const mapCard = el("div", "card geo-map-card");
  const mapFrame = el("div", "geography-map-frame");
  // The floating tooltip is a visual aid for pointers only; the readout under
  // the map carries the same words for touch, keyboard, and screen readers.
  const tooltip = el("div", "geography-tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  mapFrame.appendChild(tooltip);
  function hideMapTooltip() {
    tooltip.textContent = "";
    tooltip.classList.remove("visible");
  }
  function showMapTooltip(code, clientX, clientY) {
    const share = shareText(coded.get(code));
    fillTooltip(tooltip, { title: countryName(code), value: audienceNumber(coded.get(code)) + " " + active.unit, notes: [share, periodText + " (UTC)"] });
    tooltip.classList.add("visible");
    positionFloatingTooltip(tooltip, mapFrame, clientX, clientY);
  }
  const readout = el("p", "map-readout");
  readout.id = "geography-readout";
  readout.setAttribute("aria-live", "polite");
  const readoutHint = ranked.length
    ? "Tap or hover a country for its count, or focus the map and use the arrow keys."
    : "No country has a reported value for these dates.";
  readout.textContent = readoutHint;
  const shapes = new Map();
  let selected = null;
  function select(code, fromKeyboard) {
    if (selected) (shapes.get(selected) || []).forEach(function (shape) { shape.classList.remove("is-selected"); });
    selected = code;
    if (!code) { readout.textContent = readoutHint; hideMapTooltip(); return; }
    const group = shapes.get(code) || [];
    group.forEach(function (shape) { shape.classList.add("is-selected"); });
    readout.textContent = describe(code);
    if (fromKeyboard && group[0] && group[0].getBoundingClientRect) {
      const rect = group[0].getBoundingClientRect();
      showMapTooltip(code, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
  }
  const topThree = ranked.slice(0, 3).map(function (entry) {
    const share = shareText(entry[1]);
    return countryName(entry[0]) + (share ? " (" + share.replace(" of the total", "") + ")" : "");
  });
  // One image with a summary for assistive technology, and one tab stop: the
  // arrow keys step through reporting countries in ranked order. The table
  // below is the full accessible version.
  const svg = svgEl("svg", { viewBox: "0 0 1000 500", role: "img", class: "geography-map", tabindex: "0", "aria-describedby": readout.id });
  svg.setAttribute("aria-label", "Map of " + active.label.toLowerCase() + " by country, " + periodText + " (UTC): "
    + (ranked.length ? plural(ranked.length, "country or territory", "countries and territories") + " reported; most from " + topThree.join(", ") + ". Use the arrow keys to step through countries; the table below lists every value." : "no country values reported."));
  const defs = svgEl("defs");
  const hatch = svgEl("pattern", { id: "map-nodata", patternUnits: "userSpaceOnUse", width: 6, height: 6, patternTransform: "rotate(45)" });
  hatch.appendChild(svgEl("rect", { width: 6, height: 6, class: "map-nodata-bg" }));
  hatch.appendChild(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "map-nodata-line" }));
  defs.appendChild(hatch);
  svg.appendChild(defs);
  function styleMapLocation(element, code, value) {
    element.setAttribute("aria-hidden", "true");
    if (value === undefined) return;
    // A smooth mix along the ramp, not a step: see scale.ts.
    const mix = mapMix(scale.position(value));
    element.classList.add("map-" + mix.half);
    element.style.setProperty("--m", mix.percent + "%");
    element.dataset.code = code;
    if (!shapes.has(code)) shapes.set(code, []);
    shapes.get(code).push(element);
    element.addEventListener("pointermove", function (event) { if (event.pointerType === "mouse") showMapTooltip(code, event.clientX, event.clientY); });
    element.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") hideMapTooltip(); });
  }
  Object.keys(WORLD_COUNTRY_PATHS).forEach(function (code) {
    const path = svgEl("path", { d: WORLD_COUNTRY_PATHS[code], class: "map-country" });
    styleMapLocation(path, code, coded.get(code));
    svg.appendChild(path);
  });
  const markerCodes = [];
  Object.keys(WORLD_COUNTRY_MARKERS).forEach(function (code) {
    const coordinates = WORLD_COUNTRY_MARKERS[code];
    const marker = svgEl("circle", { cx: coordinates[0], cy: coordinates[1], r: 4, class: "map-country-marker" });
    styleMapLocation(marker, code, coded.get(code));
    if (coded.has(code)) markerCodes.push(code);
    svg.appendChild(marker);
  });
  // A tap selects the country under it. Small countries drawn as dots are too
  // small to hit on a phone, so a tap on open sea selects the nearest dot
  // within a finger's reach instead, without covering any larger country.
  const TAP_REACH = 40;
  function nearestMarker(event) {
    if (!svg.getScreenCTM || !svg.createSVGPoint) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(ctm.inverse());
    let best = null; let bestDistance = TAP_REACH;
    markerCodes.forEach(function (code) {
      const c = WORLD_COUNTRY_MARKERS[code];
      const distance = Math.hypot(c[0] - local.x, c[1] - local.y);
      if (distance <= bestDistance) { best = code; bestDistance = distance; }
    });
    return best;
  }
  svg.addEventListener("click", function (event) {
    const code = event.target && event.target.dataset ? event.target.dataset.code : null;
    select(code || nearestMarker(event) || null, false);
  });
  svg.addEventListener("keydown", function (event) {
    if (!ranked.length) return;
    const index = selected ? ranked.findIndex(function (entry) { return entry[0] === selected; }) : -1;
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(ranked.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index < 0 ? 0 : Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ranked.length - 1;
    else if (event.key === "Escape") { select(null, true); return; }
    else return;
    event.preventDefault();
    select(ranked[next][0], true);
  });
  svg.addEventListener("blur", hideMapTooltip);
  mapFrame.appendChild(svg);
  mapCard.appendChild(mapFrame);
  mapCard.appendChild(readout);
  const legend = el("div", "map-legend");
  if (scale.count) {
    const bar = el("div", "map-scale");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", "Continuous color scale from " + audienceNumber(scale.min) + " to " + audienceNumber(scale.max) + " " + active.unit + ", stronger color for more");
    bar.appendChild(el("div", "map-gradient"));
    const tickRow = el("div", "map-ticks");
    const ticks = scale.ticks();
    ticks.forEach(function (tick, i) {
      const label = el("span", "map-tick" + (i === 0 ? " is-first" : "") + (i === ticks.length - 1 ? " is-last" : ""), legendFormatter.format(tick.value));
      label.style.left = (tick.position * 100).toFixed(2) + "%";
      tickRow.appendChild(label);
    });
    bar.appendChild(tickRow);
    legend.appendChild(bar);
  }
  const empty = el("div", "map-legend-empty");
  empty.appendChild(el("span", "map-swatch map-none"));
  empty.appendChild(el("span", "map-legend-label", "No reported value"));
  legend.appendChild(empty);
  mapCard.appendChild(legend);
  // Said where the colors are read: shading ranks countries, it does not scale
  // with the counts. The exact counts are in the list and the table.
  mapCard.appendChild(el("p", "map-caption", "Shading is relative, not proportional: a darker country has more, not a set multiple more. Exact counts are in the list and the table."));
  layout.appendChild(mapCard);

  const summary = el("aside", "card geo-side");
  summary.setAttribute("aria-label", "Country summary");
  const totalHead = el("div", "title-row");
  totalHead.appendChild(el("span", "geo-total-label", active.totalLabel));
  totalHead.appendChild(infoDisclosure("About location data", active.key === "cloudflare"
    ? "The network edge counts one request for each page, file, image, or API call. One page view can create many requests; repeat clients, bots, and other automated traffic also count. This is not a count of people, sessions, or completed downloads."
    : "Website analytics estimate anonymous unique sessions. A session is not an identified person, and sessions without a reported country are not shown."));
  summary.appendChild(totalHead);
  summary.appendChild(el("strong", "geo-total", audienceNumber(active.total)));
  summary.appendChild(el("p", "geo-date", periodText + " (UTC)"));
  const hasWithheldValues = active.source.suppressed_small_countries === true;
  if (coded.size) {
    summary.appendChild(el("p", "geo-list-title", "Top countries and territories"));
    const top = ranked.slice(0, 10).map(function (entry) { return { label: entry[0], value: entry[1] }; });
    const pseudoMetric = { key: "cf.by_country", unit: "count" };
    summary.appendChild(hbars(pseudoMetric, top, { visible: 10, shareOf: total }));
  }
  const hint = el("p", "fine", coded.size
    ? "Showing reported values for " + coded.size + " countries. Small or unreported values may be omitted."
    : hasWithheldValues
      ? "Country values are withheld under the privacy threshold; no country location is shown."
      : countries.length
        ? "Country values were reported, but none match a location on the map."
        : active.source.note || "No country values were reported for this source and period.");
  summary.appendChild(hint);
  layout.appendChild(summary);
  root.appendChild(layout);

  const disclosures = el("div", "geo-more");
  if (countries.length) {
    const details = disclosure("View all country totals (" + countries.length + ")", "values");
    const table = el("table", "data-table");
    const head = el("thead");
    const header = el("tr");
    header.appendChild(scoped(el("th", null, "Country"), "col"));
    header.appendChild(scoped(el("th", "num", active.unit.charAt(0).toUpperCase() + active.unit.slice(1)), "col"));
    head.appendChild(header); table.appendChild(head);
    const body = el("tbody");
    countries.forEach(function (row) {
      const tr = el("tr");
      tr.appendChild(scoped(el("th", null, countryName(row.label)), "row"));
      tr.appendChild(el("td", "num", audienceNumber(row.value)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    const scroll = el("div", "table-scroll"); scroll.appendChild(table);
    details.appendChild(scroll);
    disclosures.appendChild(details);
  }
  const sourceDetails = disclosure("Coverage and map details");
  const coverage = countryCoverage && countryCoverage.start && countryCoverage.end
    ? rangeText(countryCoverage.start, countryCoverage.end) + " (UTC)"
    : "Unavailable";
  sourceDetails.appendChild(el("p", "fine", "Source " + active.label + ", country coverage " + coverage + ", status " + audienceStatus(active.source.status).toLowerCase() + "."));
  sourceDetails.appendChild(el("p", "fine", active.key === "cloudflare"
    ? "Request totals follow the selected date range, use completed UTC days for the map, and suppress small country values per day before adding reportable daily totals. Requests can include bots and repeat clients. Data served from storage has no country attribution."
    : "Website sessions by country are anonymous unique-session estimates for one completed UTC day. They are not added across days or described as identified people."));
  sourceDetails.appendChild(el("p", "fine", "How the shading works: color is continuous, and each shade blends a country's rank among reporting countries with the square root of its share of the largest value. A country with four times another's value is clearly stronger, and small values still differ from no data, but shade is not proportional to the count. Legend ticks sit where the same scale puts them. The list beside the map ranks the top countries to scale."));
  if (active.source.note) sourceDetails.appendChild(el("p", "fine", active.source.note));
  disclosures.appendChild(sourceDetails);
  root.appendChild(disclosures);
}
`;
