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
// Cloudflare zone analytics keep 30 UTC days, today included, so an earlier
// period cannot be measured and is not requested.
const CLOUDFLARE_RETENTION_DAYS = 30;
function isoDay(date) { return date.toISOString().slice(0, 10); }
function shiftDay(day, offset) { const d = new Date(day + "T00:00:00.000Z"); d.setUTCDate(d.getUTCDate() + offset); return isoDay(d); }
function rangeDays(start, end) { return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000) + 1; }
function validRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(end || "") || start > end) return false;
  const days = rangeDays(start, end);
  return Number.isFinite(days) && days <= MAX_RANGE_DAYS;
}
// Presets end yesterday, so every day they cover is complete.
function rangeFor(days) { const end = shiftDay(isoDay(new Date()), -1); return { start: shiftDay(end, 1 - days), end: end }; }
function presetFor(start, end) {
  const presets = [7, 30, 90, 365];
  for (let i = 0; i < presets.length; i++) {
    const r = rangeFor(presets[i]);
    if (r.start === start && r.end === end) return presets[i];
  }
  return null;
}
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
// Everything a series has reported, from its first covered day.
function seriesToDate(series) {
  const values = pointValues(series);
  let total = 0; let first = null; let last = null;
  values.forEach(function (value, day) {
    total += value;
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
  });
  const since = series && typeof series.coverage_start === "string" ? series.coverage_start : first;
  return {
    total: total,
    reported: values.size,
    since: since,
    through: last,
    days: since && last ? rangeDays(since, last) : 0
  };
}

// ---------- change labels ----------
function comparisonLabel(days) { return "previous " + (days === 1 ? "day" : days.toLocaleString("en-US") + " days"); }
function percentDelta(current, previous, versus) {
  if (typeof current !== "number" || typeof previous !== "number" || !Number.isFinite(current) || !(previous > 0)) return null;
  const change = ((current - previous) / previous) * 100;
  const size = Math.abs(change) >= 10 ? Math.round(Math.abs(change)) : Math.round(Math.abs(change) * 10) / 10;
  if (size === 0) return { direction: "flat", text: "No change vs " + versus };
  return { direction: change > 0 ? "up" : "down", text: (change > 0 ? "+" : "−") + size.toLocaleString("en-US") + "% vs " + versus };
}
function countDelta(current, previous, versus) {
  if (typeof current !== "number" || typeof previous !== "number") return null;
  const diff = current - previous;
  if (diff === 0) return { direction: "flat", text: "No change vs " + versus };
  return { direction: diff > 0 ? "up" : "down", text: (diff > 0 ? "+" : "−") + Math.abs(diff).toLocaleString("en-US") + " vs " + versus };
}
// Said in place of a change when the prior period was not fully measured.
const NO_COMPARISON = { direction: "none", text: "No measured earlier period to compare" };
`;
