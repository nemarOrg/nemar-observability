import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  IngestError,
  assertFresh,
  extractAwsErrorCode,
  shouldPublishFailureStatus,
} from "../scripts/lib/s3-cloudwatch";
import {
  egressSection,
  lookbackDays,
  parsePoints,
  startDateForWindow,
} from "../scripts/push-s3-egress";

const cloudWatchResponse = await readFile(
  new URL("./fixtures/cloudwatch-s3-2026-09-25.json", import.meta.url),
  "utf8",
);

describe("S3 egress CloudWatch response handling", () => {
  test("normalizes a captured offset timestamp to its UTC day", () => {
    expect(parsePoints(cloudWatchResponse, "2026-09-25", "2026-09-26")).toEqual([
      { date: "2026-09-25", value: 10_787_529_513_694 },
    ]);
  });

  test("rejects a captured observation outside the requested date window", () => {
    expect(() => parsePoints(cloudWatchResponse, "2026-09-26", "2026-09-27")).toThrow(
      "outside the requested UTC date range",
    );
  });

  test("measures freshness through the end of the latest daily period", () => {
    const points = parsePoints(cloudWatchResponse, "2026-09-25", "2026-09-26");
    expect(() => assertFresh(points, Date.parse("2026-09-27T11:59:59.999Z"))).not.toThrow();
    expect(() => assertFresh(points, Date.parse("2026-09-27T12:00:00.001Z"))).toThrow(
      "older than 36 hours",
    );
  });
});

describe("S3 egress query window", () => {
  test("defaults to the latest fourteen complete UTC days", () => {
    expect(lookbackDays()).toBe(14);
    expect(startDateForWindow("2026-09-26", undefined, undefined)).toBe("2026-09-12");
  });

  test("supports the planned August 1 backfill", () => {
    expect(startDateForWindow("2026-09-26", "2026-08-01", undefined)).toBe("2026-08-01");
  });

  test("rejects conflicting backfill and lookback settings", () => {
    expect(() => startDateForWindow("2026-09-26", "2026-08-01", "14")).toThrow("set only one");
  });
});

describe("S3 egress failure reporting", () => {
  test("publishes collection failures but does not issue a second write after ingest failure", () => {
    expect(shouldPublishFailureStatus(new Error("CloudWatch request failed"))).toBe(true);
    expect(shouldPublishFailureStatus(new IngestError("ingest outcome is unknown"))).toBe(false);
  });

  test("extracts only a bounded AWS CLI error code from stderr", () => {
    expect(
      extractAwsErrorCode(
        "An error occurred (AccessDenied) when calling the GetMetricData operation: private detail",
      ),
    ).toBe("AccessDenied");
    expect(extractAwsErrorCode("private error detail without a code")).toBeUndefined();
  });
});

describe("the day in progress", () => {
  test("the headline stays on the latest closed day while the series reaches today", () => {
    const today = new Date().toISOString().slice(0, 10);
    const section = egressSection([
      { date: "2026-09-25", value: 100 },
      { date: today, value: 7 },
    ]);
    expect(section.metrics[0].value).toBe(100);
    expect(section.daily_series[0].coverage_end).toBe(today);
  });
});
