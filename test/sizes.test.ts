// The size histogram's binning (#22).
//
// Log bins are not a style choice: public dataset sizes span seven orders of
// magnitude (0.36 MB to 9.58 TB, median 13 GB), and twenty equal-width bins put
// 736 of 754 datasets in the first bar with 13 bins empty. The 1-2-5 boundaries
// are chosen so 100 GB -- the archive cutoff (nemar-cli #752) -- is an exact bin
// edge and can be marked honestly.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sizesSection } from "../src/lib/metrics";
import { ARCHIVE_CUTOFF_BYTES, buildSizeHistogram, sizeBinEdges } from "../src/lib/sizes";
import { asD1 } from "./helpers/d1";

const GB = 1_000_000_000;
const MB = 1_000_000;

describe("sizeBinEdges", () => {
  // The property the whole design rests on.
  test("100 GB is an exact boundary, so the archive cutoff can be marked", () => {
    expect(sizeBinEdges()).toContain(ARCHIVE_CUTOFF_BYTES);
  });

  test("edges ascend and follow a 1-2-5 progression", () => {
    const e = sizeBinEdges();
    for (let i = 1; i < e.length; i++) expect(e[i]).toBeGreaterThan(e[i - 1]);
    expect(e[0]).toBe(MB);
    expect(e.slice(0, 6)).toEqual([1 * MB, 2 * MB, 5 * MB, 10 * MB, 20 * MB, 50 * MB]);
  });
});

describe("buildSizeHistogram", () => {
  test("labels the bin whose lower edge is the cutoff", () => {
    const bins = buildSizeHistogram([150 * GB]);
    const marked = bins.filter((b) => b.label.includes("cutoff"));
    expect(marked).toHaveLength(1);
    expect(marked[0].label).toContain("100 GB");
    // The 150 GB dataset lands in that very bin.
    expect(marked[0].value).toBe(1);
  });

  test("a value on a boundary falls in the bin that boundary opens", () => {
    // Exactly 100 GB is NOT above the cutoff -- it opens the cutoff bin.
    const bins = buildSizeHistogram([ARCHIVE_CUTOFF_BYTES]);
    expect(bins.find((b) => b.label.includes("cutoff"))?.value).toBe(1);
  });

  test("sub-1 MB datasets get an underflow bin rather than being dropped", () => {
    const bins = buildSizeHistogram([360_000]);
    expect(bins[0].label).toBe("< 1 MB");
    expect(bins[0].value).toBe(1);
  });

  test("every dataset lands in exactly one bin", () => {
    const sizes = [360_000, 5 * MB, 13 * GB, 99 * GB, 100 * GB, 9581 * GB];
    const total = buildSizeHistogram(sizes).reduce((n, b) => n + b.value, 0);
    expect(total).toBe(sizes.length);
  });

  test("zero and negative sizes are ignored, not bucketed", () => {
    expect(buildSizeHistogram([0, -1, 5 * GB]).reduce((n, b) => n + b.value, 0)).toBe(1);
  });

  // Empty bins are structural: dropping them would make the axis non-uniform
  // and misrepresent the shape of the distribution.
  test("empty bins are retained so the axis stays uniform", () => {
    const bins = buildSizeHistogram([5 * MB, 9581 * GB]);
    expect(bins.filter((b) => b.value === 0).length).toBeGreaterThan(5);
    expect(bins).toHaveLength(sizeBinEdges().length + 1);
  });

  // The distribution as actually measured in production on 2026-07-29: this is
  // what makes log binning necessary rather than merely tidier.
  test("spreads the real catalog shape instead of piling it into one bar", () => {
    const sizes = [
      ...Array.from({ length: 129 }, () => 500 * MB), // under 1 GB
      ...Array.from({ length: 500 }, () => 13 * GB), // around the median
      ...Array.from({ length: 117 }, () => 300 * GB), // above the cutoff
      9581 * GB,
    ];
    const bins = buildSizeHistogram(sizes);
    const nonEmpty = bins.filter((b) => b.value > 0);
    expect(nonEmpty.length).toBeGreaterThan(1);
    // No single bin swallows the catalog the way a linear bin 1 would (98%).
    const biggest = Math.max(...bins.map((b) => b.value));
    expect(biggest / sizes.length).toBeLessThan(0.8);
  });
});

describe("sizesSection", () => {
  const DDL = `CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, is_sandbox INTEGER DEFAULT 0,
    status TEXT, visibility TEXT, file_size INTEGER);`;

  function db(rows: [string, number | null][]) {
    const engine = new Database(":memory:");
    engine.run(DDL);
    for (const [id, size] of rows) {
      engine
        .query(
          "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, file_size) VALUES (?,1,0,'active','public',?)",
        )
        .run(id, size);
    }
    return engine;
  }

  test("declares the split layout the histogram needs", async () => {
    const engine = db([["a", 5 * GB]]);
    const s = await sizesSection(asD1(engine), "2026-07-29T14:00:00.000Z");
    expect(s.key).toBe("sizes");
    expect(s.layout).toBe("split");
    engine.close();
  });

  test("ranks the largest datasets descending and caps at 10", async () => {
    const engine = db(
      Array.from({ length: 15 }, (_, i) => [`ds${i}`, (i + 1) * GB]) as [string, number][],
    );
    const s = await sizesSection(asD1(engine), "2026-07-29T14:00:00.000Z");
    const largest = s.metrics.find((m) => m.key === "sizes.largest");
    expect(largest?.breakdown).toHaveLength(10);
    expect(largest?.breakdown?.[0]).toEqual({ label: "ds14", value: 15 * GB });
    expect(largest?.breakdown_unit).toBe("bytes");
    engine.close();
  });

  // A NULL file_size must not become a 0-byte dataset in the distribution.
  test("ignores rows with no recorded size", async () => {
    const engine = db([
      ["sized", 5 * GB],
      ["unknown", null],
    ]);
    const s = await sizesSection(asD1(engine), "2026-07-29T14:00:00.000Z");
    expect(s.metrics.find((m) => m.key === "sizes.histogram")?.value).toBe(1);
    engine.close();
  });

  test("an empty catalog still returns a well-formed section", async () => {
    const engine = db([]);
    const s = await sizesSection(asD1(engine), "2026-07-29T14:00:00.000Z");
    expect(s.metrics).toHaveLength(2);
    expect(s.metrics[0].value).toBe(0);
    engine.close();
  });
});
