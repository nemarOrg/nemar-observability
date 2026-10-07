import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
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
  // subset of the catalog), not hand-built.
  const sample = JSON.parse(
    readFileSync(new URL("./fixtures/channel-hours.sample.json", import.meta.url), "utf8"),
  );

  test("accepts a real aggregated sample", () => {
    expect(ChannelHoursSchema.safeParse(sample).success).toBe(true);
  });

  test("survives a section ingest round-trip", () => {
    const r = SectionIngestSchema.safeParse({
      key: "recordings",
      label: "Recorded hours",
      source: "nemar-zarr-index",
      metrics: [{ key: "recordings.hours", label: "Recorded hours", value: 1, unit: "hours" }],
      channel_hours: sample,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.channel_hours?.modalities.map((m) => m.modality)).toEqual(
      sample.modalities.map((m: { modality: string }) => m.modality),
    );
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

  test("rejects duplicate channel counts, duplicate modalities, and inconsistent totals", () => {
    const bad = (mutate: (v: typeof sample) => void) => {
      const v = structuredClone(sample);
      mutate(v);
      return ChannelHoursSchema.safeParse(v).success;
    };
    expect(bad((v) => v.modalities[0].bins.push({ ...v.modalities[0].bins[0] }))).toBe(false);
    expect(bad((v) => v.modalities.push({ ...v.modalities[0], modality: "eeg" }))).toBe(false);
    expect(
      bad((v) => {
        v.modalities[0].hours += 1;
      }),
    ).toBe(false);
    expect(
      bad((v) => {
        v.modalities[0].recordings += 1;
      }),
    ).toBe(false);
    expect(
      bad((v) => {
        v.modalities[0].datasets += 1;
      }),
    ).toBe(false);
    expect(
      bad((v) => {
        v.modalities[0].bins[0].channels = 0;
      }),
    ).toBe(false);
  });
});
