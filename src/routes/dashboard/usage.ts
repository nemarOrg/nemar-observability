// Usage section: selected-range audience cards and the per-source daily
// series, with their race-guarded loaders and calendar bucketing.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const USAGE_JS = String.raw`
// ---------- audience ----------
let audienceRequestId = 0;
function audienceNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "Unknown";
}
function audienceStatus(status) {
  const labels = { available: "Measured", partial: "Partial coverage", unconfigured: "Not configured", unavailable: "Unavailable" };
  return labels[status] || "Unknown status";
}
function audienceBadge(status) {
  if (status === "available") return badge("ok", audienceStatus(status));
  if (status === "partial") return badge("neutral", audienceStatus(status), "partial");
  return badge("neutral", audienceStatus(status));
}
function audienceMeasure(parent, label, value) {
  const card = el("div", "measure");
  card.appendChild(el("span", "measure-label", label));
  card.appendChild(el("strong", "measure-value" + (typeof value === "number" ? "" : " is-muted"), audienceNumber(value)));
  parent.appendChild(card);
}
function audienceSourceCard(title, source, definitions, metrics) {
  const card = el("article", "card audience-source");
  const heading = el("div", "card-head");
  const titles = el("div", "card-titles");
  const titleRow = el("div", "title-row");
  titleRow.appendChild(el("h4", "card-title", title));
  titleRow.appendChild(infoDisclosure("About " + title, definitions));
  titles.appendChild(titleRow);
  heading.appendChild(titles);
  heading.appendChild(audienceBadge(source.status));
  card.appendChild(heading);
  const measures = el("div", "measures");
  metrics.forEach(function (metric) { audienceMeasure(measures, metric.label, source[metric.key]); });
  card.appendChild(measures);
  const details = disclosure("Coverage and source details");
  const coverage = source.coverage && source.coverage.start && source.coverage.end
    ? source.coverage.start + " to " + source.coverage.end + " UTC"
    : "Unavailable";
  details.appendChild(el("p", "fine", "Measured coverage: " + coverage));
  if (source.note) details.appendChild(el("p", "fine", source.note));
  card.appendChild(details);
  return card;
}
function audienceEvents(parent, report) {
  const status = report && typeof report.status === "string" ? report.status : "unavailable";
  const section = disclosure("Website interactions: " + audienceStatus(status).toLowerCase(), "audience-events");
  section.appendChild(el("p", "fine", "Events are recorded only after consent. Event-associated visitors are anonymous distinct sessions, not identified people."));
  const coverage = report && report.coverage && report.coverage.start && report.coverage.end
    ? "Verified event coverage: " + report.coverage.start + " to " + report.coverage.end + " UTC"
    : "Verified event coverage: unavailable";
  section.appendChild(el("p", "fine", coverage));
  const labels = {
    citation_click: "Citation clicks",
    viewer_open: "Viewer opens",
    viewer_interaction: "Viewer interactions",
    upload_started: "Upload starts",
    upload_completed: "Upload completions"
  };
  const rows = Array.isArray(report && report.metrics) ? report.metrics : [];
  const table = el("table", "data-table");
  const headRow = el("tr");
  ["Interaction", "Events", "Anonymous sessions"].forEach(function (label, i) {
    headRow.appendChild(el("th", i ? "num" : null, label));
  });
  const thead = el("thead"); thead.appendChild(headRow); table.appendChild(thead);
  const body = el("tbody");
  rows.forEach(function (metric) {
    if (!metric || !Object.prototype.hasOwnProperty.call(labels, metric.name)) return;
    const row = el("tr");
    row.appendChild(el("th", null, labels[metric.name]));
    row.appendChild(el("td", "num", audienceNumber(metric.events)));
    row.appendChild(el("td", "num", audienceNumber(metric.visitors)));
    body.appendChild(row);
  });
  table.appendChild(body);
  section.appendChild(table);
  if (report && report.note) section.appendChild(el("p", "fine", report.note));
  parent.appendChild(section);
}
function renderAudience(payload) {
  const root = document.getElementById("audience");
  settle(root);
  const observedAt = typeof payload.observed_at === "string" ? new Date(payload.observed_at) : null;
  const observationLabel =
    observedAt && Number.isFinite(observedAt.getTime())
      ? observedAt.toISOString()
      : "unavailable";
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
  const details = disclosure("How these totals work", "howto-inline");
  details.appendChild(el("p", "fine", "Selected-range totals are queried from each source; visitors and sessions are not added across days. Umami country sessions cover one completed UTC day. Cloudflare request locations cover completed days in the selected range, with small daily values withheld before totals are combined."));
  details.appendChild(el("p", "fine", "Sources last checked: " + observationLabel + " (UTC)."));
  root.appendChild(details);
}

