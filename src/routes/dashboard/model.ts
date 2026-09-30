// What the page decides before it draws anything, with no DOM access, so the
// tests can run this exact code: which answers are well formed, when the prior
// period is worth requesting, which change (or plain statement) a card shows,
// how request answers are shared and ordered, and what the all-time strip says.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const MODEL_JS = String.raw`
// ---------- response shapes ----------
// A well-formed answer is checked where it arrives, so a bad one is reported as
// an unexpected response instead of failing later as a drawing error, and is
// never cached.
function unexpectedResponse(what) {
  const error = new Error("The server sent an unexpected response for " + what + ".");
  error.unexpected = true;
  return error;
}
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validTimeseries(body) {
  return isObject(body) && Array.isArray(body.series) && body.series.every(function (s) {
    return isObject(s) && typeof s.section === "string" && typeof s.unit === "string" && Array.isArray(s.points)
      && typeof s.coverage_start === "string" && typeof s.coverage_end === "string";
  });
}
function validAudienceSource(source) {
  return isObject(source) && typeof source.status === "string" && (source.countries === undefined || Array.isArray(source.countries));
}
function validAudience(body) { return isObject(body) && validAudienceSource(body.cloudflare) && validAudienceSource(body.umami); }
function validSnapshot(body) {
  return isObject(body) && Array.isArray(body.sections)
    && body.sections.every(function (s) { return isObject(s) && typeof s.key === "string" && Array.isArray(s.metrics); })
    && (body.section_errors === undefined || Array.isArray(body.section_errors));
}
function validHistory(body) { return isObject(body) && Array.isArray(body.points); }

// ---------- shared requests ----------
// One request per key, shared while it is fresh: asking again for the same
// dates reuses the answer instead of querying again. A request that fails is
// forgotten at once, so the next ask retries rather than replaying the failure.
function createRequestCache(load, ttlMs, clock) {
  const entries = new Map();
  const now = clock || Date.now;
  function get(key) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    const promise = Promise.resolve().then(function () { return load(key); });
    entries.set(key, { at: now(), promise: promise });
    promise.catch(function () { forget(key, promise); });
    return promise;
  }
  function forget(key, promise) {
    const hit = entries.get(key);
    if (hit && (!promise || hit.promise === promise)) entries.delete(key);
  }
  return { get: get, forget: forget, size: function () { return entries.size; } };
}
// Only the newest request may change the page: an older answer that arrives
// late is dropped.
function createLatestGuard() {
  let latest = 0;
  return {
    begin: function () { latest += 1; return latest; },
    isCurrent: function (token) { return token === latest; }
  };
}

// ---------- snapshot lookups ----------
function metricIndex(snap) {
  const index = {};
  (snap && Array.isArray(snap.sections) ? snap.sections : []).forEach(function (section) {
    (section.metrics || []).forEach(function (metric) { index[metric.key] = metric; });
  });
  return index;
}
// The change across the hourly snapshot history, as text, or null without two
// usable points.
function historyDelta(points, formatter) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0]; const last = points[points.length - 1];
  const diff = last.value - first.value;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600000;
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(diff)) return null;
  const span = hours < 36 ? " in " + plural(Math.round(hours), "hour", "hours") : " in " + plural(Math.round(hours / 24), "day", "days");
  if (diff === 0) return "No change" + span;
  return (diff > 0 ? "+" : "−") + formatter(Math.abs(diff)) + span;
}
function egressSeries(payload) {
  return ((payload && payload.series) || []).find(function (s) { return String(s.section).toLowerCase() === "egress" && s.unit === "bytes"; }) || null;
}
function requestSeries(payload) {
  return ((payload && payload.series) || []).find(function (s) {
    return String(s.section).toLowerCase() === "cf" && s.key === "requests" && s.unit === "count";
  }) || null;
}

// ---------- audience comparisons ----------
// The period before the selected one is requested only when it could be fully
// measured: the network edge keeps 30 days, and a partly covered current
// period has nothing like-for-like to compare against.
function priorAudienceWanted(payload, prior, today) {
  const oldestKept = shiftDay(today || isoDay(new Date()), 1 - CLOUDFLARE_RETENTION_DAYS);
  const cloudflare = payload.cloudflare && payload.cloudflare.status === "available" && prior.start >= oldestKept;
  const umami = payload.umami && payload.umami.status === "available";
  return Boolean(cloudflare || umami);
}
// A source measured a period only when it reports it available and its
// coverage is exactly the period.
function fullyMeasured(source, start, end, coverageKey) {
  const coverage = source && source[coverageKey];
  return Boolean(source && source.status === "available" && coverage && coverage.start === start && coverage.end === end);
}
// The change against the prior period, from compute(priorPayload, period), or
// the plain statement that there is none. Null while either period loads.
// current is { start, end, payload } or null; prior is the prior-period state
// { start, end, payload, loading, failed } or null.
function comparisonFor(current, currentLoading, prior, compute) {
  if (!current || currentLoading || !prior || prior.loading) return null;
  const expected = priorRange(current.start, current.end);
  if (prior.start !== expected.start || prior.end !== expected.end) return NO_COMPARISON;
  if (prior.failed) return COMPARISON_FAILED;
  if (!prior.payload) return NO_COMPARISON;
  return compute(prior.payload, expected) || NO_COMPARISON;
}

