import { describe, expect, test } from "bun:test";
import {
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
});
