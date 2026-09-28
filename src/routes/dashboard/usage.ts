// Usage section: selected-range audience cards and the per-source daily
// series, with their shared, race-safe loaders and calendar bucketing.
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

// One request per date range, shared: a range asked for again (a preset
// clicked twice, or the prior period of one range being another range) reuses
// the answer for a few minutes instead of querying again.
const AUDIENCE_CACHE_MS = 5 * 60000;
const audienceCache = new Map();
function fetchAudience(start, end) {
  const key = start + "|" + end;
  const hit = audienceCache.get(key);
  if (hit && Date.now() - hit.at < AUDIENCE_CACHE_MS) return hit.promise;
  const promise = fetch(API + "/audience?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end))
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load audience metrics.");
      return response.json();
    });
  audienceCache.set(key, { at: Date.now(), promise: promise });
  promise.catch(function () { if (audienceCache.get(key) && audienceCache.get(key).promise === promise) audienceCache.delete(key); });
  return promise;
}
function isSelected(start, end) {
  const range = selectedRange();
  return range.start === start && range.end === end;
}
function loadAudience() {
  const range = selectedRange();
  const start = range.start; const end = range.end;
  const root = document.getElementById("audience");
  const geography = document.getElementById("geography");
  const requestId = ++audienceRequestId;
  state.audiencePrior = null;
  if (!validRange(start, end)) {
    state.audience = null; state.audienceLoading = false; state.audienceFailed = false; state.audienceInvalid = true;
    renderKpis();
    stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be on or before the end date, and a range can span up to 3,660 days.");
    stateMessage(geography, "info", "Choose a valid UTC date range to view country activity.");
    return;
  }
  state.audienceLoading = true; state.audienceInvalid = false; state.audienceFailed = false;
  renderKpis();
  markRefreshing(root, gridSkeleton);
  markRefreshing(geography, geoSkeleton);
  fetchAudience(start, end)
    .then(function (payload) {
      if (requestId !== audienceRequestId || !isSelected(start, end)) return;
      state.audience = { start: start, end: end, payload: payload };
      state.audienceLoading = false;
      renderAudience(payload);
      renderGeography(payload, start, end);
      loadPriorAudience(start, end, payload, requestId);
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
function loadPriorAudience(start, end, payload, requestId) {
  const prior = priorRange(start, end);
  if (!priorAudienceWanted(payload, prior)) {
    state.audiencePrior = { start: prior.start, end: prior.end, payload: null, loading: false };
    return;
  }
  state.audiencePrior = { start: prior.start, end: prior.end, payload: null, loading: true };
  fetchAudience(prior.start, prior.end)
    .then(function (priorPayload) {
      if (requestId !== audienceRequestId || !isSelected(start, end)) return;
      state.audiencePrior = { start: prior.start, end: prior.end, payload: priorPayload, loading: false };
      renderKpis();
    })
    .catch(function (err) {
      if (requestId !== audienceRequestId) return;
      console.error("[ui] prior-period audience load failed:", err);
      state.audiencePrior = { start: prior.start, end: prior.end, payload: null, loading: false };
      renderKpis();
    });
}

// ---------- series loading ----------
// One request for the archive window covers every preset, most custom ranges,
// and the period before each, so changing the range or the grouping re-renders
// from memory. A range outside it (an end after today, or a start more than
// 3,660 days back) gets its own request, with its prior period when that fits.
// Answers arriving out of order cannot show the wrong dates: each one only
// triggers a render of the range selected at that moment, from whichever loaded
// window covers it.
const seriesWindows = [];
const seriesPending = [];
function loadSeries() {
  const range = selectedRange();
  const root = document.getElementById("series");
  if (!validRange(range.start, range.end)) {
    stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be on or before the end date, and a range can span up to 3,660 days.");
    renderKpis();
    return;
  }
  const ready = coveringWindow(seriesWindows, range.start, range.end);
  if (ready) { renderSeries(ready.payload, range.start, range.end); return; }
  state.seriesFailed = false;
  markRefreshing(root, chartSkeleton);
  renderKpis();
  if (!coveringWindow(seriesPending, range.start, range.end)) fetchSeriesWindow(seriesWindowFor(range.start, range.end));
}
function renderSelectedSeries() {
  const range = selectedRange();
  if (!validRange(range.start, range.end)) return;
  const ready = coveringWindow(seriesWindows, range.start, range.end);
  if (ready) renderSeries(ready.payload, range.start, range.end);
}
function fetchSeriesWindow(win) {
  const pending = { start: win.start, end: win.end };
  seriesPending.push(pending);
  const archive = seriesArchiveWindow(isoDay(new Date()));
  const isArchive = win.start === archive.start && win.end === archive.end;
  fetch(API + "/timeseries?start=" + encodeURIComponent(win.start) + "&end=" + encodeURIComponent(win.end))
    .then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return null; }).then(function (body) {
        throw new Error(body && body.error ? body.error : "Could not load daily series.");
      });
    })
    .then(function (payload) {
      for (let i = seriesWindows.length - 1; i >= 0; i--) {
        if (Date.now() - seriesWindows[i].at >= SERIES_CACHE_MS) seriesWindows.splice(i, 1);
      }
      seriesWindows.push({ start: win.start, end: win.end, payload: payload, at: Date.now() });
      if (isArchive) { state.archive = payload; state.archiveFailed = false; renderAllTime(); }
      // Render whatever is selected now; a newer request that covers it wins.
      renderSelectedSeries();
    })
    .catch(function (err) {
      console.error("[ui] daily series load failed:", err);
      if (isArchive) { state.archiveFailed = true; renderAllTime(); }
      // Speak only for the current selection, and only when no other answer
      // for it is loaded or still on its way.
      const range = selectedRange();
      if (!(win.start <= range.start && win.end >= range.end)) return;
      if (coveringWindow(seriesWindows, range.start, range.end)) return;
      if (seriesPending.some(function (p) { return p !== pending && p.start <= range.start && p.end >= range.end; })) return;
      state.seriesFailed = true;
      stateMessage(document.getElementById("series"), "error", "Could not load daily usage", (err && err.message ? err.message.replace(/\.?$/, ". ") : "") + "Daily usage for these dates is unknown right now, which is not the same as zero.", loadSeries);
      renderKpis();
    })
    .finally(function () {
      const index = seriesPending.indexOf(pending);
      if (index >= 0) seriesPending.splice(index, 1);
    });
}

// ---------- series ----------
function renderSeries(payload, start, end) {
  const root = document.getElementById("series");
  state.series = { start: start, end: end, payload: payload };
  state.seriesFailed = false;
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
      // Freshness is a fact about the data, stated plainly rather than as an alarm.
      head.appendChild(badge("neutral", lastDay ? "Through " + shortDay(lastDay) : "No days counted yet", "neutral"));
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
