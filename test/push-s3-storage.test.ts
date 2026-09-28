import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type CloudWatchResult, assertFresh } from "../scripts/lib/s3-cloudwatch";
import {
  STORAGE_TYPES,
  latestStorageObservation,
  storageFailureStatus,
  storageQueries,
  storageSection,
  storageWindow,
} from "../scripts/push-s3-storage";
import { SectionIngestSchema } from "../src/lib/schema";

// Both fixtures are real read-only GetMetricData responses to storageQueries()
// for bucket `nemar`, captured with AWS CLI v2 on 2026-09-28 at about 22:20
// UTC. The CLI printed timestamps in the capturing machine's -07:00 offset.
// `current` is the collector's window on 2026-09-28, after that day's value
// had landed; `previous` is the window ending before 2026-09-28, which is the
// newest data a run sees before S3 publishes the day's value.
const current = await readFile(
  new URL("./fixtures/cloudwatch-s3-storage-2026-09-22-to-2026-09-28.json", import.meta.url),
  "utf8",
);
const previous = await readFile(
  new URL("./fixtures/cloudwatch-s3-storage-2026-09-21-to-2026-09-27.json", import.meta.url),
  "utf8",
);
// Bucket `nemar` stores only StandardStorage, so no real capture has two
// classes. This fixture is derived from `current`: every Id, label, status,
// timestamp, the StandardStorage values, and the object counts are real; three
// secondary classes carry illustrative values, and GlacierStorage omits the
// newest day to model a class that stops reporting (see its `_derivation`).
const multiclass = await readFile(
  new URL(
    "./fixtures/cloudwatch-s3-storage-multiclass-derived-2026-09-22-to-2026-09-28.json",
    import.meta.url,
  ),
  "utf8",
);
const CURRENT = storageWindow("2026-09-28");
const PREVIOUS = storageWindow("2026-09-27");

/** The captured response with one result changed, for delivery-gap cases. */
function withResult(
  output: string,
  id: string,
  change: (result: CloudWatchResult) => CloudWatchResult | null,
): string {
  const response = JSON.parse(output) as { MetricDataResults: CloudWatchResult[] };
  response.MetricDataResults = response.MetricDataResults.flatMap((result) => {
    if (result.Id !== id) return [result];
    const changed = change(result);
    return changed ? [changed] : [];
  });
  return JSON.stringify(response);
}

const withoutNewestPoint = (result: CloudWatchResult) => ({
  ...result,
  Timestamps: (result.Timestamps ?? []).slice(0, -1),
  Values: (result.Values ?? []).slice(0, -1),
});

describe("storage CloudWatch query", () => {
  test("asks for every storage class and the all-class object count, daily Average", () => {
    const queries = storageQueries();
    expect(queries).toHaveLength(STORAGE_TYPES.length + 1);
    const ids = queries.map((query) => query.Id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const query of queries) {
      expect(query.Id).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
      expect(query.MetricStat.Period).toBe(86_400);
      expect(query.MetricStat.Stat).toBe("Average");
      expect(query.MetricStat.Metric.Namespace).toBe("AWS/S3");
      expect(query.MetricStat.Metric.Dimensions[0]).toEqual({ Name: "BucketName", Value: "nemar" });
      expect(query.MetricStat.Metric.Dimensions[1].Name).toBe("StorageType");
    }
    expect(queries.filter((q) => q.MetricStat.Metric.MetricName === "NumberOfObjects")).toEqual([
      expect.objectContaining({
        Id: "objects_AllStorageTypes",
        MetricStat: expect.objectContaining({
          Metric: expect.objectContaining({
            Dimensions: [
              { Name: "BucketName", Value: "nemar" },
              { Name: "StorageType", Value: "AllStorageTypes" },
            ],
          }),
        }),
      }),
    ]);
  });

  test("reads the last seven UTC days including today, with an exclusive end", () => {
    expect(CURRENT).toEqual({ startDate: "2026-09-22", endDate: "2026-09-29" });
  });
});

