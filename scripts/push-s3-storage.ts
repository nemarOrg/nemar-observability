#!/usr/bin/env bun

// Daily storage headline for bucket `nemar`: bytes stored (AWS/S3
// BucketSizeBytes, summed across storage classes) and object count (AWS/S3
// NumberOfObjects). Both are gauges S3 reports once per day, so they are pushed
// as snapshot metrics only; their trend comes from snapshot history. They are
// never sent as a daily series, whose week and month views add values.

import {
  type DailyPoint,
  addUtcDays,
  bucketMetricQuery,
  codeStaleMetrics,
  codeUpdateProblem,
  completeResult,
  dailyPoints,
  fail,
  getMetricData,
  midnight,
  parseMetricDataResults,
  postSection,
  requiredAwsCredentials,
  requiredSecret,
  runCollectorAndExit,
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

type StorageType = (typeof STORAGE_TYPES)[number];

/** Plain public names for the storage-class breakdown; ids stay in the query. */
const STORAGE_CLASS_LABELS = {
  StandardStorage: "Standard",
  StandardIAStorage: "Infrequent access",
  StandardIASizeOverhead: "Infrequent access, small-object minimum",
  StandardIAObjectOverhead: "Infrequent access, per-object overhead",
  IntelligentTieringFAStorage: "Intelligent tiering, frequent",
  IntelligentTieringIAStorage: "Intelligent tiering, infrequent",
  IntelligentTieringAAStorage: "Intelligent tiering, archive",
  IntelligentTieringAIAStorage: "Intelligent tiering, archive instant",
  IntelligentTieringDAAStorage: "Intelligent tiering, deep archive",
  IntAAObjectOverhead: "Intelligent tiering archive, per-object overhead",
  IntAAS3ObjectOverhead: "Intelligent tiering archive, per-object metadata",
  IntDAAObjectOverhead: "Intelligent tiering deep archive, per-object overhead",
  IntDAAS3ObjectOverhead: "Intelligent tiering deep archive, per-object metadata",
  OneZoneIAStorage: "One-zone infrequent access",
  OneZoneIASizeOverhead: "One-zone infrequent access, small-object minimum",
  ReducedRedundancyStorage: "Reduced redundancy",
  GlacierInstantRetrievalStorage: "Glacier instant retrieval",
  GlacierIRSizeOverhead: "Glacier instant retrieval, small-object minimum",
  GlacierStorage: "Glacier",
  GlacierStagingStorage: "Glacier, uploads in progress",
  GlacierObjectOverhead: "Glacier, per-object overhead",
  GlacierS3ObjectOverhead: "Glacier, per-object metadata",
  DeepArchiveStorage: "Deep archive",
  DeepArchiveObjectOverhead: "Deep archive, per-object overhead",
  DeepArchiveS3ObjectOverhead: "Deep archive, per-object metadata",
  DeepArchiveStagingStorage: "Deep archive, uploads in progress",
  ExpressOneZoneStorage: "Express one zone",
} satisfies Record<StorageType, string>;

/** The public name for a storage class, with a neutral fallback. */
export function storageClassLabel(storageType: string): string {
  return Object.prototype.hasOwnProperty.call(STORAGE_CLASS_LABELS, storageType)
    ? STORAGE_CLASS_LABELS[storageType as StorageType]
    : "Other storage class";
}

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

/** The class that holds the bucket's data; its absence means the day is unknown. */
export const PRIMARY_STORAGE_TYPE = "StandardStorage";

/**
 * The newest UTC day on which both the object count and the primary storage
 * class have a value, with bytes summed over every class reported that day.
 *
 * S3 computes all storage types for a day in one daily job, so a secondary
 * class missing on a day the primary class reported means that class held no
 * data (for example, a lifecycle rule moved its objects on). Requiring every
 * class seen earlier in the window would instead make each newer day look
 * incomplete until the emptied class aged out. A missing primary value or
 * object count still means that day's total is unknown, so the collector falls
 * back to an older day rather than publish a partial or zero total.
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
  const primary = classes.get(PRIMARY_STORAGE_TYPE);
  if (!primary) {
    fail(
      `CloudWatch returned no ${PRIMARY_STORAGE_TYPE} bucket size observations; refusing to publish zero storage`,
    );
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
    if (!primary.has(date)) continue;
    const byClass: { storageType: string; bytes: number }[] = [];
    for (const [storageType, values] of classes) {
      const bytes = values.get(date);
      if (bytes !== undefined) byClass.push({ storageType, bytes });
    }
    const bucketBytes = byClass.reduce((total, item) => total + item.bytes, 0);
    if (!Number.isSafeInteger(bucketBytes)) {
      fail("CloudWatch bucket size total is not a safe integer; no section was published");
    }
    byClass.sort((left, right) => right.bytes - left.bytes);
    return { date, bucketBytes, objectCount, byClass };
  }
  fail(
    `no UTC day in the window has both the object count and the ${PRIMARY_STORAGE_TYPE} size; refusing to publish a partial total`,
  );
}

function byDate(points: DailyPoint[]): Map<string, number> {
  return new Map(points.map((point) => [point.date, point.value]));
}

/**
 * Accept only a value timestamped today or yesterday (UTC). S3 stamps each
 * daily value at 00:00 UTC and publishes it later that day, so yesterday's
 * value is the newest a run can see until today's lands; anything older means
 * a day was missed and is reported as a failure, never shown as current.
 */
export function assertCurrentStorageDay(date: string, now = new Date()): void {
  const oldestAccepted = addUtcDays(utcDate(now), -1);
  if (date < oldestAccepted) {
    fail(`latest storage observation ${date} is older than the previous UTC day`);
  }
}

const SCOPE_NOTE =
  "Reported once per day, about one day behind; a value older than the previous UTC day is shown as a failed collection instead. Covers the whole bucket, including archives, Zarr copies, and internal objects.";

/** Public section label; the key, `storage`, is the stable contract. */
const SECTION_LABEL = "Data storage";

export function storageSection(
  observation: StorageObservation,
  codeStaleSince: string | null = null,
) {
  const { date } = observation;
  return {
    key: "storage",
    label: SECTION_LABEL,
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
          label: storageClassLabel(item.storageType),
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
      ...codeStaleMetrics("storage", codeStaleSince),
    ],
  };
}

