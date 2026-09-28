#!/usr/bin/env bun

// Daily storage headline for bucket `nemar`: bytes stored (AWS/S3
// BucketSizeBytes, summed across storage classes) and object count (AWS/S3
// NumberOfObjects). Both are gauges S3 reports once per day, so they are pushed
// as snapshot metrics only; their trend comes from snapshot history. They are
// never sent as a daily series, whose week and month views add values.

import {
  type DailyPoint,
  addUtcDays,
  assertFresh,
  bucketMetricQuery,
  completeResult,
  dailyPoints,
  fail,
  getMetricData,
  midnight,
  parseMetricDataResults,
  postSection,
  requiredAwsCredentials,
  requiredSecret,
  runCollector,
  utcDate,
} from "./lib/s3-cloudwatch";

/**
 * Every documented `StorageType` value for `BucketSizeBytes`. The collector's
 * IAM key may only call GetMetricData (no ListMetrics), so the classes are
 * enumerated rather than discovered; a class with no data returns an empty
 * result and is left out of the total and breakdown, never counted as zero.
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html
 */
export const STORAGE_TYPES = [
  "StandardStorage",
  "StandardIAStorage",
  "StandardIASizeOverhead",
  "StandardIAObjectOverhead",
  "IntelligentTieringFAStorage",
  "IntelligentTieringIAStorage",
  "IntelligentTieringAAStorage",
  "IntelligentTieringAIAStorage",
  "IntelligentTieringDAAStorage",
  "IntAAObjectOverhead",
  "IntAAS3ObjectOverhead",
  "IntDAAObjectOverhead",
  "IntDAAS3ObjectOverhead",
  "OneZoneIAStorage",
  "OneZoneIASizeOverhead",
  "ReducedRedundancyStorage",
  "GlacierInstantRetrievalStorage",
  "GlacierIRSizeOverhead",
  "GlacierStorage",
  "GlacierStagingStorage",
  "GlacierObjectOverhead",
  "GlacierS3ObjectOverhead",
  "DeepArchiveStorage",
  "DeepArchiveObjectOverhead",
  "DeepArchiveS3ObjectOverhead",
  "DeepArchiveStagingStorage",
  "ExpressOneZoneStorage",
] as const;

const OBJECTS_QUERY_ID = "objects_AllStorageTypes";
/** Days of history each run reads to find the newest complete observation. */
export const STORAGE_WINDOW_DAYS = 7;

const bytesQueryId = (storageType: string) => `bytes_${storageType}`;

export function storageQueries() {
  return [
    ...STORAGE_TYPES.map((storageType) =>
      bucketMetricQuery(
        bytesQueryId(storageType),
        "BucketSizeBytes",
        { Name: "StorageType", Value: storageType },
        "Average",
      ),
    ),
    bucketMetricQuery(
      OBJECTS_QUERY_ID,
      "NumberOfObjects",
      { Name: "StorageType", Value: "AllStorageTypes" },
      "Average",
    ),
  ];
}

/**
 * The query window: the last STORAGE_WINDOW_DAYS UTC days including today, as
 * [startDate, endDate) with an exclusive end. S3 timestamps each daily storage
 * value at 00:00 UTC and publishes it later that day, so today's value is
 * included once it lands and yesterday's is used until then.
 */
export function storageWindow(today: string): { startDate: string; endDate: string } {
  return { startDate: addUtcDays(today, 1 - STORAGE_WINDOW_DAYS), endDate: addUtcDays(today, 1) };
}

export type StorageObservation = {
  date: string;
  bucketBytes: number;
  objectCount: number;
  byClass: { storageType: string; bytes: number }[];
};

/**
 * The newest UTC day on which the object count and every storage class that
 * reported in the window all have a value. A class or count that has not
 * landed for a newer day makes that day's total unknown, so the collector
 * falls back to the newest complete day instead of summing a partial set.
 */