function loadAudience() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("audience");
  const geography = document.getElementById("geography");
  const requestId = ++audienceRequestId;
  if (!start || !end || start > end) {
    state.audience = null; state.audienceLoading = false; state.audienceFailed = false; state.audienceInvalid = true;
    renderKpis();
    stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be on or before the end date.");
    stateMessage(geography, "info", "Choose a valid UTC date range to view country activity.");
    return;
  }
  const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000 + 1;
  if (!Number.isFinite(days) || days > 3660) {
    state.audience = null; state.audienceLoading = false; state.audienceFailed = false; state.audienceInvalid = true;
    renderKpis();
    stateMessage(root, "info", "Choose a valid UTC date range of 3,660 days or fewer.");
    stateMessage(geography, "info", "Choose a valid UTC date range to view country activity.");
    return;
  }
  state.audienceLoading = true; state.audienceInvalid = false; state.audienceFailed = false;
  renderKpis();
  markRefreshing(root, gridSkeleton);
  markRefreshing(geography, geoSkeleton);
  fetch(API + "/audience?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load audience metrics.");
      return response.json();
    })
    .then(function (payload) {
      if (requestId !== audienceRequestId) return;
      if (document.getElementById("range-start").value !== start || document.getElementById("range-end").value !== end) return;
      state.audience = { start: start, end: end, payload: payload };
      state.audienceLoading = false;
      renderAudience(payload);
      renderGeography(payload, start, end);
      renderKpis();
      renderHeadline();
    })
    .catch(function (err) {
      if (requestId !== audienceRequestId) return;
      console.error("[ui] audience load failed:", err);
      state.audience = null; state.audienceLoading = false; state.audienceFailed = true;
      renderKpis();
      stateMessage(root, "error", "Could not load audience metrics", "Website and request totals for these dates are unknown right now, which is not the same as zero.", loadAudience);
      stateMessage(document.getElementById("geography"), "error", "Could not load country activity", "Locations for these dates are unknown right now.", loadAudience);
    });
}

