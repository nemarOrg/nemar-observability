// Reach section: the country map, its log-scaled five-step legend, the source
// switch, and the ranked country list.
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
function geographySources(payload) {
  return [
    { key: "cloudflare", label: "Cloudflare requests", unit: "requests", totalLabel: "Requests to NEMAR", total: payload.cloudflare.country_requests, source: payload.cloudflare },
    { key: "umami", label: "Website sessions", unit: "anonymous sessions", totalLabel: "Anonymous unique sessions", total: payload.umami.visitors, source: payload.umami }
  ];
}
function hasCountryData(item) {
  return Boolean(item.source.country_coverage);
}
const MAP_CLASSES = 5;
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
      ? countryCoverage.start
      : countryCoverage.start + " to " + countryCoverage.end
    : start === end ? start : start + " to " + end;
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
  toolbar.appendChild(sourceTabs);
  // Umami reports countries for one completed UTC day at a time; say so once,
  // plainly, whenever the chosen dates are anything else.
  if (payload.country_breakdown_scope && payload.country_breakdown_scope !== "single_completed_day") {
    toolbar.appendChild(el("span", "scope-chip scope-note", "Website sessions map one completed UTC day only"));
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
  const values = Array.from(coded.values());
  const maximum = Math.max(1, ...values);
  const minimum = values.length ? Math.min.apply(null, values) : 1;
  const logMin = Math.log(minimum);
  const logSpan = Math.log(maximum) - logMin;
  function mapClass(value) {
    if (!(logSpan > 0)) return MAP_CLASSES - 1;
    return Math.max(0, Math.min(MAP_CLASSES - 1, Math.floor(((Math.log(value) - logMin) / logSpan) * MAP_CLASSES)));
  }
  const layout = el("div", "geo-layout");
  const mapCard = el("div", "card geo-map-card");
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
  function showMapTooltip(content, clientX, clientY) {
    fillTooltip(tooltip, content);
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
    positionFloatingTooltip(tooltip, mapFrame, clientX, clientY);
  }
  function attachMapTooltip(element, content) {
    element.setAttribute("aria-describedby", "geography-country-tooltip");
    tooltip.id = "geography-country-tooltip";
    element.addEventListener("pointerenter", function (event) {
      showMapTooltip(content, event.clientX, event.clientY);
    });
    element.addEventListener("pointermove", function (event) {
      showMapTooltip(content, event.clientX, event.clientY);
    });
    element.addEventListener("pointerleave", hideMapTooltip);
    element.addEventListener("focus", function () {
      const rect = element.getBoundingClientRect();
      showMapTooltip(content, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    element.addEventListener("blur", hideMapTooltip);
  }
  const svg = svgEl("svg", { viewBox: "0 0 1000 500", role: "group", class: "geography-map" });
  svg.setAttribute("aria-label", active.label + " by country from " + period + " UTC");
  function styleMapLocation(element, code, value) {
    if (value === undefined) {
      element.setAttribute("aria-hidden", "true");
      return;
    }
    element.classList.add("map-c" + mapClass(value));
    element.setAttribute("tabindex", "0");
    const detail = countryName(code) + ": " + audienceNumber(value) + " " + active.unit + ", " + period + " UTC";
    element.setAttribute("aria-label", detail);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = detail;
    element.appendChild(title);
    attachMapTooltip(element, { title: countryName(code), value: audienceNumber(value) + " " + active.unit, notes: [periodText + " (UTC)"] });
  }
  Object.keys(WORLD_COUNTRY_PATHS).forEach(function (code) {
    const path = svgEl("path", { d: WORLD_COUNTRY_PATHS[code], class: "map-country" });
    styleMapLocation(path, code, coded.get(code));
    svg.appendChild(path);
  });
  Object.keys(WORLD_COUNTRY_MARKERS).forEach(function (code) {
    const coordinates = WORLD_COUNTRY_MARKERS[code];
    const marker = svgEl("circle", { cx: coordinates[0], cy: coordinates[1], r: 4, class: "map-country-marker" });
    styleMapLocation(marker, code, coded.get(code));
    svg.appendChild(marker);
  });
  mapFrame.appendChild(svg);
  mapCard.appendChild(mapFrame);
  const legend = el("div", "map-legend");
  legend.setAttribute("aria-label", "Color scale, log scaled from fewer to more " + active.unit);
  const scale = el("div", "map-legend-scale");
  for (let i = 0; i < MAP_CLASSES; i++) {
    const step = el("div", "map-legend-step");
    step.appendChild(el("span", "map-swatch map-c" + i));
    const low = i === 0 ? minimum : Math.exp(logMin + (i / MAP_CLASSES) * logSpan);
    step.appendChild(el("span", "map-legend-label", values.length ? legendFormatter.format(low) + "+" : ""));
    scale.appendChild(step);
  }
  legend.appendChild(scale);
  const empty = el("div", "map-legend-empty");
  empty.appendChild(el("span", "map-swatch map-none"));
  empty.appendChild(el("span", "map-legend-label", "No reported value"));
  legend.appendChild(empty);
  mapCard.appendChild(legend);
  layout.appendChild(mapCard);

  const summary = el("aside", "card geo-side");
  summary.setAttribute("aria-label", "Country summary");
  const totalHead = el("div", "title-row");
  totalHead.appendChild(el("span", "geo-total-label", active.totalLabel));
  totalHead.appendChild(infoDisclosure("About location data", active.key === "cloudflare"
    ? "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests; repeat clients, bots, and other automated traffic also count. This is not a count of people, sessions, or completed downloads."
    : "Umami counts anonymous unique-session estimates. A session is not an identified person, and sessions without a reported country are not shown."));
  summary.appendChild(totalHead);
  summary.appendChild(el("strong", "geo-total", audienceNumber(active.total)));
  summary.appendChild(el("p", "geo-date", periodText + " (UTC)"));
  const hasWithheldValues = active.source.suppressed_small_countries === true;
  if (coded.size) {
    summary.appendChild(el("p", "geo-list-title", "Top countries and territories"));
    const ranked = Array.from(coded.entries()).sort(function (a, b) { return b[1] - a[1]; }).map(function (entry) { return { label: entry[0], value: entry[1] }; });
    const pseudoMetric = { key: "cf.by_country", unit: "count" };
    summary.appendChild(hbars(pseudoMetric, ranked.slice(0, 10), { visible: 10, shareOf: typeof active.total === "number" ? active.total : 0 }));
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
    header.appendChild(el("th", null, "Country"));
    header.appendChild(el("th", "num", active.unit.charAt(0).toUpperCase() + active.unit.slice(1)));
    head.appendChild(header); table.appendChild(head);
    const body = el("tbody");
    countries.forEach(function (row) {
      const tr = el("tr");
      tr.appendChild(el("th", null, countryName(row.label)));
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
    ? countryCoverage.start + " to " + countryCoverage.end + " UTC"
    : "Unavailable";
  sourceDetails.appendChild(el("p", "fine", "Source " + active.label + ", country coverage " + coverage + ", status " + audienceStatus(active.source.status).toLowerCase() + "."));
  sourceDetails.appendChild(el("p", "fine", active.key === "cloudflare"
    ? "Cloudflare request totals follow the selected date range, use completed UTC days for the map, and suppress small country values per day before adding reportable daily totals. Requests can include bots and repeat clients. NEMAR S3 bytes are bucket-wide and have no country attribution."
    : "Umami country values are anonymous unique-session estimates for one completed UTC day. They are not added across days or described as identified people."));
  sourceDetails.appendChild(el("p", "fine", "Colors use five log-scaled steps between the smallest and largest reported value, so each step covers a similar ratio rather than a similar count."));
  if (active.source.note) sourceDetails.appendChild(el("p", "fine", active.source.note));
  disclosures.appendChild(sourceDetails);
  root.appendChild(disclosures);
}
`;
