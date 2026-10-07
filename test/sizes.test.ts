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
import { SectionSchema } from "../src/lib/schema";
import {
  ARCHIVE_CUTOFF_BYTES,
  SIZE_MODALITIES,
  buildSizeHistogram,
  modalityCodes,
  sizeBinEdges,
} from "../src/lib/sizes";
import { asD1 } from "./helpers/d1";
import { JARGON } from "./helpers/public-copy";

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
    status TEXT, visibility TEXT, file_size INTEGER, modalities TEXT);`;

  function db(rows: [string, number | null, string?][]) {
    const engine = new Database(":memory:");
    engine.run(DDL);
    for (const [id, size, modalities] of rows) {
      engine
        .query(
          "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, file_size, modalities) VALUES (?,1,0,'active','public',?,?)",
        )
        .run(id, size, modalities ?? null);
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

describe("modalityCodes", () => {
  test("reads the stored csv as lowercase codes, without blanks or spacing", () => {
    expect([...modalityCodes("eeg,ieeg")]).toEqual(["eeg", "ieeg"]);
    expect([...modalityCodes(" EEG , iEEG ,, MEG ")]).toEqual(["eeg", "ieeg", "meg"]);
    expect([...modalityCodes("eeg,eeg")]).toEqual(["eeg"]);
    expect(modalityCodes("").size).toBe(0);
    expect(modalityCodes(null).size).toBe(0);
    expect(modalityCodes(undefined).size).toBe(0);
  });
});

describe("sizesSection by recording type", () => {
  const DDL = `CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, is_sandbox INTEGER DEFAULT 0,
    status TEXT, visibility TEXT, file_size INTEGER, modalities TEXT);`;
  const NOW = "2026-10-07T14:00:00.000Z";

  function db(rows: [string, number | null, string | null, string?][]) {
    const engine = new Database(":memory:");
    engine.run(DDL);
    for (const [id, size, modalities, visibility] of rows) {
      engine
        .query(
          "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, file_size, modalities) VALUES (?,1,0,'active',?,?,?)",
        )
        .run(id, visibility ?? "public", size, modalities);
    }
    return engine;
  }
  const metricOf = (s: Awaited<ReturnType<typeof sizesSection>>, key: string) =>
    s.metrics.find((m) => m.key === key);
  // The same bins as the whole catalog, counted here by hand.
  const total = (list?: { value: number }[]) => (list ?? []).reduce((n, b) => n + b.value, 0);

  const ROWS: [string, number | null, string | null][] = [
    ["a", 5 * GB, "eeg"],
    ["b", 50 * GB, "eeg,meg"],
    ["c", 200 * GB, " iEEG , EEG "],
    ["d", 3 * MB, "emg"],
    ["e", 8 * GB, "anat,func"],
    ["f", 20 * GB, null],
    ["g", 12 * GB, ""],
  ];

  test("one histogram per recording type, with the same bins as the whole catalog", async () => {
    const engine = db(ROWS);
    const s = await sizesSection(asD1(engine), NOW);
    const all = metricOf(s, "sizes.histogram");
    expect(all?.value).toBe(7);
    expect(s.metrics.map((m) => m.key)).toEqual([
      "sizes.histogram",
      "sizes.largest",
      "sizes.histogram.eeg",
      "sizes.histogram.meg",
      "sizes.histogram.ieeg",
      "sizes.histogram.emg",
    ]);
    for (const code of ["eeg", "meg", "ieeg", "emg"]) {
      const m = metricOf(s, `sizes.histogram.${code}`);
      expect(m?.unit).toBe("datasets");
      expect(m?.breakdown?.map((b) => b.label)).toEqual(all?.breakdown?.map((b) => b.label));
      // The headline is the number of datasets, which is what the bins add up to.
      expect(total(m?.breakdown)).toBe(m?.value);
    }
    engine.close();
  });

  test("a dataset counts under each of its types, and spacing and case do not matter", async () => {
    const engine = db(ROWS);
    const s = await sizesSection(asD1(engine), NOW);
    // eeg: a, b, and c (" iEEG , EEG "); meg: b; ieeg: c; emg: d.
    expect(metricOf(s, "sizes.histogram.eeg")?.value).toBe(3);
    expect(metricOf(s, "sizes.histogram.meg")?.value).toBe(1);
    expect(metricOf(s, "sizes.histogram.ieeg")?.value).toBe(1);
    expect(metricOf(s, "sizes.histogram.emg")?.value).toBe(1);
    // Of those three (5, 50 and 200 GB), only the 200 GB one is at or above the
    // archive cutoff, and the bins carry the cutoff for eeg too.
    const eeg = metricOf(s, "sizes.histogram.eeg")?.breakdown ?? [];
    const cutoff = eeg.findIndex((b) => /cutoff/i.test(b.label));
    expect(cutoff).toBeGreaterThan(-1);
    expect(total(eeg.slice(cutoff))).toBe(1);
    expect(total(eeg.slice(0, cutoff))).toBe(2);
    engine.close();
  });

  test("a type with no sized dataset has no histogram, and other kinds of data are not split out", async () => {
    const engine = db([
      ["a", 5 * GB, "eeg"],
      ["b", null, "meg"],
      ["c", 7 * GB, "anat"],
    ]);
    const s = await sizesSection(asD1(engine), NOW);
    expect(s.metrics.map((m) => m.key)).toEqual([
      "sizes.histogram",
      "sizes.largest",
      "sizes.histogram.eeg",
    ]);
    engine.close();
  });

  test("private datasets are not counted under any type", async () => {
    const engine = db([
      ["a", 5 * GB, "eeg"],
      ["secret", 5 * GB, "eeg,meg", "private"],
    ]);
    const s = await sizesSection(asD1(engine), NOW);
    expect(metricOf(s, "sizes.histogram.eeg")?.value).toBe(1);
    expect(metricOf(s, "sizes.histogram.meg")).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain("secret");
    engine.close();
  });

  test("the offered types are the ones the recorded-hours explorer has tabs for", () => {
    expect(SIZE_MODALITIES.map((m) => m.code)).toEqual(["eeg", "meg", "ieeg", "emg"]);
    expect(SIZE_MODALITIES.map((m) => m.label)).toEqual(["EEG", "MEG", "iEEG", "EMG"]);
  });

  test("the section still passes the snapshot schema, and its copy is in plain words", async () => {
    const engine = db(ROWS);
    const s = await sizesSection(asD1(engine), NOW);
    expect(SectionSchema.safeParse(s).success).toBe(true);
    for (const m of s.metrics.filter((x) => x.key.startsWith("sizes.histogram."))) {
      expect(`${m.label} ${m.hint}`).not.toMatch(JARGON);
      expect(m.hint).toContain("public datasets that include");
    }
    engine.close();
  });
});
