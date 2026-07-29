// summarizeDaily is the defence against one client defining a 30-day metric
// (issue #9), so it is tested directly rather than only through a live AE
// query. The "real scraper" case uses the actual daily series pulled from the
// Analytics Engine on 2026-07-29.

import { describe, expect, test } from "bun:test";
import { summarizeDaily } from "../src/lib/access";

/** Dates as AE returns them (`toDate(timestamp)`), starting 2026-06-29. */
function dated(values: number[]): { date: string; value: number }[] {
  const start = Date.parse("2026-06-29T00:00:00Z");
  return values.map((value, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
}

/** The genuine archive series that motivated this: a ~20-50/day baseline, then
 *  one hour on the last day producing 2,588 events (on003947 + on003944). */
const REAL_ARCHIVE_SERIES = dated([
  41, 150, 53, 16, 21, 1, 4, 3, 9, 11, 8, 8, 53, 47, 37, 51, 11, 34, 38, 47, 14, 52, 51, 35, 13, 34,
  22, 22, 103, 22, 2588,
]);

describe("summarizeDaily", () => {
  test("reports the typical day, not the average, on the real scraper series", () => {
    const r = summarizeDaily({ points: REAL_ARCHIVE_SERIES });

    // Sum is 3,631 over 31 days -> mean ~117/day, which describes no day that
    // ever happened. The median describes almost every day.
    expect(r.medianDaily).toBe(34);
    expect(r.peak).toEqual({ date: "2026-07-29", value: 2588 });
    expect(r.isSpike).toBe(true);
    // One day is >70% of the entire window.
    expect(r.peakShare).toBeGreaterThan(0.7);
  });

  test("steady traffic is not flagged, even at high volume", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-07-${i + 1}`,
      value: 900 + (i % 5) * 40,
    }));
    const r = summarizeDaily({ points });
    expect(r.isSpike).toBe(false);
    expect(r.medianDaily).toBeGreaterThan(900);
  });

  // Genuine growth moves the median with it, so the threshold does not fire on
  // a busy week the way it does on a single anomalous day.
  test("a sustained 4x uptick over half the window is not a spike", () => {
    const points = [
      ...Array.from({ length: 15 }, (_, i) => ({ date: `2026-07-${i + 1}`, value: 20 })),
      ...Array.from({ length: 15 }, (_, i) => ({ date: `2026-07-${i + 16}`, value: 80 })),
    ];
    const r = summarizeDaily({ points });
    expect(r.isSpike).toBe(false);
  });

  test("one day at exactly the threshold does not trip it; just above does", () => {
    const base = Array.from({ length: 9 }, (_, i) => ({ date: `2026-07-${i + 1}`, value: 10 }));
    expect(summarizeDaily({ points: [...base, { date: "2026-07-10", value: 50 }] }).isSpike).toBe(
      false,
    );
    expect(summarizeDaily({ points: [...base, { date: "2026-07-10", value: 51 }] }).isSpike).toBe(
      true,
    );
  });

  test("empty window yields no peak and no spike rather than a divide-by-zero", () => {
    expect(summarizeDaily({ points: [] })).toEqual({
      medianDaily: 0,
      peak: null,
      isSpike: false,
      peakShare: 0,
    });
  });

  // A single active day among quiet ones is not evidence of abuse: with a
  // zero median there is nothing to be 5x of, so it must not be flagged.
  test("a single day of activity is not a spike", () => {
    const r = summarizeDaily({ points: [{ date: "2026-07-01", value: 500 }] });
    expect(r.isSpike).toBe(false);
    expect(r.medianDaily).toBe(500);
    expect(r.peakShare).toBe(1);
  });
});
