// Date-range arithmetic and period comparisons, with no DOM access, so the
// tests can run this exact code.
//
// One range control drives every range-dependent figure. A comparison with the
// equal-length period before the range is shown only where both periods were
// really measured: days missing from either side are left out of both, never
// counted as zero.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const RANGE_JS = String.raw`
// ---------- date range ----------
// The widest span the API serves in one request.
const MAX_RANGE_DAYS = 3660;
// The network edge (Cloudflare zone analytics) keeps 30 UTC days, today
// included, so an earlier period cannot be measured and is not requested.
const CLOUDFLARE_RETENTION_DAYS = 30;
function isoDay(date) { return date.toISOString().slice(0, 10); }
function shiftDay(day, offset) { const d = new Date(day + "T00:00:00.000Z"); d.setUTCDate(d.getUTCDate() + offset); return isoDay(d); }
function rangeDays(start, end) { return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000) + 1; }
// A real calendar day in ISO form: the shape alone would accept 2026-02-31,
// which Date quietly rolls over to March 3, so the day must survive a round trip.
function isValidDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && isoDay(date) === day;
}
function validRange(start, end) {
  if (!isValidDay(start) || !isValidDay(end) || start > end) return false;
  return rangeDays(start, end) <= MAX_RANGE_DAYS;
}
function todayUtc() { return isoDay(new Date()); }
const PRESET_DAYS = [7, 30, 90, 365];
// Presets end yesterday (UTC), so every day they cover is complete.
function rangeFor(days, today) { const end = shiftDay(today || todayUtc(), -1); return { start: shiftDay(end, 1 - days), end: end }; }
function presetFor(start, end, today) {
  for (let i = 0; i < PRESET_DAYS.length; i++) {
    const r = rangeFor(PRESET_DAYS[i], today);
    if (r.start === start && r.end === end) return PRESET_DAYS[i];
  }
  return null;
}
// The day the website map shows for a range that is not one completed day: the
// newest closed UTC day inside it (its last day, or yesterday when the range
// reaches today), or null when the range holds no closed day. Website sessions
// are never summed or differenced across days, so the map stays on one day.
function geographyDayFor(start, end, today) {
  const t = today || todayUtc();
  const day = end < t ? end : shiftDay(t, -1);
  return day >= start ? day : null;
}
// Said on every card whose range reaches today (UTC), which is not over yet.
function inProgressNote(end, today) { return end >= (today || todayUtc()) ? "Today (UTC) is still in progress." : ""; }
// The equal-length period that ends the day before the range starts.
function priorRange(start, end) {
  const days = rangeDays(start, end);
  return { start: shiftDay(start, -days), end: shiftDay(start, -1), days: days };
}
// One daily-series request for this window holds every range the presets can
// choose, and the period before each, so switching ranges needs no request.
function seriesArchiveWindow(today) { return { start: shiftDay(today, 1 - MAX_RANGE_DAYS), end: today }; }

// ---------- period totals ----------
function pointValues(series) {
  const values = new Map();
  (series && Array.isArray(series.points) ? series.points : []).forEach(function (p) {
    if (p && typeof p.date === "string" && typeof p.value === "number" && Number.isFinite(p.value)) values.set(p.date, p.value);
  });
  return values;
}
// The sum of the days a series reported inside the range, and how many of the
// range's days that is. A day with no report is unknown and adds nothing.
function observedTotal(series, start, end) {
  const values = pointValues(series);
  let total = 0; let measured = 0;
  for (let d = start; d <= end; d = shiftDay(d, 1)) {
    if (values.has(d)) { total += values.get(d); measured++; }
  }
  return { total: total, measured: measured, days: rangeDays(start, end), last: lastObserved(values, start, end) };
}
function lastObserved(values, start, end) {
  let last = null;
  values.forEach(function (_, day) { if (day >= start && day <= end && (last === null || day > last)) last = day; });
  return last;
}
// Pairs each day of the range with the same position in the prior period and
// keeps only the pairs reported on both sides, so a missing day on either side
// cannot make the change look larger or smaller than it was.
function matchedChange(series, start, end) {
  const values = pointValues(series);
  const days = rangeDays(start, end);
  let current = 0; let previous = 0; let matched = 0;
  for (let d = start; d <= end; d = shiftDay(d, 1)) {
    const before = shiftDay(d, -days);
    if (values.has(d) && values.has(before)) { current += values.get(d); previous += values.get(before); matched++; }
  }
  return { current: current, previous: previous, matched: matched, days: days };
}
// Everything a series has reported inside the loaded window. The start is the
// later of the series' first covered day and the window's first day, so a
// window that cuts off earlier days is labeled as limited, never as lifetime.
function seriesToDate(series, windowStart) {
  const values = pointValues(series);
  let total = 0; let reported = 0; let first = null; let last = null;
  values.forEach(function (value, day) {
    if (windowStart && day < windowStart) return;
    total += value; reported++;
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
  });
  const covered = series && isValidDay(series.coverage_start) ? series.coverage_start : first;
  const clipped = Boolean(windowStart && covered && covered < windowStart);
  const since = clipped ? windowStart : covered;
  return {
    total: total,
    reported: reported,
    since: since,
    through: last,
    days: since && last ? rangeDays(since, last) : 0,
    clipped: clipped
  };
}

// ---------- change labels ----------
function comparisonLabel(days) { return "previous " + (days === 1 ? "day" : days.toLocaleString("en-US") + " days"); }
// The change from the prior period to this one. Invalid or missing numbers give
// null (the caller says there is no comparison). A prior period with nothing in
// it is a real measurement, not a gap: zero to zero is no change, and anything
// from zero is stated plainly because a percentage from zero is undefined.
function percentDelta(current, previous, versus) {
  if (typeof current !== "number" || typeof previous !== "number" || !Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous < 0) return null;
  if (previous === 0) {
    return current === 0
      ? { direction: "flat", text: "No change vs " + versus }
      : { direction: "none", text: "No activity in the " + versus };
  }
  const change = ((current - previous) / previous) * 100;
  const size = Math.abs(change) >= 10 ? Math.round(Math.abs(change)) : Math.round(Math.abs(change) * 10) / 10;
  if (size === 0) return { direction: "flat", text: "No change vs " + versus };
  return { direction: change > 0 ? "up" : "down", text: (change > 0 ? "+" : "−") + size.toLocaleString("en-US") + "% vs " + versus };
}
function countDelta(current, previous, versus) {
  if (typeof current !== "number" || typeof previous !== "number" || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const diff = current - previous;
  if (diff === 0) return { direction: "flat", text: "No change vs " + versus };
  return { direction: diff > 0 ? "up" : "down", text: (diff > 0 ? "+" : "−") + Math.abs(diff).toLocaleString("en-US") + " vs " + versus };
}
// Said in place of a change, each for its own reason: the earlier period was
// never measured, its request failed, or this period is only partly measured.
const NO_COMPARISON = { direction: "none", text: "No measured earlier period to compare" };
const COMPARISON_FAILED = { direction: "none", text: "Comparison unavailable, could not load the earlier period" };
const PARTIAL_PERIOD = { direction: "none", text: "Partial period, no comparison" };
`;
