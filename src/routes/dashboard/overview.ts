// Overview: the plain-language headline, the KPI cards for the selected dates,
// and the all-time strip.
//
// Every KPI card follows the range control. A card compares with the
// equal-length period before the range only where both periods were measured
// (see range.ts). The all-time strip holds the figures that do not follow the
// range: the catalog as it is now, and usage summed over every reported day,
// labeled with the day each source started reporting.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const OVERVIEW_JS = String.raw`
const HISTORY_KEYS = ["datasets.public", "datasets.bytes"];
// ---------- overview ----------
function countriesIn(payload) {
  const source = payload && payload.cloudflare;
  if (!source || !source.country_coverage) return null;
  const totals = new Map();
  (Array.isArray(source.countries) ? source.countries : []).forEach(function (row) {
    const code = countryCode(row && row.label);
    if (code && typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) totals.set(code, (totals.get(code) || 0) + row.value);
  });
  const ranked = Array.from(totals.entries()).sort(function (a, b) { return b[1] - a[1]; });
  return { count: ranked.length, top: ranked.slice(0, 3).map(function (entry) { return countryName(entry[0]); }) };
}
function countriesReached() {
  const audience = state.audience;
  if (!audience) return null;
  const reach = countriesIn(audience.payload);
  return reach ? { count: reach.count, top: reach.top, start: audience.start, end: audience.end } : null;
}
function rangePhrase(start, end) {
  const days = presetFor(start, end);
  if (days) return "in the last " + days + " days";
  return start === end ? "on " + longDay(start) : "from " + rangeText(start, end);
}
function rangeSentence(start, end) {
  const phrase = rangePhrase(start, end);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
function renderHeadline() {
  const heading = document.getElementById("overview-title");
  const index = metricIndex(state.snapshot);
  const pub = index["datasets.public"];
  if (!pub) return;
  const bytes = index["datasets.bytes"];
  heading.textContent = "";
  // A number never wraps away from its unit (a no-break space).
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
  if (diff === 0) return "No change" + span;
  return (diff > 0 ? "+" : "−") + formatter(Math.abs(diff)) + span;
}

// ---------- daily series lookups ----------
function egressSeries(payload) {
  return ((payload && payload.series) || []).find(function (s) { return String(s.section).toLowerCase() === "egress" && s.unit === "bytes"; }) || null;
}
function requestSeries(payload) {
  return ((payload && payload.series) || []).find(function (s) {
    return String(s.section).toLowerCase() === "cf" && /request/i.test(String(s.key) + " " + String(s.label)) && s.unit === "count";
  }) || null;
}
function dailySpark(series, start, end, label, format) {
  const buckets = seriesBuckets(series, start, end, "day");
  if (buckets.filter(function (b) { return b.value !== null; }).length < 2) return null;
  return lineChart({
    compact: true,
    points: buckets,
    ariaLabel: label + " per day, " + rangeText(start, end) + " (UTC)",
    tooltip: function (i) { return { title: longDay(buckets[i].start) + " (UTC)", value: buckets[i].value === null ? "No data reported" : format(buckets[i].value) }; }
  });
}
// The loaded daily series, when it is for the selected dates.
function selectedSeries() {
  const range = selectedRange();
  const loaded = state.series;
  return loaded && loaded.start === range.start && loaded.end === range.end ? loaded : null;
}

// ---------- comparisons ----------
function audienceComparison(compute) {
  return comparisonFor(state.audience, state.audienceLoading, state.audiencePrior, compute);
}

// ---------- KPI cards ----------
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
    if (spec.delta.direction !== "none") delta.appendChild(icon(spec.delta.direction));
    delta.appendChild(el("span", null, spec.delta.text));
    card.appendChild(delta);
  }
  if (spec.context) card.appendChild(el("p", "kpi-context", spec.context));
  const foot = el("div", "kpi-foot");
  if (spec.spark) foot.appendChild(spec.spark);
  if (foot.childNodes.length) card.appendChild(foot);
  return card;
}
function audienceKpi(label, info, build) {
  if (state.audienceInvalid) return kpiCard({ label: label, info: info, value: "No range", muted: true, context: "Choose a valid UTC date range." });
  if (state.audienceFailed) return kpiCard({ label: label, info: info, value: "Unavailable", muted: true, context: "Could not load usage for these dates. Unknown is not zero." });
  if (!state.audience) return kpiCard({ label: label, info: info, loading: true });
  const spec = build(state.audience.payload, state.audience.start, state.audience.end);
  spec.label = label; spec.info = spec.info || info;
  spec.refreshing = state.audienceLoading;
  return kpiCard(spec);
}
function seriesKpi(label, info, build) {
  const range = selectedRange();
  if (!validRange(range.start, range.end)) return kpiCard({ label: label, info: info, value: "No range", muted: true, context: "Choose a valid UTC date range." });
  const loaded = selectedSeries();
  if (!loaded && state.seriesFailed) return kpiCard({ label: label, info: info, value: "Unavailable", muted: true, context: "Could not load daily usage for these dates. Unknown is not zero." });
  if (!loaded) return kpiCard({ label: label, info: info, loading: true });
  const spec = build(loaded.payload, range.start, range.end);
  spec.label = label; spec.info = spec.info || info;
  return kpiCard(spec);
}
function renderKpis() {
  const root = document.getElementById("kpis");
  root.textContent = "";
  const requestInfo = "Cloudflare counts one request for each page, file, image, or API call. One page view can create many requests, and bots and repeat clients count too. This is not a count of people or completed downloads.";
  root.appendChild(audienceKpi("Requests", requestInfo, function (payload, start, end) {
    const cf = payload.cloudflare;
    if (typeof cf.requests !== "number") return { value: "Not measured", muted: true, context: audienceStatus(cf.status) + ". Unknown is not zero." };
    const full = fullyMeasured(cf, start, end, "coverage");
    const coverage = cf.coverage && cf.coverage.start && cf.coverage.end ? rangeText(cf.coverage.start, cf.coverage.end) : "";
    const loaded = selectedSeries();
    const daily = loaded ? requestSeries(loaded.payload) : null;
    return {
      value: compact(cf.requests),
      exact: num(cf.requests) + " requests",
      delta: full ? audienceComparison(function (prior, period) {
        return fullyMeasured(prior.cloudflare, period.start, period.end, "coverage") ? percentDelta(cf.requests, prior.cloudflare.requests, comparisonLabel(period.days)) : null;
      }) : NO_COMPARISON,
      context: !full && coverage ? "Measured " + coverage + " only" : rangeSentence(start, end),
      spark: daily ? dailySpark(daily, start, end, "Cloudflare requests", function (v) { return num(v) + " requests"; }) : null
    };
  }));
  const downloadInfo = "Bytes the NEMAR S3 bucket returned, one total per UTC day. This includes internal reads such as Zarr conversions, so it is not a count of completed visitor downloads, and it has no location data.";
  root.appendChild(seriesKpi("Data downloaded", downloadInfo, function (payload, start, end) {
    const series = egressSeries(payload);
    if (!series) return { value: "Not measured", muted: true, context: "No download series is reporting." };
    const observed = observedTotal(series, start, end);
    if (!observed.measured) return { value: "Not measured", muted: true, context: "No days reported in these dates. Unknown is not zero.", delta: NO_COMPARISON };
    const change = matchedChange(series, start, end);
    const delta = change.matched ? percentDelta(change.current, change.previous, comparisonLabel(change.days)) : null;
    const notes = [observed.measured === observed.days
      ? "S3 bytes, " + rangePhrase(start, end) + "."
      : num(observed.measured) + " of " + plural(observed.days, "day", "days") + " reported, through " + shortDay(observed.last) + "."];
    if (delta && change.matched < change.days) notes.push("Change over the " + plural(change.matched, "day", "days") + " reported in both.");
    return {
      value: humanBytes(observed.total),
      exact: num(observed.total) + " bytes",
      delta: delta || NO_COMPARISON,
      context: notes.join(" "),
      spark: dailySpark(series, start, end, "NEMAR S3 downloads", humanBytes)
    };
  }));
  const countryInfo = "Countries and territories with reported Cloudflare requests in the selected dates. Small daily counts are withheld for privacy, and requests include automated traffic, so this is reach of the service, not a count of researchers.";
  root.appendChild(audienceKpi("Countries reached", countryInfo, function (payload, start, end) {
    const reach = countriesIn(payload);
    if (!reach) return { value: "Not measured", muted: true, context: payload.cloudflare.note ? "No country breakdown for these dates." : audienceStatus(payload.cloudflare.status) };
    const full = fullyMeasured(payload.cloudflare, start, end, "country_coverage");
    const covered = payload.cloudflare.country_coverage;
    const notes = [];
    if (!full && covered.start && covered.end) notes.push("Measured " + rangeText(covered.start, covered.end) + " only.");
    if (reach.top.length) notes.push("Most requests: " + reach.top.join(", "));
    return {
      value: num(reach.count),
      delta: full ? audienceComparison(function (prior, period) {
        if (!fullyMeasured(prior.cloudflare, period.start, period.end, "country_coverage")) return null;
        const before = countriesIn(prior);
        return before ? countDelta(reach.count, before.count, comparisonLabel(period.days)) : null;
      }) : NO_COMPARISON,
      context: notes.join(" ")
    };
  }));
  const visitorInfo = "Umami estimates anonymous unique sessions after consent. A session is not an identified person, and sessions are not added across days.";
  root.appendChild(audienceKpi("Website visitors", visitorInfo, function (payload, start, end) {
    const umami = payload.umami;
    if (typeof umami.visitors !== "number") {
      return {
        value: "Not measured",
        muted: true,
        context: umami.status === "unconfigured" ? "Website analytics are not reporting yet." : umami.status === "unavailable" ? "Website analytics are unavailable right now." : audienceStatus(umami.status) + "."
      };
    }
    const full = fullyMeasured(umami, start, end, "coverage");
    return {
      value: compact(umami.visitors),
      exact: num(umami.visitors) + " anonymous sessions",
      delta: full ? audienceComparison(function (prior, period) {
        return fullyMeasured(prior.umami, period.start, period.end, "coverage") ? percentDelta(umami.visitors, prior.umami.visitors, comparisonLabel(period.days)) : null;
      }) : NO_COMPARISON,
      context: "Anonymous unique sessions" + (umami.status === "partial" ? ", partial coverage" : "")
    };
  }));
  root.setAttribute("aria-busy", String((!state.audience && !state.audienceFailed && !state.audienceInvalid) || (!selectedSeries() && !state.seriesFailed)));
}

