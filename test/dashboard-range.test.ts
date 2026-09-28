import { describe, expect, test } from "bun:test";
import timeseries from "./fixtures/timeseries-2026-07-01-to-2026-09-28.json";
import { clientLogic } from "./helpers/client-logic";

const range = clientLogic([
  "MAX_RANGE_DAYS",
  "shiftDay",
  "rangeDays",
  "isValidDay",
  "validRange",
  "rangeFor",
  "presetFor",
  "priorRange",
  "seriesArchiveWindow",
  "observedTotal",
  "matchedChange",
  "seriesToDate",
  "percentDelta",
  "countDelta",
  "comparisonLabel",
  "NO_COMPARISON",
  "COMPARISON_FAILED",
  "PARTIAL_PERIOD",
]);

// The live S3 egress series (see the fixture's source line): one value per
// UTC day from 2026-08-01 through 2026-09-26, nothing reported after.
const egress = timeseries.response.series[0];
const sumOf = (days: string[]) =>
  days.reduce((total, day) => total + (egress.points.find((p) => p.date === day)?.value ?? 0), 0);
const septemberDays = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `2026-09-${String(from + i).padStart(2, "0")}`);

describe("dashboard date ranges", () => {
  test("only real calendar days are valid", () => {
    expect(range.isValidDay("2024-02-29")).toBe(true);
    for (const day of [
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
      "2025-02-29",
      "2026-9-01",
      "",
      null,
    ]) {
      expect(range.isValidDay(day)).toBe(false);
    }
    expect(range.validRange("2026-02-31", "2026-03-05")).toBe(false);
    expect(range.validRange("2026-13-01", "2026-13-02")).toBe(false);
    expect(range.validRange("2026-00-10", "2026-01-10")).toBe(false);
  });

  test("valid ranges are ordered and span at most 3,660 days", () => {
    expect(range.validRange("2026-09-01", "2026-09-30")).toBe(true);
    expect(range.validRange("2026-09-30", "2026-09-01")).toBe(false);
    expect(range.validRange("", "2026-09-01")).toBe(false);
    // 2016-09-21 to 2026-09-28 is exactly 3,660 days; one more is too many.
    expect(range.rangeDays("2016-09-21", "2026-09-28")).toBe(3660);
    expect(range.validRange("2016-09-21", "2026-09-28")).toBe(true);
    expect(range.validRange("2016-09-20", "2026-09-28")).toBe(false);
  });

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

  test("presets end yesterday (UTC) and round-trip to their length", () => {
    const today = "2026-09-28";
    expect(range.rangeFor(7, today)).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(range.rangeFor(30, today)).toEqual({ start: "2026-08-29", end: "2026-09-27" });
    expect(range.rangeFor(365, "2024-03-01")).toEqual({ start: "2023-03-02", end: "2024-02-29" });
    for (const days of [7, 30, 90, 365]) {
      const preset = range.rangeFor(days, today);
      expect(range.rangeDays(preset.start, preset.end)).toBe(days);
      expect(range.presetFor(preset.start, preset.end, today)).toBe(days);
    }
    // Same length, other dates: not a preset.
    expect(range.presetFor("2026-09-20", "2026-09-26", today)).toBeNull();
    expect(range.presetFor("2026-09-21", "2026-09-27", "2026-09-29")).toBeNull();
  });

  test("one archive request covers every preset and the period before it", () => {
    const archive = range.seriesArchiveWindow("2026-09-28");
    expect(archive).toEqual({ start: "2016-09-21", end: "2026-09-28" });
    // The longest preset: 365 days ending Sep 27, 2026, prior period from
    // Sep 28, 2024, well inside the window.
    const year = range.rangeFor(365, "2026-09-28");
    expect(range.priorRange(year.start, year.end)).toEqual({
      start: "2024-09-28",
      end: "2025-09-27",
      days: 365,
    });
    expect("2024-09-28" > archive.start).toBe(true);
  });
});

describe("dashboard period totals on the real egress series", () => {
  test("a range total adds only reported days and says how many there were", () => {
    expect(range.observedTotal(egress, "2026-09-21", "2026-09-27")).toEqual({
      total: sumOf(septemberDays(21, 26)),
      measured: 6,
      days: 7,
      last: "2026-09-26",
    });
  });

  test("a change pairs only days reported in both periods", () => {
    // Sep 27 has no report, so its pair (Sep 20) is left out of both sides.
    expect(range.matchedChange(egress, "2026-09-21", "2026-09-27")).toEqual({
      current: sumOf(septemberDays(21, 26)),
      previous: sumOf(septemberDays(14, 19)),
      matched: 6,
      days: 7,
    });
    // The week before the series began has nothing to pair with.
    expect(range.matchedChange(egress, "2026-08-01", "2026-08-07").matched).toBe(0);
  });

  test("a lifetime total starts at the series' coverage", () => {
    const all = range.seriesToDate(egress, "2016-09-21");
    expect(all).toMatchObject({
      reported: 57,
      since: "2026-08-01",
      through: "2026-09-26",
      days: 57,
      clipped: false,
    });
    expect(all.total).toBe(egress.points.reduce((t, p) => t + p.value, 0));
  });

  test("a window that cuts off earlier days is limited, never lifetime", () => {
    const clipped = range.seriesToDate(egress, "2026-09-01");
    expect(clipped).toEqual({
      total: sumOf(septemberDays(1, 26)),
      reported: 26,
      since: "2026-09-01",
      through: "2026-09-26",
      days: 26,
      clipped: true,
    });
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
    expect(range.percentDelta(100.04, 100, versus)).toEqual({
      direction: "flat",
      text: "No change vs previous 7 days",
    });
  });

  test("a measured empty prior period is stated, not called unmeasured", () => {
    expect(range.percentDelta(10, 0, versus)).toEqual({
      direction: "none",
      text: "No activity in the previous 7 days",
    });
    expect(range.percentDelta(0, 0, versus)).toEqual({
      direction: "flat",
      text: "No change vs previous 7 days",
    });
  });

  test("an unknown prior period gives no change at all", () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(range.percentDelta(10, bad, versus)).toBeNull();
    }
    expect(range.percentDelta(null, 10, versus)).toBeNull();
    expect(range.countDelta(158, 145, versus)).toEqual({
      direction: "up",
      text: "+13 vs previous 7 days",
    });
    expect(range.countDelta(158, null, versus)).toBeNull();
  });

  test("each reason for no comparison has its own words", () => {
    const texts = [range.NO_COMPARISON, range.COMPARISON_FAILED, range.PARTIAL_PERIOD].map(
      (c) => c.text,
    );
    expect(new Set(texts).size).toBe(3);
    expect(range.COMPARISON_FAILED.text).toBe(
      "Comparison unavailable, could not load the earlier period",
    );
    expect(range.PARTIAL_PERIOD.text).toBe("Partial period, no comparison");
    for (const c of [range.NO_COMPARISON, range.COMPARISON_FAILED, range.PARTIAL_PERIOD]) {
      expect(c.direction).toBe("none");
    }
  });
});