describe("storage CloudWatch response handling", () => {
  test("reports the one class bucket nemar uses and omits the 26 empty classes", () => {
    const response = JSON.parse(current) as { MetricDataResults: CloudWatchResult[] };
    expect(response.MetricDataResults).toHaveLength(STORAGE_TYPES.length + 1);
    expect(response.MetricDataResults.filter((r) => (r.Values ?? []).length === 0)).toHaveLength(
      STORAGE_TYPES.length - 1,
    );

    expect(latestStorageObservation(current, CURRENT.startDate, CURRENT.endDate)).toEqual({
      date: "2026-09-28",
      bucketBytes: 121_650_377_907_484,
      objectCount: 1_347_607_631,
      byClass: [{ storageType: "StandardStorage", bytes: 121_650_377_907_484 }],
    });
  });

  test("sums several classes and lists them largest first", () => {
    const observation = latestStorageObservation(multiclass, CURRENT.startDate, CURRENT.endDate);
    expect(observation.date).toBe("2026-09-28");
    expect(observation.byClass).toEqual([
      { storageType: "StandardStorage", bytes: 121_650_377_907_484 },
      { storageType: "StandardIAStorage", bytes: 3_500_000_000_000 },
      { storageType: "StandardIASizeOverhead", bytes: 12_000_000 },
    ]);
    expect(observation.bucketBytes).toBe(121_650_377_907_484 + 3_500_000_000_000 + 12_000_000);

    // One day earlier, the class that later stops reporting is still counted.
    const dayEarlier = latestStorageObservation(
      withResult(multiclass, "bytes_StandardStorage", withoutNewestPoint),
      CURRENT.startDate,
      CURRENT.endDate,
    );
    expect(dayEarlier.date).toBe("2026-09-27");
    expect(dayEarlier.byClass.map((item) => item.storageType)).toEqual([
      "StandardStorage",
      "StandardIAStorage",
      "GlacierStorage",
      "StandardIASizeOverhead",
    ]);
    expect(dayEarlier.bucketBytes).toBe(
      121_308_786_888_620 + 3_500_000_000_000 + 800_000_000_000 + 12_000_000,
    );
  });

  test("a class that stops reporting does not hold the total back on older days", () => {
    // GlacierStorage reported every earlier day of the window but not the
    // newest; the newest day is still current and excludes it.
    const observation = latestStorageObservation(multiclass, CURRENT.startDate, CURRENT.endDate);
    expect(observation.date).toBe("2026-09-28");
    expect(observation.byClass.map((item) => item.storageType)).not.toContain("GlacierStorage");
  });

  test("falls back a day when the primary class or the object count is late", () => {
    const bytesLate = withResult(current, "bytes_StandardStorage", withoutNewestPoint);
    expect(latestStorageObservation(bytesLate, CURRENT.startDate, CURRENT.endDate)).toMatchObject({
      date: "2026-09-27",
      bucketBytes: 121_308_786_888_620,
      objectCount: 1_264_844_371,
    });

    const objectsLate = withResult(current, "objects_AllStorageTypes", withoutNewestPoint);
    expect(latestStorageObservation(objectsLate, CURRENT.startDate, CURRENT.endDate)).toMatchObject(
      { date: "2026-09-27", bucketBytes: 121_308_786_888_620 },
    );
  });

  test("fails when no day has both the object count and the primary class", () => {
    const bytesLate = withResult(current, "bytes_StandardStorage", withoutNewestPoint);
    const disjoint = withResult(bytesLate, "objects_AllStorageTypes", (result) => ({
      ...result,
      Timestamps: (result.Timestamps ?? []).slice(-1),
      Values: (result.Values ?? []).slice(-1),
    }));
    expect(() => latestStorageObservation(disjoint, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "refusing to publish a partial total",
    );
  });

  test("refuses to publish zero when a metric has no datapoints at all", () => {
    const noObjects = withResult(current, "objects_AllStorageTypes", (result) => ({
      ...result,
      Timestamps: [],
      Values: [],
    }));
    expect(() => latestStorageObservation(noObjects, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "no object count observations",
    );

    const noBytes = withResult(current, "bytes_StandardStorage", (result) => ({
      ...result,
      Timestamps: [],
      Values: [],
    }));
    expect(() => latestStorageObservation(noBytes, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "no StandardStorage bucket size observations",
    );

    // Secondary classes alone never stand in for a missing primary class.
    const noPrimary = withResult(multiclass, "bytes_StandardStorage", (result) => ({
      ...result,
      Timestamps: [],
      Values: [],
    }));
    expect(() => latestStorageObservation(noPrimary, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "no StandardStorage bucket size observations",
    );
  });

  test("fails when a storage class result is missing or incomplete", () => {
    const missing = withResult(current, "bytes_GlacierStorage", () => null);
    expect(() => latestStorageObservation(missing, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "did not complete the GlacierStorage bucket size query",
    );

    const partial = withResult(current, "bytes_StandardStorage", (result) => ({
      ...result,
      StatusCode: "PartialData",
    }));
    expect(() => latestStorageObservation(partial, CURRENT.startDate, CURRENT.endDate)).toThrow(
      "did not complete",
    );
  });

  test("rejects a captured observation outside the requested window", () => {
    expect(() => latestStorageObservation(current, PREVIOUS.startDate, PREVIOUS.endDate)).toThrow(
      "outside the requested UTC date range",
    );
  });
});

describe("storage reporting lag", () => {
  test("uses yesterday's value before today's lands, and fails once it is stale", () => {
    const observation = latestStorageObservation(previous, PREVIOUS.startDate, PREVIOUS.endDate);
    expect(observation.date).toBe("2026-09-27");
    expect(observation.bucketBytes).toBe(121_308_786_888_620);
    // The daily timer starts by 09:02 UTC; a run that does not see the
    // 2026-09-28 value yet still reports 2026-09-27 as current.
    expect(() => assertFresh([observation], Date.parse("2026-09-28T09:02:00Z"))).not.toThrow();
    expect(() => assertFresh([observation], Date.parse("2026-09-29T12:00:00.000Z"))).not.toThrow();
    expect(() => assertFresh([observation], Date.parse("2026-09-29T12:00:00.001Z"))).toThrow(
      "older than 36 hours",
    );
  });
});

describe("storage section payload", () => {
  const observation = latestStorageObservation(current, CURRENT.startDate, CURRENT.endDate);

  test("matches the section contract and passes ingest validation", () => {
    const payload = storageSection(observation);
    const parsed = SectionIngestSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(payload).toMatchObject({ key: "storage", label: "S3 storage" });
    expect(payload.source).toBe("aws-s3-cloudwatch");
    // A gauge is never sent as an additive daily series.
    expect("daily_series" in payload).toBe(false);

    const byKey = new Map(payload.metrics.map((metric) => [metric.key, metric]));
    expect(byKey.get("storage.bucket_bytes")).toMatchObject({
      value: 121_650_377_907_484,
      unit: "bytes",
    });
    expect(byKey.get("storage.object_count")).toMatchObject({
      value: 1_347_607_631,
      unit: "count",
    });
    expect(byKey.get("storage.by_class")).toMatchObject({
      value: 1,
      breakdown: [{ label: "StandardStorage", value: 121_650_377_907_484 }],
      breakdown_unit: "bytes",
    });
    expect(byKey.get("storage.collector.errors")).toMatchObject({ value: 0, severity: "ok" });
    for (const key of ["storage.bucket_bytes", "storage.object_count", "storage.by_class"]) {
      const hint = byKey.get(key)?.hint ?? "";
      expect(hint).toContain("2026-09-28 UTC");
      expect(hint).toContain("once per day, about one day behind");
      expect(hint).toContain("whole bucket, including archives, Zarr copies, and internal objects");
    }
  });

  test("a failure status replaces the headline instead of reporting zero", () => {
    const status = storageFailureStatus(
      "CloudWatch returned no object count observations",
      new Date("2026-09-28T08:30:00Z"),
    );
    expect(SectionIngestSchema.safeParse(status).success).toBe(true);
    expect(status.metrics.map((metric) => metric.key)).toEqual(["storage.collector.errors"]);
    expect(status.metrics[0]).toMatchObject({ value: 1, severity: "error" });
    expect(status.metrics[0].hint).toStartWith("2026-09-28 UTC collection failed:");
  });
});
