import { describe, expect, test } from "bun:test";
import timeseries from "./fixtures/timeseries-2026-07-01-to-2026-09-28.json";
import { clientLogic } from "./helpers/client-logic";

const {
  seriesBuckets,
  seriesValue,
  exactSeriesValue,
  coveringWindow,
  seriesWindowFor,
  SERIES_CACHE_MS,
} = clientLogic([
  "seriesBuckets",
  "seriesValue",
  "exactSeriesValue",
  "coveringWindow",
  "seriesWindowFor",
  "SERIES_CACHE_MS",
]);

// The live S3 egress series (see the fixture's source line): one value per
// UTC day from 2026-08-01 through 2026-09-26, nothing after.
const egress = timeseries.response.series[0];
const valueOn = (day: string) => egress.points.find((p) => p.date === day)?.value;

describe("calendar buckets on the real egress series", () => {
  test("a week starting on a Sunday rolls back to its Monday", () => {
    // 2026-09-20 is a Sunday: its calendar week began Monday 2026-09-14.
    const [first] = seriesBuckets(egress, "2026-09-20", "2026-09-27", "week");
    expect(first).toMatchObject({ start: "2026-09-20", end: "2026-09-20", partial: true });
    expect(first.value).toBe(valueOn("2026-09-20"));
  });

  test("full weeks sum every reported day; partial weeks are marked", () => {
    const buckets = seriesBuckets(egress, "2026-09-02", "2026-09-20", "week");
    expect(
      buckets.map((b: { start: string; end: string; partial: boolean }) => [
        b.start,
        b.end,
        b.partial,
      ]),
    ).toEqual([
      ["2026-09-02", "2026-09-06", true],
      ["2026-09-07", "2026-09-13", false],
      ["2026-09-14", "2026-09-20", false],
    ]);
    let week = 0;
    for (let d = 7; d <= 13; d++) week += valueOn(`2026-09-${String(d).padStart(2, "0")}`) ?? 0;
    expect(buckets[1].value).toBe(week);
    expect(buckets[1].label).toBe("Week, Sep 7 to Sep 13, 2026");
    expect(buckets[0].label).toBe("Partial week, Sep 2 to Sep 6, 2026");
  });

  test("a bucket with any unreported day is unknown, never a partial sum or zero", () => {
    // Sep 27 was not reported yet, so the week of Sep 21 is unknown even though
    // six of its days were.
    const [week] = seriesBuckets(egress, "2026-09-21", "2026-09-27", "week");
    expect(week.value).toBeNull();
    const days = seriesBuckets(egress, "2026-09-25", "2026-09-28", "day");
    expect(days.map((b: { value: number | null }) => b.value)).toEqual([
      valueOn("2026-09-25"),
      valueOn("2026-09-26"),
      null,
      null,
    ]);
    // Before the series began, every day is unknown.
    for (const b of seriesBuckets(egress, "2026-07-29", "2026-07-31", "day"))
      expect(b.value).toBeNull();
  });

  test("months follow the calendar, including a partial first month", () => {
    const buckets = seriesBuckets(egress, "2026-07-15", "2026-09-30", "month");
    expect(
      buckets.map((b: { start: string; end: string; partial: boolean }) => [
        b.start,
        b.end,
        b.partial,
      ]),
    ).toEqual([
      ["2026-07-15", "2026-07-31", true],
      ["2026-08-01", "2026-08-31", false],
      ["2026-09-01", "2026-09-30", false],
    ]);
    expect(buckets[0].value).toBeNull();
    expect(buckets[1].label).toBe("August 2026");
    expect(typeof buckets[1].value).toBe("number");
    expect(buckets[2].value).toBeNull();
  });

  test("leap February and year boundaries fall where the calendar puts them", () => {
    const feb = seriesBuckets(egress, "2024-02-01", "2024-03-01", "month");
    expect(feb[0]).toMatchObject({ start: "2024-02-01", end: "2024-02-29", partial: false });
    expect(feb[1]).toMatchObject({ start: "2024-03-01", end: "2024-03-01", partial: true });
    // 2025-12-29 is a Monday; that week runs into 2026.
    const weeks = seriesBuckets(egress, "2025-12-29", "2026-01-11", "week");
    expect(weeks.map((b: { start: string; end: string }) => [b.start, b.end])).toEqual([
      ["2025-12-29", "2026-01-04"],
      ["2026-01-05", "2026-01-11"],
    ]);
    const months = seriesBuckets(egress, "2025-12-15", "2026-01-15", "month");
    expect(months.map((b: { start: string; end: string }) => [b.start, b.end])).toEqual([
      ["2025-12-15", "2025-12-31"],
      ["2026-01-01", "2026-01-15"],
    ]);
  });

  test("values format as bytes or counts, and unknown stays unknown", () => {
    expect(seriesValue(null, "bytes")).toBe("Unknown");
    expect(seriesValue(2704584579314, "bytes")).toBe("2.7 TB");
    expect(seriesValue(1234, "count")).toBe("1,234");
    expect(exactSeriesValue(2704584579314, "bytes")).toBe("2,704,584,579,314 B");
    expect(exactSeriesValue(null, "count")).toBe("Unknown");
  });
});

