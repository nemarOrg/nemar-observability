#!/usr/bin/env bun

import {
  DAY_MS,
  type DailyPoint,
  assertFresh,
  bucketMetricQuery,
  completeResult,
  dailyPoints,
  fail,
  getMetricData,
  midnight,
  optionalEnv,
  parseMetricDataResults,
  postSection,
  requiredAwsCredentials,
  requiredSecret,
  runCollector,
  utcDate,
} from "./lib/s3-cloudwatch";

const FILTER_ID = "EntireBucket";
const QUERY_ID = "s3bytes";

export function lookbackDays(configured = "14"): number {
  if (!/^\d+$/.test(configured)) fail("EGRESS_LOOKBACK_DAYS must be an integer from 1 to 455");
  const days = Number(configured);
  if (!Number.isSafeInteger(days) || days < 1 || days > 455) {
    fail("EGRESS_LOOKBACK_DAYS must be an integer from 1 to 455");
  }
  return days;
}

export function startDateForWindow(
  endDate: string,
  configuredStart: string | undefined,
  configuredLookback: string | undefined,
): string {
  if (configuredStart === undefined) {
    const days = lookbackDays(configuredLookback ?? "14");
    return utcDate(new Date(Date.parse(midnight(endDate)) - days * DAY_MS));
  }
  if (configuredLookback !== undefined) {
    fail("set only one of EGRESS_START_DATE or EGRESS_LOOKBACK_DAYS");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(configuredStart)) {
    fail("EGRESS_START_DATE must be a valid UTC date in YYYY-MM-DD format");
  }
  const parsed = new Date(midnight(configuredStart));
  if (!Number.isFinite(parsed.getTime()) || utcDate(parsed) !== configuredStart) {
    fail("EGRESS_START_DATE must be a valid UTC date in YYYY-MM-DD format");
  }
  if (configuredStart >= endDate) fail("EGRESS_START_DATE must be earlier than today's UTC date");
  return configuredStart;
}

export function parsePoints(output: string, startDate: string, endDate: string): DailyPoint[] {
  const result = completeResult(parseMetricDataResults(output), QUERY_ID, "daily S3 metric");
  const points = dailyPoints(result, startDate, endDate);
  if (points.length === 0) {
    fail("CloudWatch returned no daily observations; refusing to publish zero or empty coverage");
  }
  return points;
}

export function egressSection(points: DailyPoint[]) {
  const first = points[0];
  const latest = points[points.length - 1];
  return {
    key: "egress",
    label: "Storage egress",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "egress.s3.latest_daily_bytes",
        label: "Latest reported day of data served",
        value: latest.value,
        unit: "bytes",
        severity: "info",
        hint: `${latest.date} UTC; all bytes storage returned that day, including internal processing reads.`,
      },
      {
        key: "egress.collector.errors",
        label: "Latest collector run errors",
        value: 0,
        unit: "errors",
        severity: "ok",
        hint: "The latest scheduled collection completed.",
      },
    ],
    daily_series: [
      {
        key: "s3_bytes_downloaded",
        label: "S3 bytes downloaded",
        unit: "bytes",
        aggregation: "sum",
        timezone: "UTC",
        coverage_start: first.date,
        coverage_end: latest.date,
        freshness_after_hours: 36,
        points,
      },
    ],
  };
}

async function pushSection(token: string, points: DailyPoint[]) {
  await postSection("egress", token, egressSection(points));
  console.info(
    `[s3-egress] posted ${points.length} daily points (${points[0].date} through ${points[points.length - 1].date} UTC)`,
  );
}

export function egressFailureStatus(now = new Date()) {
  return {
    key: "egress",
    label: "Storage egress",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "egress.collector.errors",
        label: "Latest collector run errors",
        value: 1,
        unit: "errors",
        severity: "error",
        hint: `${utcDate(now)} UTC collection failed; existing daily points were not replaced.`,
      },
    ],
  };
}

async function main() {
  const ingestToken = requiredSecret("OBS_EGRESS_INGEST_TOKEN");
  const credentials = requiredAwsCredentials();

  const endDate = utcDate(new Date());
  const startDate = startDateForWindow(
    endDate,
    optionalEnv("EGRESS_START_DATE"),
    optionalEnv("EGRESS_LOOKBACK_DAYS"),
  );

  // Both bounds are UTC midnights and the end is exclusive, so only complete
  // UTC days are requested.
  const query = bucketMetricQuery(
    QUERY_ID,
    "BytesDownloaded",
    { Name: "FilterId", Value: FILTER_ID },
    "Sum",
  );
  const output = await getMetricData([query], midnight(startDate), midnight(endDate), credentials);
  const points = parsePoints(output, startDate, endDate);
  assertFresh(points);
  await pushSection(ingestToken, points);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  runCollector({
    tag: "s3-egress",
    sectionKey: "egress",
    tokenVariable: "OBS_EGRESS_INGEST_TOKEN",
    collect: main,
    failureStatus: () => egressFailureStatus(),
  });
}