// ---------- all-time strip ----------
function allTimeItem(parent, spec) {
  const item = el("div", "alltime-item");
  const term = el("dt", null);
  term.appendChild(el("span", null, spec.label));
  if (spec.info) term.appendChild(infoDisclosure("About " + spec.label, spec.info));
  item.appendChild(term);
  if (spec.loading) {
    const value = el("dd", "alltime-value");
    value.appendChild(skeletonBlock("skeleton-line short"));
    item.appendChild(value);
  } else {
    const value = el("dd", "alltime-value" + (spec.muted ? " is-muted" : ""), spec.value);
    if (spec.exact) value.setAttribute("title", spec.exact);
    item.appendChild(value);
    if (spec.note) item.appendChild(el("dd", "alltime-note", spec.note));
  }
  parent.appendChild(item);
}
// Everything a daily series has reported, labeled from its first covered day
// and never stretched to cover the days before it.
function seriesSinceSpec(series, labelFrom, format, unit) {
  const toDate = seriesToDate(series);
  if (!toDate.reported || !toDate.since) return null;
  return {
    label: labelFrom + " since " + longDay(toDate.since),
    value: format(toDate.total),
    exact: num(toDate.total) + " " + unit,
    note: (toDate.reported === toDate.days ? plural(toDate.days, "day", "days") : num(toDate.reported) + " of " + plural(toDate.days, "day", "days")) + " reported, through " + longDay(toDate.through)
  };
}
function renderAllTime() {
  const root = document.getElementById("all-time");
  if (!root) return;
  root.textContent = "";
  const index = metricIndex(state.snapshot);
  const snapLoading = !state.snapshot && !state.snapshotFailed;
  const pub = index["datasets.public"];
  const priv = index["datasets.private"];
  const doi = index["datasets.with_doi"];
  const bytes = index["datasets.bytes"];
  const unavailable = { value: "Unavailable", muted: true, note: state.snapshotFailed ? "The latest snapshot did not load." : "Not in the latest snapshot." };
  function snapshotItem(label, metric, build) {
    if (snapLoading) return allTimeItem(root, { label: label, loading: true });
    const spec = metric ? build(metric) : Object.assign({}, unavailable);
    spec.label = label;
    allTimeItem(root, spec);
  }
  snapshotItem("Public datasets", pub, function (m) {
    const notes = [];
    const doiShare = doi ? pct(doi.value, doi.total) : null;
    if (doiShare != null) notes.push(doiShare + "% with a DOI");
    if (priv) notes.push(num(priv.value) + " private");
    const change = historyDelta("datasets.public", num);
    if (change) notes.push(change);
    return { value: num(m.value), note: notes.join(", "), info: "Datasets published and publicly visible now. A digital object identifier (DOI) makes a dataset citable." };
  });
  snapshotItem("Data volume", bytes, function (m) {
    const change = historyDelta("datasets.bytes", humanBytes);
    return { value: humanBytes(m.value), exact: num(m.value) + " bytes", note: (pub ? "Across " + num(pub.value) + " public datasets" : "Public datasets") + (change ? ", " + change : "") };
  });
  const archiveLoading = !state.archive && !state.archiveFailed;
  const archiveMissing = { value: "Unavailable", muted: true, note: "Daily usage did not load." };
  if (archiveLoading) {
    allTimeItem(root, { label: "Data downloaded", loading: true });
    allTimeItem(root, { label: "Requests", loading: true });
    allTimeItem(root, { label: "Usage measured since", loading: true });
  } else if (!state.archive) {
    allTimeItem(root, Object.assign({ label: "Data downloaded" }, archiveMissing));
    allTimeItem(root, Object.assign({ label: "Requests" }, archiveMissing));
    allTimeItem(root, Object.assign({ label: "Usage measured since" }, archiveMissing));
  } else {
    const egress = egressSeries(state.archive);
    const downloads = egress ? seriesSinceSpec(egress, "Downloaded", humanBytes, "bytes") : null;
    allTimeItem(root, downloads
      ? Object.assign(downloads, { info: "Bytes the NEMAR S3 bucket returned on each reported day, added up. Includes internal reads such as Zarr conversions." })
      : { label: "Data downloaded", value: "Not recorded", muted: true, note: "No download series is reporting." });
    const requests = requestSeries(state.archive);
    const requestTotal = requests ? seriesSinceSpec(requests, "Requests", compact, "requests") : null;
    allTimeItem(root, requestTotal || {
      label: "Requests to date",
      value: "Not recorded",
      muted: true,
      note: "Cloudflare keeps only the last 30 days",
      info: "Request totals come from Cloudflare, which keeps 30 days of zone analytics. No longer daily record exists yet, so a lifetime total would be a guess."
    });
    const starts = (state.archive.series || []).map(function (s) { return s.coverage_start; }).filter(function (d) { return typeof d === "string"; }).sort();
    allTimeItem(root, starts.length
      ? { label: "Usage measured since", value: longDay(starts[0]), note: "First day of stored daily usage" }
      : { label: "Usage measured since", value: "Not recorded", muted: true, note: "No daily usage is stored yet." });
  }
  root.setAttribute("aria-busy", String(snapLoading || archiveLoading));
}
function loadHistory() {
  HISTORY_KEYS.forEach(function (key) {
    fetch(API + "/snapshot/history?metric=" + encodeURIComponent(key))
      .then(function (r) { if (!r.ok) throw new Error("history " + r.status); return r.json(); })
      .then(function (body) {
        state.history[key] = (Array.isArray(body.points) ? body.points : []).filter(function (p) {
          return p && typeof p.value === "number" && Number.isFinite(p.value) && typeof p.at === "string";
        });
        renderAllTime();
      })
      .catch(function (err) {
        console.error("[ui] metric history failed:", key, err);
        state.history[key] = [];
      });
  });
}

`;
