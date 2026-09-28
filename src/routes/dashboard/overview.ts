// Overview: the plain-language headline and the KPI cards, with sparklines
// from the snapshot history endpoint where a series exists.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const OVERVIEW_JS = String.raw`
const HISTORY_KEYS = ["datasets.public", "datasets.bytes"];
// ---------- overview ----------
function countriesReached() {
  const audience = state.audience;
  if (!audience || !audience.payload || !audience.payload.cloudflare) return null;
  const source = audience.payload.cloudflare;
  if (!source.country_coverage) return null;
  const totals = new Map();
  (Array.isArray(source.countries) ? source.countries : []).forEach(function (row) {
    const code = countryCode(row && row.label);
    if (code && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) totals.set(code, (totals.get(code) || 0) + row.value);
  });
  const ranked = Array.from(totals.entries()).sort(function (a, b) { return b[1] - a[1]; });
  return { count: ranked.length, top: ranked.slice(0, 3).map(function (entry) { return countryName(entry[0]); }), start: audience.start, end: audience.end };
}
function rangePhrase(start, end) {
  const days = presetFor(start, end);
  if (days) return "in the last " + days + " days";
  return start === end ? "on " + longDay(start) : "from " + rangeText(start, end);
}
function renderHeadline() {
  const heading = document.getElementById("overview-title");
  const index = metricIndex(state.snapshot);
  const pub = index["datasets.public"];
  if (!pub) return;
  const bytes = index["datasets.bytes"];
  heading.textContent = "";
  // A number never wraps away from its unit.
  function fact(text) { heading.appendChild(el("span", "fact", text.replace(/^(\S+) /, "$1 "))); }
  function words(text) { heading.appendChild(document.createTextNode(text)); }
  words("NEMAR holds ");
  fact(plural(pub.value, "public dataset", "public datasets"));
  if (bytes) { words(" and "); fact(humanBytes(bytes.value) + " of open data"); }
  const reach = countriesReached();
  if (reach && reach.count > 0) {
    words(", with requests from ");
    fact(plural(reach.count, "country or territory", "countries and territories"));
    words(" " + rangePhrase(reach.start, reach.end));
  }
  words(".");
}
function historyDelta(key, formatter) {
  const points = state.history[key];
  if (!points || points.length < 2) return null;
  const first = points[0]; const last = points[points.length - 1];
  const diff = last.value - first.value;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const span = hours < 36 ? " in " + plural(Math.round(hours), "hour", "hours") : " in " + plural(Math.round(hours / 24), "day", "days");
  if (diff === 0) return { direction: "flat", text: "No change" + span };
  return { direction: diff > 0 ? "up" : "down", text: (diff > 0 ? "+" : "−") + formatter(Math.abs(diff)) + span };
}
function historySpark(key, label, formatter) {
  const points = state.history[key];
  if (!points || points.length < 2) return null;
  return lineChart({
    compact: true,
    points: points.map(function (p) { return { value: p.value, partial: false }; }),
    ariaLabel: label + " in hourly snapshots from " + formatDateTime(points[0].at) + " to " + formatDateTime(points[points.length - 1].at),
    tooltip: function (i) { return { title: formatDateTime(points[i].at), value: formatter(points[i].value) }; }
  });
}
function requestSpark() {
  const audience = state.audience;
  const payload = state.series;
  if (!audience || !payload || payload.start !== audience.start || payload.end !== audience.end) return null;
  const series = (payload.payload.series || []).find(function (s) {
    return String(s.section).toLowerCase() === "cf" && /request/i.test(String(s.key) + " " + String(s.label)) && s.unit === "count";
  });
  if (!series) return null;
  const buckets = seriesBuckets(series, audience.start, audience.end, "day");
  if (buckets.length < 2) return null;
  return lineChart({
    compact: true,
    points: buckets,
    ariaLabel: "Daily Cloudflare requests",
    tooltip: function (i) { return { title: buckets[i].label + " (UTC)", value: seriesValue(buckets[i].value, "count") + (buckets[i].value === null ? "" : " requests") }; }
  });
}
function kpiCard(spec) {
  const card = el("article", "card kpi" + (spec.refreshing ? " is-refreshing" : ""));
  const head = el("div", "kpi-head");
  head.appendChild(el("p", "kpi-label", spec.label));
  if (spec.info) head.appendChild(infoDisclosure("About " + spec.label, spec.info));
  card.appendChild(head);
  if (spec.loading) {
    card.setAttribute("aria-busy", "true");
    card.appendChild(skeletonBlock("skeleton-value"));
    card.appendChild(skeletonBlock("skeleton-line short"));
    return card;
  }
  const value = el("p", "kpi-value" + (spec.muted ? " is-muted" : ""), spec.value);
  if (spec.exact) value.setAttribute("title", spec.exact);
  card.appendChild(value);
  if (spec.delta) {
    const delta = el("p", "kpi-delta delta-" + spec.delta.direction);
    delta.appendChild(icon(spec.delta.direction));
    delta.appendChild(el("span", null, spec.delta.text));
    card.appendChild(delta);
  }
  if (spec.context) card.appendChild(el("p", "kpi-context", spec.context));
  const foot = el("div", "kpi-foot");
  if (spec.spark) foot.appendChild(spec.spark);
  else if (spec.meter != null) {
    const meter = el("div", "meter meter-lg");
    const fill = el("div", "meter-fill sev-info");
    fill.style.width = Math.min(100, Math.max(0, spec.meter)) + "%";
    meter.appendChild(fill);
    foot.appendChild(meter);
  }
  if (foot.childNodes.length) card.appendChild(foot);
  return card;
}
function audienceKpi(label, info, build) {
  if (state.audienceInvalid) return kpiCard({ label: label, info: info, value: "No range", muted: true, context: "Choose a valid UTC date range." });
  if (state.audienceFailed) return kpiCard({ label: label, info: info, value: "Unavailable", muted: true, context: "Could not load usage for these dates. Unknown is not zero." });
  if (!state.audience) return kpiCard({ label: label, info: info, loading: true });
  const spec = build(state.audience.payload);
  spec.label = label; spec.info = spec.info || info;
  spec.refreshing = state.audienceLoading;
  return kpiCard(spec);
}
function renderKpis() {
  const root = document.getElementById("kpis");
  root.textContent = "";
  const snap = state.snapshot;
  const index = metricIndex(snap);
  const snapLoading = !snap && !state.snapshotFailed;
  function snapshotKpi(label, metric, build) {
    if (snapLoading) return kpiCard({ label: label, loading: true });
    if (!metric) return kpiCard({ label: label, value: "Unavailable", muted: true, context: state.snapshotFailed ? "The latest snapshot did not load." : "Not in the latest snapshot." });
    const spec = build(metric);
    spec.label = label;
    return kpiCard(spec);
  }
  const pub = index["datasets.public"];
  const priv = index["datasets.private"];
  root.appendChild(snapshotKpi("Public datasets", pub, function (m) {
    return {
      value: num(m.value),
      delta: historyDelta("datasets.public", num),
      context: priv ? "Plus " + num(priv.value) + " private datasets" : "",
      info: [m.hint, "The trend line covers the most recent hourly snapshots, up to about a week."],
      spark: historySpark("datasets.public", "Public datasets", num)
    };
  }));
  root.appendChild(snapshotKpi("Data volume", index["datasets.bytes"], function (m) {
    return {
      value: humanBytes(m.value),
      exact: num(m.value) + " bytes",
      delta: historyDelta("datasets.bytes", humanBytes),
      context: pub ? "Across " + num(pub.value) + " public datasets" : "",
      info: [m.hint, "Sizes use decimal units: 1 TB is 1,000 GB."],
      spark: historySpark("datasets.bytes", "Public data volume", humanBytes)
    };
  }));
  root.appendChild(snapshotKpi("With a DOI", index["datasets.with_doi"], function (m) {
    const p = pct(m.value, m.total);
    return {
      value: p != null ? p + "%" : num(m.value),
      context: m.total != null ? num(m.value) + " of " + num(m.total) + " public datasets" : "",
      info: ["A digital object identifier (DOI) is a permanent link that makes a dataset citable in papers.", m.hint],
      meter: p
    };
  }));
  const requestInfo = "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests, and bots and repeat clients count too. This is not a count of people or completed downloads.";
  root.appendChild(audienceKpi("Requests", requestInfo, function (payload) {
    const cf = payload.cloudflare;
    if (typeof cf.requests !== "number") return { value: "Not measured", muted: true, context: audienceStatus(cf.status) + ". Unknown is not zero." };
    const coverage = cf.coverage && cf.coverage.start && cf.coverage.end ? rangeText(cf.coverage.start, cf.coverage.end) : "";
    return {
      value: compact(cf.requests),
      exact: num(cf.requests) + " requests",
      context: cf.status === "partial" && coverage ? "Partial coverage, " + coverage : rangePhrase(state.audience.start, state.audience.end).replace(/^in the/, "In the").replace(/^from/, "From").replace(/^on/, "On"),
      spark: requestSpark()
    };
  }));
  const countryInfo = "Countries and territories with reported Cloudflare requests in the selected dates. Small daily counts are withheld for privacy, and requests include automated traffic, so this is reach of the service, not a count of researchers.";
  root.appendChild(audienceKpi("Countries", countryInfo, function (payload) {
    const reach = countriesReached();
    if (!reach) return { value: "Not measured", muted: true, context: payload.cloudflare.note ? "No country breakdown for these dates." : audienceStatus(payload.cloudflare.status) };
    return { value: num(reach.count), context: reach.top.length ? "Most requests: " + reach.top.join(", ") : "" };
  }));
  const visitorInfo = "Umami estimates anonymous unique sessions after consent. A session is not an identified person, and sessions are not added across days.";
  root.appendChild(audienceKpi("Website visitors", visitorInfo, function (payload) {
    const umami = payload.umami;
    if (typeof umami.visitors !== "number") {
      return {
        value: "Not measured",
        muted: true,
        context: umami.status === "unconfigured" ? "Website analytics are not reporting yet." : umami.status === "unavailable" ? "Website analytics are unavailable right now." : audienceStatus(umami.status) + "."
      };
    }
    return { value: compact(umami.visitors), exact: num(umami.visitors) + " anonymous sessions", context: "Anonymous unique sessions" + (umami.status === "partial" ? ", partial coverage" : "") };
  }));
  root.setAttribute("aria-busy", String(snapLoading || (!state.audience && !state.audienceFailed && !state.audienceInvalid)));
}
function loadHistory() {
  HISTORY_KEYS.forEach(function (key) {
    fetch(API + "/snapshot/history?metric=" + encodeURIComponent(key))
      .then(function (r) { if (!r.ok) throw new Error("history " + r.status); return r.json(); })
      .then(function (body) {
        state.history[key] = (Array.isArray(body.points) ? body.points : []).filter(function (p) {
          return p && typeof p.value === "number" && Number.isFinite(p.value) && typeof p.at === "string";
        });
        renderKpis();
      })
      .catch(function (err) {
        console.error("[ui] metric history failed:", key, err);
        state.history[key] = [];
      });
  });
}

`;
