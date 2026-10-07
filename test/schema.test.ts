import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ChannelHoursBinSchema,
  ChannelHoursDatasetPeakSchema,
  ChannelHoursModalitySchema,
  ChannelHoursSchema,
  MetricSchema,
  MetricSnapshotSchema,
  SCHEMA_VERSION,
  SectionIngestSchema,
  metric,
} from "../src/lib/schema";

describe("metric()", () => {
  test("applies unit + severity defaults", () => {
    const m = metric({ key: "x.y", label: "X", value: 3 });
    expect(m.unit).toBe("datasets");
    expect(m.severity).toBe("info");
  });

  test("keeps explicit values", () => {
    const m = metric({
      key: "a.b",
      label: "A",
      value: 1,
      total: 4,
      unit: "bytes",
      severity: "error",
      drilldown: "a.b",
    });
    expect(m).toMatchObject({ total: 4, unit: "bytes", severity: "error", drilldown: "a.b" });
  });

  test("rejects an unknown severity", () => {
    // @ts-expect-error invalid severity must not type-check or parse
    expect(() => metric({ key: "k", label: "L", value: 1, severity: "boom" })).toThrow();
  });
});

describe("MetricSnapshotSchema", () => {
  test("accepts a well-formed snapshot", () => {
    const snap = {
      schema_version: SCHEMA_VERSION,
      generated_at: "2026-06-04T00:00:00.000Z",
      sections: [
        {
          key: "datasets",
          label: "Datasets",
          source: "nemar-cli",
          updated_at: "2026-06-04T00:00:00.000Z",
          metrics: [metric({ key: "datasets.public", label: "Public", value: 700 })],
        },
      ],
    };
    expect(MetricSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  test("rejects a wrong schema_version", () => {
    const bad = { schema_version: "0.9", generated_at: "x", sections: [] };
    expect(MetricSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SectionIngestSchema (push mode)", () => {
  test("accepts a section without updated_at", () => {
    const r = SectionIngestSchema.safeParse({
      key: "qa",
      label: "QA",
      source: "qa-pipeline",
      metrics: [{ key: "qa.pass", label: "Passing", value: 42 }],
    });
    expect(r.success).toBe(true);
  });

  test("rejects a section missing metrics", () => {
    const r = SectionIngestSchema.safeParse({ key: "qa", label: "QA", source: "qa-pipeline" });
    expect(r.success).toBe(false);
  });

  test("accepts bounded UTC additive series and defaults freshness", () => {
    const r = SectionIngestSchema.safeParse({
      key: "website",
      label: "Website",
      source: "umami",
      metrics: [{ key: "x", label: "x", value: 1 }],
      daily_series: [
        {
          key: "pageviews",
          label: "Pageviews",
          unit: "count",
          aggregation: "sum",
          timezone: "UTC",
          coverage_start: "2026-09-01",
          coverage_end: "2026-09-02",
          points: [
            { date: "2026-09-01", value: 0 },
            { date: "2026-09-02", value: 3 },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.daily_series?.[0].freshness_after_hours).toBe(36);
  });

  test("rejects invalid calendar dates, duplicates, out-of-coverage and non-finite values", () => {
    const base = {
      key: "x",
      label: "X",
      unit: "bytes",
      aggregation: "sum",
      timezone: "UTC",
      coverage_start: "2026-02-30",
      coverage_end: "2026-03-02",
      freshness_after_hours: 169,
      points: [
        { date: "2026-03-01", value: -1 },
        { date: "2026-03-01", value: Number.POSITIVE_INFINITY },
        { date: "2026-03-03", value: 2 },
      ],
    };
    const parsed = SectionIngestSchema.safeParse({
      key: "qa",
      label: "QA",
      source: "qa",
      metrics: [{ key: "x", label: "x", value: 1 }],
      daily_series: [base],
    });
    expect(parsed.success).toBe(false);
  });

  test("enforces ordered coverage, unique dates, and point coverage", () => {
    const base = {
      key: "views",
      label: "Views",
      unit: "count",
      aggregation: "sum",
      timezone: "UTC",
      coverage_start: "2026-09-01",
      coverage_end: "2026-09-02",
      points: [{ date: "2026-09-01", value: 2 }],
    };
    const sectionWith = (series: typeof base) => ({
      key: "website",
      label: "Website",
      source: "umami",
      metrics: [{ key: "views", label: "Views", value: 2 }],
      daily_series: [series],
    });
    expect(SectionIngestSchema.safeParse(sectionWith(base)).success).toBe(true);
    expect(
      SectionIngestSchema.safeParse(sectionWith({ ...base, coverage_start: "2026-09-03" })).success,
    ).toBe(false);
    expect(
      SectionIngestSchema.safeParse(
        sectionWith({
          ...base,
          points: [
            { date: "2026-09-01", value: 2 },
            { date: "2026-09-01", value: 3 },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      SectionIngestSchema.safeParse(
        sectionWith({ ...base, points: [{ date: "2026-09-03", value: 2 }] }),
      ).success,
    ).toBe(false);
  });
});

// breakdown_unit is consumed downstream by routes/ui.ts's
// `metric.breakdown_unit || metric.unit` fallback, so a zod typo would silently
// strip it and send byte bars back to count formatting.
describe("breakdown_unit", () => {
  test("survives a parse round-trip when set", () => {
    const r = MetricSchema.safeParse({
      key: "access.top",
      label: "Most read datasets",
      value: 3,
      unit: "count",
      breakdown: [{ label: "on004080", value: 13124701 }],
      breakdown_unit: "bytes",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.breakdown_unit).toBe("bytes");
  });

  test("is optional and absent when not supplied", () => {
    const r = MetricSchema.safeParse({ key: "a.b", label: "A", value: 1 });
    expect(r.success).toBe(true);
    expect(r.success && r.data.breakdown_unit).toBeUndefined();
  });
});

describe("channel_hours", () => {
  // Aggregated from the real zarr index.json files of 64 public datasets (a
  // subset of the catalog): 60 chosen at random with seed 7 from the indexes
  // under 8 MB, plus the four EMG datasets nm000104 to nm000107, on 2026-10-06.
  // Raw stores only; modality "IEEG" shown as "iEEG".
  const sample = JSON.parse(
    readFileSync(new URL("./fixtures/channel-hours.sample.json", import.meta.url), "utf8"),
  );

  // A small valid payload to mutate one rule at a time.
  type Mod = ReturnType<typeof modality>;
  const modality = (over: Record<string, unknown> = {}) => ({
    modality: "EEG",
    hours: 3,
    recordings: 3,
    datasets: 2,
    bins: [
      { channels: 8, hours: 1, recordings: 1 },
      { channels: 64, hours: 2, recordings: 2 },
    ],
    dataset_peaks: [
      { channels: 8, datasets: 1 },
      { channels: 64, datasets: 1 },
    ],
    ...over,
  });
  const payload = (over: Record<string, unknown> = {}) => ({
    datasets_scanned: 5,
    datasets_unavailable: 0,
    recordings_unmeasured: 0,
    modalities: [modality()],
    ...over,
  });
  /** `code@path` for every issue, sorted, so each rule is asserted in isolation. */
  const issues = (value: unknown): string[] => {
    const r = ChannelHoursSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => `${i.code}@${i.path.join(".")}`).sort();
  };
  const messages = (value: unknown): string[] => {
    const r = ChannelHoursSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  test("accepts a real aggregated sample and a minimal payload", () => {
    expect(issues(sample)).toEqual([]);
    expect(issues(payload())).toEqual([]);
  });

  test("survives a section ingest round-trip unchanged", () => {
    const r = SectionIngestSchema.safeParse({
      key: "recordings",
      label: "Recorded hours",
      source: "nemar-zarr-index",
      metrics: [{ key: "recordings.hours", label: "Recorded hours", value: 1, unit: "hours" }],
      channel_hours: sample,
    });
    expect(r.success && r.data.channel_hours).toEqual(sample);
  });

  test("is optional", () => {
    const r = SectionIngestSchema.safeParse({
      key: "qa",
      label: "QA",
      source: "qa-pipeline",
      metrics: [{ key: "qa.pass", label: "Passing", value: 42 }],
    });
    expect(r.success && r.data.channel_hours).toBeUndefined();
  });

  test("rejects unknown keys at every level, but a section still strips its own", () => {
    const withKey = (path: string[]) => {
      const v = structuredClone(payload()) as Record<string, unknown>;
      let node: unknown = v;
      for (const step of path) node = (node as Record<string, unknown>)[step];
      (node as Record<string, unknown>).dataset_id = "nm000001";
      return v;
    };
    expect(issues(withKey([]))).toEqual(["unrecognized_keys@"]);
    expect(issues(withKey(["modalities", "0"]))).toEqual(["unrecognized_keys@modalities.0"]);
    expect(issues(withKey(["modalities", "0", "bins", "0"]))).toEqual([
      "unrecognized_keys@modalities.0.bins.0",
    ]);
    expect(issues(withKey(["modalities", "0", "dataset_peaks", "0"]))).toEqual([
      "unrecognized_keys@modalities.0.dataset_peaks.0",
    ]);
    const base = {
      key: "recordings",
      label: "Recorded hours",
      source: "x",
      metrics: [{ key: "a.b", label: "A", value: 1 }],
    };
    const stripped = SectionIngestSchema.safeParse({
      ...base,
      surprise: 1,
      channel_hours: payload(),
    });
    expect(stripped.success).toBe(true);
    expect(stripped.success && "surprise" in stripped.data).toBe(false);
  });

  test("bins and peaks must be strictly ascending, one rule at a time", () => {
    // Duplicate bin, with totals that still balance (one bin's values split in two).
    const dupBin = modality({
      recordings: 4,
      bins: [
        { channels: 8, hours: 0.5, recordings: 1 },
        { channels: 8, hours: 0.5, recordings: 1 },
        { channels: 64, hours: 2, recordings: 2 },
      ],
    });
    expect(issues(payload({ modalities: [dupBin] }))).toEqual([
      "custom@modalities.0.bins.1.channels",
    ]);
    expect(messages(payload({ modalities: [dupBin] }))).toEqual(["Duplicate channel count"]);

    const dupPeak = modality({
      datasets: 3,
      dataset_peaks: [
        { channels: 8, datasets: 1 },
        { channels: 8, datasets: 1 },
        { channels: 64, datasets: 1 },
      ],
    });
    expect(issues(payload({ modalities: [dupPeak] }))).toEqual([
      "custom@modalities.0.dataset_peaks.1.channels",
    ]);

    const unsortedBins = modality({
      bins: [
        { channels: 64, hours: 2, recordings: 2 },
        { channels: 8, hours: 1, recordings: 1 },
      ],
    });
    expect(issues(payload({ modalities: [unsortedBins] }))).toEqual([
      "custom@modalities.0.bins.1.channels",
    ]);
    expect(messages(payload({ modalities: [unsortedBins] }))).toEqual([
      "Channel counts must be in ascending order",
    ]);
  });

  test("dataset peaks must agree with the bins", () => {
    // A peak at a channel count with no bin (also moves the largest peak off the largest bin).
    expect(
      issues(
        payload({
          modalities: [
            modality({
              dataset_peaks: [
                { channels: 8, datasets: 1 },
                { channels: 16, datasets: 1 },
              ],
            }),
          ],
        }),
      ),
    ).toEqual([
      "custom@modalities.0.dataset_peaks",
      "custom@modalities.0.dataset_peaks.1.channels",
    ]);
    // More datasets peaking at a count than the bin has recordings.
    expect(
      issues(
        payload({
          datasets_scanned: 10,
          modalities: [
            modality({
              datasets: 6,
              dataset_peaks: [
                { channels: 8, datasets: 5 },
                { channels: 64, datasets: 1 },
              ],
            }),
          ],
        }),
      ),
    ).toEqual(["custom@modalities.0.dataset_peaks.0.datasets"]);
    // The largest recording must belong to some dataset's peak.
    expect(
      issues(
        payload({
          modalities: [modality({ datasets: 1, dataset_peaks: [{ channels: 8, datasets: 1 }] })],
        }),
      ),
    ).toEqual(["custom@modalities.0.dataset_peaks"]);
    // Bins always have a dataset behind them, so empty peaks are never legal.
    expect(
      issues(payload({ modalities: [modality({ datasets: 0, dataset_peaks: [] })] })),
    ).toContain("too_small@modalities.0.dataset_peaks");
    // A modality cannot have more datasets than were scanned.
    expect(issues(payload({ datasets_scanned: 1 }))).toEqual(["custom@modalities.0.datasets"]);
  });

  test("each total is checked on its own, in both directions, with a useful message", () => {
    for (const [field, delta] of [
      ["recordings", 1],
      ["recordings", -1],
      ["datasets", 1],
      ["datasets", -1],
      ["hours", 1],
      ["hours", -1],
    ] as const) {
      const base = modality();
      const mod: Mod = { ...base, [field]: base[field] + delta };
      expect(issues(payload({ modalities: [mod] }))).toEqual([`custom@modalities.0.${field}`]);
    }
    expect(messages(payload({ modalities: [modality({ hours: 4 })] }))).toEqual([
      "hours must equal the sum over bins (expected 3, got 4)",
    ]);
  });

  test("the hours total tolerates float noise and rounding of 1e-9 relative, no more", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    const noisy = modality({
      hours: 0.3,
      recordings: 2,
      datasets: 2,
      bins: [
        { channels: 8, hours: 0.1, recordings: 1 },
        { channels: 64, hours: 0.2, recordings: 1 },
      ],
    });
    expect(issues(payload({ modalities: [noisy] }))).toEqual([]);
    // Small totals: an absolute 1e-6 floor, off by 2e-6 either way is rejected.
    for (const off of [2e-6, -2e-6]) {
      expect(issues(payload({ modalities: [{ ...noisy, hours: 0.3 + off }] }))).toEqual([
        "custom@modalities.0.hours",
      ]);
    }
    // Large totals scale: 1e6 hours allows 1e-3 either way, not 5e-3.
    const big = modality({
      hours: 1_000_000,
      recordings: 2,
      datasets: 2,
      bins: [
        { channels: 8, hours: 500_000, recordings: 1 },
        { channels: 64, hours: 500_000, recordings: 1 },
      ],
    });
    for (const off of [5e-4, -5e-4]) {
      expect(issues(payload({ modalities: [{ ...big, hours: 1_000_000 + off }] }))).toEqual([]);
    }
    for (const off of [5e-3, -5e-3]) {
      expect(issues(payload({ modalities: [{ ...big, hours: 1_000_000 + off }] }))).toEqual([
        "custom@modalities.0.hours",
      ]);
    }
  });

  test("a measured recording with zero duration is legal, a bin with no recordings is not", () => {
    const zero = modality({
      hours: 2,
      bins: [
        { channels: 8, hours: 0, recordings: 1 },
        { channels: 64, hours: 2, recordings: 2 },
      ],
    });
    expect(issues(payload({ modalities: [zero] }))).toEqual([]);
    const empty = modality({
      recordings: 2,
      bins: [
        { channels: 8, hours: 1, recordings: 0 },
        { channels: 64, hours: 2, recordings: 2 },
      ],
    });
    expect(issues(payload({ modalities: [empty] }))).toContain(
      "too_small@modalities.0.bins.0.recordings",
    );
  });

  test("channel counts and integer fields are bounded", () => {
    const at = (channels: number) =>
      payload({
        modalities: [
          modality({
            hours: 1,
            recordings: 1,
            datasets: 1,
            bins: [{ channels, hours: 1, recordings: 1 }],
            dataset_peaks: [{ channels, datasets: 1 }],
          }),
        ],
      });
    expect(issues(at(1))).toEqual([]);
    expect(issues(at(100_000))).toEqual([]);
    for (const bad of [0, -1, 100_001, 1.5]) {
      expect(issues(at(bad)).length).toBeGreaterThan(0);
    }
    expect(issues(payload({ datasets_scanned: -1 })).length).toBeGreaterThan(0);
    expect(issues(payload({ datasets_unavailable: 1.5 })).length).toBeGreaterThan(0);
    // Beyond JavaScript's exact integer range.
    expect(issues(payload({ recordings_unmeasured: 2 ** 53 })).length).toBeGreaterThan(0);
  });

  test("array caps: 1024 bins and 32 modalities pass, one more does not", () => {
    const bins = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ channels: i + 1, hours: 1, recordings: 1 }));
    const withBins = (n: number) =>
      modality({
        hours: n,
        recordings: n,
        datasets: 1,
        bins: bins(n),
        dataset_peaks: [{ channels: n, datasets: 1 }],
      });
    expect(issues(payload({ modalities: [withBins(1024)] }))).toEqual([]);
    expect(issues(payload({ modalities: [withBins(1025)] }))).toEqual([
      "too_big@modalities.0.bins",
    ]);
    const mods = (n: number) =>
      Array.from({ length: n }, (_, i) => modality({ modality: `M${i}` }));
    expect(issues(payload({ modalities: mods(32) }))).toEqual([]);
    expect(issues(payload({ modalities: mods(33) }))).toEqual(["too_big@modalities"]);
    expect(issues(payload({ modalities: [] }))).toEqual(["too_small@modalities"]);
  });

  test("modality names are plain and unique ignoring case", () => {
    for (const ok of ["EEG", "iEEG", "MISC", "fNIRS", "A", `A${"b".repeat(31)}`]) {
      expect(issues(payload({ modalities: [modality({ modality: ok })] }))).toEqual([]);
    }
    for (const bad of [
      "",
      "EEG ",
      "eeg\n",
      "<b>x</b>",
      "ＥＥＧ",
      "1EEG",
      `A${"b".repeat(32)}`,
      "E EG",
    ]) {
      expect(issues(payload({ modalities: [modality({ modality: bad })] }))).toEqual([
        "invalid_string@modalities.0.modality",
      ]);
    }
    expect(issues(payload({ modalities: [modality(), modality({ modality: "eeg" })] }))).toEqual([
      "custom@modalities.1.modality",
    ]);
  });
});

describe("channel_hours edge inputs", () => {
  const base = () => ({
    datasets_scanned: 5,
    datasets_unavailable: 0,
    recordings_unmeasured: 0,
    modalities: [
      {
        modality: "EEG",
        hours: 3,
        recordings: 3,
        datasets: 2,
        bins: [
          { channels: 8, hours: 1, recordings: 1 },
          { channels: 64, hours: 2, recordings: 2 },
        ],
        dataset_peaks: [
          { channels: 8, datasets: 1 },
          { channels: 64, datasets: 1 },
        ],
      },
    ],
  });
  const ok = (v: unknown) => ChannelHoursSchema.safeParse(v).success;

  test("a negative or non-finite bin duration is rejected", () => {
    for (const hours of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const v = base();
      v.modalities[0].bins[0].hours = hours;
      expect(ok(v)).toBe(false);
    }
    // JSON can carry an overflowing literal that parses to Infinity.
    const parsed = JSON.parse(JSON.stringify(base()).replace('"hours":1,', '"hours":1e999,'));
    expect(ok(parsed)).toBe(false);
  });

  test("a peak with zero datasets is rejected", () => {
    const v = base();
    v.modalities[0].dataset_peaks[0].datasets = 0;
    v.modalities[0].datasets = 1;
    expect(ok(v)).toBe(false);
  });

  test("unsorted dataset peaks are rejected by path", () => {
    const v = base();
    v.modalities[0].dataset_peaks.reverse();
    const r = ChannelHoursSchema.safeParse(v);
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.map((i) => i.path.join("."))).toEqual([
      "modalities.0.dataset_peaks.1.channels",
    ]);
  });

  test("empty bins or peaks give their own issue without a noisy largest-channel one", () => {
    const noPeaks = base();
    noPeaks.modalities[0].dataset_peaks = [];
    noPeaks.modalities[0].datasets = 0;
    const r = ChannelHoursSchema.safeParse(noPeaks);
    expect(r.success).toBe(false);
    const messages = !r.success ? r.error.issues.map((i) => i.message) : [];
    expect(messages.some((m) => m.includes("Infinity"))).toBe(false);
  });
});

describe("channel_hours JSON Schema mirror", () => {
  const mirror = JSON.parse(
    readFileSync(new URL("../src/lib/metric-snapshot.schema.json", import.meta.url), "utf8"),
  ).$defs;
  const same = (zodShape: Record<string, { isOptional(): boolean }>, def: string) => {
    expect(Object.keys(mirror[def].properties).sort()).toEqual(Object.keys(zodShape).sort());
    expect([...mirror[def].required].sort()).toEqual(
      Object.entries(zodShape)
        .filter(([, v]) => !v.isOptional())
        .map(([k]) => k)
        .sort(),
    );
  };

  test("property and required names match the Zod schemas", () => {
    same(ChannelHoursBinSchema.shape, "channelHoursBin");
    same(ChannelHoursDatasetPeakSchema.shape, "channelHoursDatasetPeak");
    same(ChannelHoursModalitySchema.innerType().shape, "channelHoursModality");
    same(ChannelHoursSchema.innerType().shape, "channelHours");
  });

  /**
   * Effective inclusive bounds of a Zod number or array, from its checks, so the
   * JSON Schema's minimum, maximum, minItems and maxItems can be compared with
   * what the validator really enforces.
   */
  type Bounds = { min?: number; max?: number };
  const boundsOf = (type: unknown): Bounds => {
    const def = (
      type as {
        _def: {
          checks?: { kind: string; value: number; inclusive?: boolean }[];
          minLength?: { value: number } | null;
          maxLength?: { value: number } | null;
        };
      }
    )._def;
    const out: Bounds = {};
    for (const c of def.checks ?? []) {
      if (c.kind === "min") {
        const v = c.inclusive === false ? c.value + 1 : c.value;
        out.min = out.min === undefined ? v : Math.max(out.min, v);
      } else if (c.kind === "max") {
        out.max = out.max === undefined ? c.value : Math.min(out.max, c.value);
      }
    }
    if (def.minLength) out.min = def.minLength.value;
    if (def.maxLength) out.max = def.maxLength.value;
    return out;
  };
  const SAFE_MIN = Number.MIN_SAFE_INTEGER;
  const jsonBounds = (prop: Record<string, number | undefined>): Bounds => ({
    min: prop.minimum ?? prop.minItems,
    max: prop.maximum ?? prop.maxItems,
  });
  const compare = (shape: Record<string, unknown>, def: string) => {
    for (const [name, type] of Object.entries(shape)) {
      const z = boundsOf(type);
      const j = jsonBounds(mirror[def].properties[name]);
      // A safe-integer floor is implied by "integer" in JSON Schema terms.
      const zMin = z.min === SAFE_MIN ? undefined : z.min;
      expect({ field: `${def}.${name}`, ...{ min: zMin, max: z.max } }).toEqual({
        field: `${def}.${name}`,
        min: j.min,
        max: j.max,
      });
    }
  };

  test("numeric and array bounds match what Zod enforces", () => {
    compare(ChannelHoursBinSchema.shape, "channelHoursBin");
    compare(ChannelHoursDatasetPeakSchema.shape, "channelHoursDatasetPeak");
    compare(ChannelHoursModalitySchema.innerType().shape, "channelHoursModality");
    compare(ChannelHoursSchema.innerType().shape, "channelHours");
  });

  test("the modality name pattern is the same expression", () => {
    const name = ChannelHoursModalitySchema.innerType().shape.modality;
    const regex = name._def.checks.find((c) => c.kind === "regex");
    expect(regex && "regex" in regex && regex.regex.source).toBe(
      mirror.channelHoursModality.properties.modality.pattern,
    );
  });
});