// ---------- series loading ----------
let seriesRequestId = 0;
let pendingSeriesRange = null;
let cachedSeriesRange = null;
function loadSeries() {
  const start = document.getElementById("range-start").value;
  const end = document.getElementById("range-end").value;
  const root = document.getElementById("series");
  const requestId = ++seriesRequestId;
  pendingSeriesRange = null;
  if (!start || !end || start > end) { stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be on or before the end date."); return; }
  const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000 + 1;
  if (!Number.isFinite(days) || days > 3660) {
    stateMessage(root, "info", "Choose a valid UTC date range of 3,660 days or fewer.");
    return;
  }
  if (cachedSeriesRange && cachedSeriesRange.start === start && cachedSeriesRange.end === end) {
    renderSeries(cachedSeriesRange.payload, start, end);
    return;
  }
  markRefreshing(root, chartSkeleton);
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
      stateMessage(root, "error", "Could not load daily usage", (err && err.message ? err.message.replace(/\.?$/, ". ") : "") + "Daily usage for these dates is unknown right now, which is not the same as zero.", loadSeries);
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

// ---------- series ----------
function renderSeries(payload, start, end) {
  const root = document.getElementById("series");
  state.series = { start: start, end: end, payload: payload };
  const today = isoDay(new Date());
  const rangeNote = document.getElementById("range-note");
  rangeNote.textContent = end === today
    ? "All dates are UTC. Today is still in progress, so its values may be incomplete."
    : "All dates are UTC, with complete days through " + longDay(end) + ".";
  if (!payload.series.length) {
    stateMessage(root, "info", "No reporting series cover this range", "Coverage is unavailable here; this does not mean usage was zero.");
    renderKpis();
    return;
  }
  settle(root);
  const groups = new Map();
  payload.series.forEach(function (series) {
    const plane = seriesPlane(series);
    if (!groups.has(plane.key)) groups.set(plane.key, { plane: plane, series: [] });
    groups.get(plane.key).series.push(series);
  });
  const grouping = document.getElementById("grouping").value;
  groups.forEach(function (group) {
    const card = el("section", "card series-card");
    const groupHeading = el("div", "card-head");
    const titleRow = el("div", "title-row");
    titleRow.appendChild(el("h3", "card-title", group.plane.label));
    titleRow.appendChild(infoDisclosure("About " + group.plane.label, group.plane.description));
    groupHeading.appendChild(titleRow);
    card.appendChild(groupHeading);
    group.series.forEach(function (series) {
      const measure = el("article", "series-measure");
      const lastDay = series.latest_observation_date;
      const lastPeriodEnd = lastDay ? Date.parse(lastDay + "T00:00:00Z") + 86400000 : NaN;
      const stale = !Number.isFinite(lastPeriodEnd) || Date.now() - lastPeriodEnd > series.freshness_after_hours * 3600000;
      const buckets = seriesBuckets(series, start, end, grouping);
      const gap = buckets.some(function (b) { return b.value === null; });
      const observedPoints = series.points.filter(function (point) { return point.date >= start && point.date <= end; });
      const observedTotal = observedPoints.reduce(function (sum, point) { return sum + point.value; }, 0);
      const head = el("div", "measure-head");
      const label = el("div", "measure-titles");
      label.appendChild(el("h4", "measure-title", seriesDisplayLabel(series)));
      label.appendChild(el("p", "measure-total-label", observedPoints.length === 0 ? "Range total" : gap ? "Observed total, some periods missing" : "Range total"));
      label.appendChild(el("p", "measure-total", observedPoints.length === 0 ? "Unknown" : seriesValue(observedTotal, series.unit)));
      head.appendChild(label);
      head.appendChild(stale ? badge("warn", "Stale data") : badge("ok", "Current"));
      measure.appendChild(head);
      measure.appendChild(chart(series, buckets, grouping, start, end, group.plane.description));
      const legend = el("div", "chart-legend");
      if (buckets.some(function (b) { return b.partial && b.value !== null; })) {
        const item = el("span", "legend-item");
        item.appendChild(el("span", "legend-key key-dashed"));
        item.appendChild(el("span", null, "Dashed: partial calendar period"));
        legend.appendChild(item);
      }
      if (gap) {
        const item = el("span", "legend-item");
        item.appendChild(el("span", "legend-key key-gap"));
        item.appendChild(el("span", null, "Shaded: no data reported, unknown rather than zero"));
        legend.appendChild(item);
      }
      if (legend.childNodes.length) measure.appendChild(legend);
      const footer = el("div", "measure-foot");
      const sourceDetails = disclosure("Source and coverage: " + (stale ? "stale" : "current"));
      sourceDetails.appendChild(el("p", stale ? "fine stale" : "fine", "Source " + series.source + ", one value per day (UTC). Data covers " + series.coverage_start + " to " + series.coverage_end + "; latest day counted " + (lastDay || "none") + "; updated " + series.updated_at + "."));
      footer.appendChild(sourceDetails);
      footer.appendChild(valuesTable(series, buckets));
      measure.appendChild(footer);
      card.appendChild(measure);
    });
    root.appendChild(card);
  });
  renderKpis();
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
      ? "Partial " + (grouping === "week" ? "week" : grouping === "month" ? "month" : "period") + " (" + bucketStart + (bucketStart === bucketEnd ? "" : " to " + bucketEnd) + ")"
      : grouping === "month"
        ? new Date(bucketStart + "T00:00:00Z").toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
        : grouping === "week" ? "Week " + bucketStart + " to " + bucketEnd
          : bucketStart;
    buckets.push({ start: bucketStart, end: bucketEnd, label: label, value: complete ? sum : null, partial: partial });
    cursor = shiftDay(bucketEnd, 1);
  }
  return buckets;
}
function seriesValue(value, unit) {
  if (value === null) return "Unknown";
  if (unit === "bytes") return humanBytes(value);
  return Number(value).toLocaleString("en-US");
}
function exactSeriesValue(value, unit) {
  if (value === null) return "Unknown";
  if (unit === "bytes") return Number(value).toLocaleString("en-US") + " B";
  return Number(value).toLocaleString("en-US");
}
function valuesTable(series, buckets) {
  const details = disclosure("Show exact values (" + buckets.length + " periods)", "values");
  const table = el("table", "data-table");
  const head = el("thead", null); const heading = el("tr", null);
  heading.appendChild(el("th", null, "UTC period"));
  heading.appendChild(el("th", "num", "Value (" + series.unit + ")"));
  head.appendChild(heading); table.appendChild(head);
  const body = el("tbody", null);
  buckets.forEach(function (bucket) {
    const row = el("tr", null);
    row.appendChild(el("td", null, bucket.label));
    row.appendChild(el("td", "num", exactSeriesValue(bucket.value, series.unit)));
    body.appendChild(row);
  });
  table.appendChild(body);
  const scroll = el("div", "table-scroll"); scroll.appendChild(table);
  details.appendChild(scroll);
  return details;
}
function bucketTick(bucket, grouping, start, end) {
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  if (grouping === "month") {
    const d = parseDay(bucket.start);
    return MONTHS[d.getUTCMonth()] + (sameYear ? "" : " " + d.getUTCFullYear());
  }
  return sameYear ? shortDay(bucket.start) : bucket.start;
}
function chart(series, buckets, grouping, start, end, description) {
  const partialPeriods = buckets.filter(function (bucket) { return bucket.partial; }).map(function (bucket) { return bucket.label; });
  const displayLabel = seriesDisplayLabel(series);
  return lineChart({
    points: buckets,
    unit: series.unit,
    ariaLabel: displayLabel + " by " + grouping + " in " + series.unit,
    description: description + (partialPeriods.length ? " Partial calendar buckets: " + partialPeriods.join("; ") + "." : ""),
    tickLabel: function (i) { return bucketTick(buckets[i], grouping, start, end); },
    tooltip: function (i) {
      const bucket = buckets[i];
      return {
        title: (grouping === "day" && !bucket.partial ? longDay(bucket.start) : bucket.label) + " (UTC)",
        value: bucket.value === null ? "No data reported" : seriesValue(bucket.value, series.unit),
        notes: [
          bucket.value === null ? "Unknown, not zero" : series.unit === "bytes" ? exactSeriesValue(bucket.value, series.unit) : "",
          bucket.partial && bucket.value !== null ? "Partial calendar period" : ""
        ]
      };
    }
  });
}

`;