/** The public failure status; the detail stays in the collector's journal. */
export function storageFailureStatus(now = new Date()) {
  return {
    key: "storage",
    label: SECTION_LABEL,
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "storage.collector.errors",
        label: "Latest collector run errors",
        value: 1,
        unit: "errors",
        severity: "error",
        hint: `${utcDate(now)} UTC collection failed; the stored amount is unknown until a later run succeeds.`,
      },
    ],
  };
}

/** Collect once and push the section to `sectionsUrl` (production by default). */
export async function collectStorage(sectionsUrl?: string) {
  const ingestToken = requiredSecret(STORAGE_COLLECTOR.tokenVariable);
  const credentials = requiredAwsCredentials();

  const { startDate, endDate } = storageWindow(utcDate(new Date()));
  const output = await getMetricData(
    storageQueries(),
    midnight(startDate),
    midnight(endDate),
    credentials,
  );
  const observation = latestStorageObservation(output, startDate, endDate);
  assertCurrentStorageDay(observation.date);
  await postSection(
    STORAGE_COLLECTOR.sectionKey,
    ingestToken,
    storageSection(observation, await codeUpdateProblem()),
    sectionsUrl,
  );
  console.info(
    `[${STORAGE_COLLECTOR.tag}] posted ${observation.date} UTC: ${observation.bucketBytes} bytes, ${observation.objectCount} objects, ${observation.byClass.length} storage classes`,
  );
}

export const STORAGE_COLLECTOR = {
  tag: "s3-storage",
  sectionKey: "storage",
  tokenVariable: "OBS_STORAGE_INGEST_TOKEN",
  failureStatus: () => storageFailureStatus(),
} as const;

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  await runCollectorAndExit({ ...STORAGE_COLLECTOR, collect: () => collectStorage() });
}
