import { describe, expect, test } from "bun:test";
import { RANGE_JS } from "../src/routes/dashboard/range";

// The page's own range code, run as the browser runs it: the same source,
// evaluated in one function scope, with no DOM needed.
const range = new Function(
  `${RANGE_JS}\nreturn { MAX_RANGE_DAYS, shiftDay, rangeDays, validRange, priorRange, seriesArchiveWindow, observedTotal, matchedChange, percentDelta, countDelta, comparisonLabel, NO_COMPARISON };`,
)();

// A daily series as GET /api/timeseries returns it, reporting 1 kB on each
// listed day. Days not listed were not reported.
function bytesSeries(days: string[], coverageStart = days[0]) {
  return {
    section: "egress",
    key: "s3_bytes_downloaded",
    unit: "bytes",
    coverage_start: coverageStart,
    coverage_end: days[days.length - 1],
    points: days.map((date) => ({ date, value: 1000 })),
  };
}
function daysFrom(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("dashboard date ranges", () => {
  test("the prior period has the same length and ends the day before", () => {
    expect(range.priorRange("2026-09-21", "2026-09-27")).toEqual({
      start: "2026-09-14",
      end: "2026-09-20",
      days: 7,
    });
    expect(range.priorRange("2026-03-01", "2026-03-01")).toEqual({
      start: "2026-02-28",
      end: "2026-02-28",
      days: 1,
    });
    expect(range.rangeDays("2024-02-28", "2024-03-01")).toBe(3);
  });

  test("valid ranges are ordered ISO days within the API span", () => {
    expect(range.validRange("2026-09-01", "2026-09-30")).toBe(true);
    expect(range.validRange("2026-09-30", "2026-09-01")).toBe(false);
    expect(range.validRange("", "2026-09-01")).toBe(false);
    expect(range.validRange("2016-01-01", "2026-09-01")).toBe(false);
  });

  test("one archive request covers every preset and the period before it", () => {
    const today = "2026-09-28";
    const archive = range.seriesArchiveWindow(today);
    expect(range.rangeDays(archive.start, archive.end)).toBe(range.MAX_RANGE_DAYS);
    // Presets end yesterday; each one's prior period must be inside too.
    const yesterday = range.shiftDay(today, -1);
    for (const days of [7, 30, 90, 365]) {
      const prior = range.priorRange(range.shiftDay(yesterday, 1 - days), yesterday);
      expect(prior.start >= archive.start).toBe(true);
      expect(yesterday <= archive.end).toBe(true);
    }
  });
});

describe("dashboard period totals", () => {
  // Reported Sep 14 to Sep 26; nothing yet for Sep 27.
  const series = bytesSeries(daysFrom("2026-09-14", 13));

  test("a range total adds only reported days and says how many there were", () => {
    const total = range.observedTotal(series, "2026-09-21", "2026-09-27");
    expect(total).toEqual({ total: 6000, measured: 6, days: 7, last: "2026-09-26" });
  });

  test("a change pairs only days reported in both periods", () => {
    // Sep 27 has no report, so its pair (Sep 20) is left out of both sides.
    expect(range.matchedChange(series, "2026-09-21", "2026-09-27")).toEqual({
      current: 6000,
      previous: 6000,
      matched: 6,
      days: 7,
    });
    // Before the series began there is nothing to pair with.
    expect(range.matchedChange(series, "2026-09-14", "2026-09-20").matched).toBe(0);
  });
});

describe("dashboard change labels", () => {
  const versus = range.comparisonLabel(7);

  test("percent changes round sensibly and name the comparison", () => {
    expect(versus).toBe("previous 7 days");
    expect(range.comparisonLabel(1)).toBe("previous day");
    expect(range.percentDelta(166, 100, versus)).toEqual({
      direction: "up",
      text: "+66% vs previous 7 days",
    });
    expect(range.percentDelta(95.5, 100, versus)).toEqual({
      direction: "down",
      text: "−4.5% vs previous 7 days",
    });
    expect(range.percentDelta(100, 100, versus)?.direction).toBe("flat");
  });

  test("no change is claimed against an empty or unknown prior period", () => {
    expect(range.percentDelta(10, 0, versus)).toBeNull();
    expect(range.percentDelta(10, null, versus)).toBeNull();
    expect(range.countDelta(158, 145, versus)).toEqual({
      direction: "up",
      text: "+13 vs previous 7 days",
    });
    expect(range.NO_COMPARISON.direction).toBe("none");
  });
});
