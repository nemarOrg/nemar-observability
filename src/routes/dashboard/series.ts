// Daily-series logic with no DOM access, so the tests can run this exact code:
// calendar bucketing, value formatting, and which loaded request window covers
// a range. usage.ts renders the results.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const SERIES_JS = String.raw`
// ---------- request windows ----------
const SERIES_CACHE_MS = 15 * 60000;
// The first loaded or pending window that holds the whole range and has not
// expired. Pending entries carry no timestamp and never expire.
function coveringWindow(list, start, end, now) {
  const at = typeof now === "number" ? now : Date.now();
  return list.find(function (w) { return w.start <= start && w.end >= end && (!w.at || at - w.at < SERIES_CACHE_MS); }) || null;
}
// The window to request for a range: the archive window when the range fits
// inside it, else the range with its prior period when that stays within the
// API's span, else the range alone.
function seriesWindowFor(start, end, today) {
  const archive = seriesArchiveWindow(today || isoDay(new Date()));
  if (start >= archive.start && end <= archive.end) return archive;
  const prior = priorRange(start, end);
  return rangeDays(prior.start, end) <= MAX_RANGE_DAYS ? { start: prior.start, end: end } : { start: start, end: end };
}

// ---------- calendar buckets ----------
// Days, calendar weeks (Monday first), or calendar months between start and
// end. A bucket's value is the sum of its days only when every day was
// reported; one missing day makes it null (unknown), never a partial sum and
// never zero. First and last buckets cut by the range are marked partial.
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
`;