describe("request windows", () => {
  const today = "2026-09-28";

  test("ranges inside the archive window share one request", () => {
    const archive = seriesWindowFor("2026-09-21", "2026-09-27", today);
    // 3,660 days ending today: ten years (3,652 days with two leap days) plus 8.
    expect(archive).toEqual({ start: "2016-09-21", end: today });
    expect(seriesWindowFor("2026-01-01", "2026-06-30", today)).toEqual(archive);
  });

  test("a range beyond today gets its own request with its prior period", () => {
    expect(seriesWindowFor("2026-09-25", "2026-10-04", today)).toEqual({
      start: "2026-09-15",
      end: "2026-10-04",
    });
  });

  test("a window covers a range only until it expires; pending windows never expire", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    const loaded = [{ start: "2026-09-01", end: "2026-09-28", at: now - SERIES_CACHE_MS + 1 }];
    expect(coveringWindow(loaded, "2026-09-10", "2026-09-20", now)).toBe(loaded[0]);
    expect(coveringWindow(loaded, "2026-08-31", "2026-09-20", now)).toBeNull();
    expect(coveringWindow(loaded, "2026-09-10", "2026-09-20", now + 1)).toBeNull();
    const pending = [{ start: "2026-09-01", end: "2026-09-28" }];
    expect(coveringWindow(pending, "2026-09-10", "2026-09-20", now + 10 * SERIES_CACHE_MS)).toBe(
      pending[0],
    );
  });
});

describe("series freshness", () => {
  const { seriesFreshness } = clientLogic(["seriesFreshness"]);
  // The fixture's series declares a 36-hour allowance and last reported Sep 26,
  // so it is current until 36 hours after Sep 26 ends (Sep 28, 12:00 UTC).
  test("current within the declared allowance, stale after it", () => {
    expect(egress.freshness_after_hours).toBe(36);
    expect(seriesFreshness(egress, Date.parse("2026-09-28T11:59:00Z"))).toBe("current");
    expect(seriesFreshness(egress, Date.parse("2026-09-28T12:01:00Z"))).toBe("stale");
  });

  test("a series without a usable allowance is flagged, never assumed fresh", () => {
    const now = Date.parse("2026-09-27T00:00:00Z");
    for (const hours of [undefined, null, Number.NaN, 0, -5, "36"]) {
      expect(seriesFreshness({ ...egress, freshness_after_hours: hours }, now)).toBe("unknown");
    }
  });

  test("a series with no counted day is stale", () => {
    expect(
      seriesFreshness(
        { ...egress, latest_observation_date: null },
        Date.parse("2026-09-27T00:00:00Z"),
      ),
    ).toBe("stale");
  });
});