export function latestStorageObservation(
  output: string,
  startDate: string,
  endDate: string,
): StorageObservation {
  const results = parseMetricDataResults(output);
  const classes = new Map<string, Map<string, number>>();
  for (const storageType of STORAGE_TYPES) {
    const result = completeResult(results, bytesQueryId(storageType), `${storageType} bucket size`);
    const points = dailyPoints(result, startDate, endDate);
    if (points.length > 0) classes.set(storageType, byDate(points));
  }
  if (classes.size === 0) {
    fail("CloudWatch returned no bucket size observations; refusing to publish zero storage");
  }
  const objects = dailyPoints(
    completeResult(results, OBJECTS_QUERY_ID, "object count"),
    startDate,
    endDate,
  );
  if (objects.length === 0) {
    fail("CloudWatch returned no object count observations; refusing to publish zero objects");
  }

  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const { date, value: objectCount } = objects[index];
    const byClass: { storageType: string; bytes: number }[] = [];
    for (const [storageType, values] of classes) {
      const bytes = values.get(date);
      if (bytes === undefined) break;
      byClass.push({ storageType, bytes });
    }
    if (byClass.length !== classes.size) continue;
    const bucketBytes = byClass.reduce((total, item) => total + item.bytes, 0);
    if (!Number.isSafeInteger(bucketBytes)) {
      fail("CloudWatch bucket size total is not a safe integer; no section was published");
    }
    byClass.sort((left, right) => right.bytes - left.bytes);
    return { date, bucketBytes, objectCount, byClass };
  }
  fail(
    "no UTC day in the window has both the object count and every reporting storage class; refusing to publish a partial total",
  );
}

function byDate(points: DailyPoint[]): Map<string, number> {
  return new Map(points.map((point) => [point.date, point.value]));
}

const SCOPE_NOTE =
  "Reported once per day, about one day behind. Covers the whole bucket, including archives, Zarr copies, and internal objects.";

export function storageSection(observation: StorageObservation) {
  const { date } = observation;
  return {
    key: "storage",
    label: "S3 storage",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "storage.bucket_bytes",
        label: "Data stored",
        value: observation.bucketBytes,
        unit: "bytes",
        severity: "info",
        hint: `Total bytes stored on ${date} UTC across all storage classes. ${SCOPE_NOTE}`,
      },
      {
        key: "storage.object_count",
        label: "Objects stored",
        value: observation.objectCount,
        unit: "count",
        severity: "info",
        hint: `Stored objects on ${date} UTC. ${SCOPE_NOTE}`,
      },
      {
        key: "storage.by_class",
        label: "Storage classes in use",
        value: observation.byClass.length,
        unit: "count",
        severity: "info",
        breakdown: observation.byClass.map((item) => ({
          label: item.storageType,
          value: item.bytes,
        })),
        breakdown_unit: "bytes",
        hint: `Bytes stored in each storage class on ${date} UTC. ${SCOPE_NOTE}`,
      },
      {
        key: "storage.collector.errors",
        label: "Latest collector run errors",
        value: 0,
        unit: "errors",
        severity: "ok",
        hint: "The latest scheduled collection completed.",
      },
    ],
  };
}

export function storageFailureStatus(message: string, now = new Date()) {
  return {
    key: "storage",
    label: "S3 storage",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "storage.collector.errors",
        label: "Latest collector run errors",
        value: 1,
        unit: "errors",
        severity: "error",
        hint: `${utcDate(now)} UTC collection failed: ${message}. The stored amount is unknown until a later run succeeds.`,
      },
    ],
  };
}

async function main() {
  const ingestToken = requiredSecret("OBS_STORAGE_INGEST_TOKEN");
  const credentials = requiredAwsCredentials();

  const { startDate, endDate } = storageWindow(utcDate(new Date()));
  const output = await getMetricData(
    storageQueries(),
    midnight(startDate),
    midnight(endDate),
    credentials,
  );
  const observation = latestStorageObservation(output, startDate, endDate);
  assertFresh([observation]);
  await postSection("storage", ingestToken, storageSection(observation));
  console.info(
    `[s3-storage] posted ${observation.date} UTC: ${observation.bucketBytes} bytes, ${observation.objectCount} objects, ${observation.byClass.length} storage classes`,
  );
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  runCollector({
    tag: "s3-storage",
    sectionKey: "storage",
    tokenVariable: "OBS_STORAGE_INGEST_TOKEN",
    collect: main,
    failureStatus: storageFailureStatus,
  });
}