// ---------- all-time strip ----------
// What each item of the strip says, from the snapshot, its history, and the
// archive-window daily series. An item with nothing recorded says so; it is
// never shown as zero.
function allTimeSpecs(input) {
  const specs = [];
  const snap = input.snapshot;
  const index = metricIndex(snap);
  const snapLoading = !snap && !input.snapshotFailed;
  const history = input.history || {};
  const historyFailed = input.historyFailed || {};
  function snapshotItem(label, key, build) {
    const metric = index[key];
    if (snapLoading) { specs.push({ label: label, loading: true }); return; }
    if (!metric) {
      specs.push({ label: label, value: "Unavailable", muted: true, note: input.snapshotFailed ? "The latest snapshot did not load." : "Not in the latest snapshot." });
      return;
    }
    const spec = build(metric);
    spec.label = label;
    specs.push(spec);
  }
  function change(key, formatter) {
    if (historyFailed[key]) return "recent change could not load";
    return historyDelta(history[key], formatter);
  }
  snapshotItem("Public datasets", "datasets.public", function (m) {
    const doi = index["datasets.with_doi"];
    const priv = index["datasets.private"];
    const notes = [];
    const doiShare = doi ? pct(doi.value, doi.total) : null;
    if (doiShare != null) notes.push(doiShare + "% with a DOI");
    if (priv) notes.push(num(priv.value) + " private");
    const recent = change("datasets.public", num);
    if (recent) notes.push(recent);
    return { value: num(m.value), exact: num(m.value) + " public datasets", note: (notes.length ? "Now: " + notes.join(", ") : "Now"), info: "Datasets published and publicly visible now. A digital object identifier (DOI) makes a dataset citable." };
  });
  snapshotItem("Data volume", "datasets.bytes", function (m) {
    const pub = index["datasets.public"];
    const recent = change("datasets.bytes", humanBytes);
    return { value: humanBytes(m.value), exact: num(m.value) + " bytes", note: "Now: " + (pub ? "across " + num(pub.value) + " public datasets" : "public datasets") + (recent ? ", " + recent : "") };
  });
  const archive = input.archive;
  const archiveLoading = !archive && !input.archiveFailed;
  const labels = { downloads: "Data served", requests: "Requests", since: "Usage records begin" };
  if (archiveLoading || !archive) {
    [labels.downloads, labels.requests, labels.since].forEach(function (label) {
      specs.push(archiveLoading ? { label: label, loading: true } : { label: label, value: "Unavailable", muted: true, note: "Daily usage did not load." });
    });
    return specs;
  }
  const windowStart = input.archiveWindow && input.archiveWindow.start;
  function lifetime(series, label, format, unit) {
    const toDate = seriesToDate(series, windowStart);
    if (!toDate.reported || !toDate.since) return null;
    const reported = toDate.reported === toDate.days
      ? plural(toDate.days, "day", "days") + " reported"
      : num(toDate.reported) + " of " + plural(toDate.days, "day", "days") + " reported";
    return {
      label: label,
      value: format(toDate.total),
      exact: num(toDate.total) + " " + unit,
      note: "Since " + longDay(toDate.since) + ", " + reported + ", through " + longDay(toDate.through)
        + (toDate.clipped ? "; window limited to the last " + num(MAX_RANGE_DAYS) + " days" : ""),
      clipped: toDate.clipped
    };
  }
  const egress = egressSeries(archive);
  specs.push((egress && lifetime(egress, labels.downloads, humanBytes, "bytes")) || {
    label: labels.downloads, value: "Not recorded", muted: true, note: "No storage egress series is reporting."
  });
  const requests = requestSeries(archive);
  specs.push((requests && lifetime(requests, labels.requests, compact, "requests")) || {
    label: labels.requests,
    value: "Not recorded",
    muted: true,
    note: "Daily totals are not stored yet",
    info: "Request totals come from the network edge, which keeps only 30 days of analytics. Each day is saved as it is fetched, so the lifetime total starts once the first day is stored."
  });
  const starts = (archive.series || []).map(function (s) { return s.coverage_start; }).filter(isValidDay).sort();
  specs.push(starts.length
    ? { label: labels.since, value: longDay(starts[0]), note: "First day of stored daily usage" }
    : { label: labels.since, value: "Not recorded", muted: true, note: "No daily usage is stored yet." });
  return specs;
}
`;
