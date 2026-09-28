// Shared plumbing for the nemaring collectors that read AWS/S3 CloudWatch
// metrics for bucket `nemar` and push one dashboard section each
// (push-s3-egress.ts, push-s3-storage.ts). Kept dependency-free so the
// collectors run from a bare checkout without `bun install`.

declare const process: { exit(code: number): never };
declare const Bun: {
  env: Record<string, string | undefined>;
  spawn(
    command: string[],
    options: {
      env: Record<string, string>;
      stdout: "pipe";
      stderr: "pipe";
    },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

export const AWS_REGION = "us-east-2";
export const BUCKET_NAME = "nemar";
export const PERIOD_SECONDS = 86_400;
export const DAY_MS = PERIOD_SECONDS * 1_000;
export const FRESHNESS_AFTER_HOURS = 36;
const DASHBOARD_SECTIONS_URL = "https://dashboard.nemar.org/observability/api/sections";

export type CloudWatchResult = {
  Id?: string;
  Label?: string;
  StatusCode?: string;
  Timestamps?: string[];
  Values?: number[];
};

export type DailyPoint = { date: string; value: number };

export type MetricDataQuery = {
  Id: string;
  MetricStat: {
    Metric: {
      Namespace: string;
      MetricName: string;
      Dimensions: { Name: string; Value: string }[];
    };
    Period: number;
    Stat: string;
  };
  ReturnData: true;
};

export type AwsCredentials = { accessKey: string; secretKey: string };

/** A collection problem: safe to report as a failure status. */
export class CollectionError extends Error {}
/** The ingest POST was sent; its outcome is unknown, so never write again. */
export class IngestError extends Error {}

export function fail(message: string): never {
  throw new CollectionError(message);
}

export function shouldPublishFailureStatus(error: unknown): boolean {
  return !(error instanceof IngestError);
}

export function extractAwsErrorCode(stderr: string): string | undefined {
  const match = stderr.match(/An error occurred \(([A-Za-z0-9_.:-]{1,80})\)/);
  return match?.[1];
}

export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function midnight(date: string): string {
  return `${date}T00:00:00Z`;
}

export function addUtcDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(midnight(date)) + days * DAY_MS));
}

export function optionalEnv(name: string): string | undefined {
  return Bun.env[name];
}

export function requiredSecret(name: string): string {
  const value = Bun.env[name];
  if (!value?.trim()) fail(`required Infisical variable ${name} is missing`);
  return value;
}

/** The scoped CloudWatch read key both collectors share. */
export function requiredAwsCredentials(): AwsCredentials {
  const accessKey = requiredSecret("AWS_ACCESS_KEY_ID");
  const secretKey = requiredSecret("AWS_SECRET_ACCESS_KEY");
  const configuredRegion = requiredSecret("AWS_REGION");
  if (configuredRegion !== AWS_REGION) fail(`AWS_REGION must be ${AWS_REGION}`);
  return { accessKey, secretKey };
}

/** A daily `AWS/S3` query for bucket `nemar` with one extra dimension. */
export function bucketMetricQuery(
  id: string,
  metricName: string,
  dimension: { Name: string; Value: string },
  stat: "Sum" | "Average",
): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: {
        Namespace: "AWS/S3",
        MetricName: metricName,
        Dimensions: [{ Name: "BucketName", Value: BUCKET_NAME }, dimension],
      },
      Period: PERIOD_SECONDS,
      Stat: stat,
    },
    ReturnData: true,
  };
}

export function parseMetricDataResults(output: string): CloudWatchResult[] {
  let response: { MetricDataResults?: unknown } | null;
  try {
    response = JSON.parse(output) as { MetricDataResults?: unknown } | null;
  } catch {
    fail("CloudWatch returned an unreadable response; no section was published");
  }
  const results = response?.MetricDataResults;
  if (!Array.isArray(results)) {
    fail("CloudWatch returned no metric results; no section was published");
  }
  return results as CloudWatchResult[];
}

export function completeResult(
  results: CloudWatchResult[],
  id: string,
  description: string,
): CloudWatchResult {
  const result = results.find((candidate) => candidate.Id === id);
  if (!result || result.StatusCode !== "Complete") {
    fail(`CloudWatch did not complete the ${description} query; no section was published`);
  }
  return result;
}

/**
 * The validated UTC daily points of one result, oldest first. An empty list is
 * returned as-is: whether "no observations" is an error depends on the metric,
 * and a missing day is never filled in as zero.
 */
export function dailyPoints(
  result: CloudWatchResult,
  startDate: string,
  endDate: string,
): DailyPoint[] {
  const timestamps = result.Timestamps ?? [];
  const values = result.Values ?? [];
  if (timestamps.length !== values.length) {
    fail("CloudWatch returned mismatched timestamps and values; no section was published");
  }

  const byDate = new Map<string, number>();
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const value = values[index];
    if (typeof timestamp !== "string" || typeof value !== "number") {
      fail("CloudWatch returned an invalid daily point; no section was published");
    }
    const parsed = new Date(timestamp);
    const localDate = timestamp.slice(0, 10);
    const parsedLocalDate = new Date(midnight(localDate));
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
      !Number.isFinite(parsedLocalDate.getTime()) ||
      utcDate(parsedLocalDate) !== localDate ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.getUTCHours() !== 0 ||
      parsed.getUTCMinutes() !== 0 ||
      parsed.getUTCSeconds() !== 0 ||
      parsed.getUTCMilliseconds() !== 0
    ) {
      fail("CloudWatch returned a timestamp not aligned to UTC midnight; no section was published");
    }
    const date = utcDate(parsed);
    if (date < startDate || date >= endDate) {
      fail("CloudWatch returned a point outside the requested UTC date range");
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("CloudWatch returned a value that is not a safe non-negative integer");
    }
    if (byDate.has(date)) fail("CloudWatch returned a duplicate daily timestamp");
    byDate.set(date, value);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, value }));
}

/** Fail when the newest day ended more than the freshness window ago. */
export function assertFresh(points: { date: string }[], now = Date.now()): void {
  const latest = points[points.length - 1];
  if (!latest) {
    fail("CloudWatch returned no daily observations; refusing to publish zero or empty coverage");
  }
  const latestPeriodEnd = Date.parse(midnight(latest.date)) + DAY_MS;
  if (now - latestPeriodEnd > FRESHNESS_AFTER_HOURS * 60 * 60 * 1_000) {
    fail(
      `latest CloudWatch observation ${latest.date} is older than ${FRESHNESS_AFTER_HOURS} hours`,
    );
  }
}

/** Run one read-only GetMetricData call and return its JSON output. */
export async function getMetricData(
  queries: MetricDataQuery[],
  start: string,
  end: string,
  credentials: AwsCredentials,
): Promise<string> {
  // The AWS subprocess receives only the two expected key variables, so it
  // cannot use a profile, metadata credential, or the section-ingest token.
  const childEnv: Record<string, string> = {
    HOME: Bun.env.HOME ?? "/home/yahya",
    PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    AWS_ACCESS_KEY_ID: credentials.accessKey,
    AWS_SECRET_ACCESS_KEY: credentials.secretKey,
    AWS_REGION,
    AWS_DEFAULT_REGION: AWS_REGION,
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };

  let command: ReturnType<typeof Bun.spawn>;
  try {
    command = Bun.spawn(
      [
        Bun.env.AWS_CLI_BIN ?? "aws",
        "cloudwatch",
        "get-metric-data",
        "--region",
        AWS_REGION,
        "--metric-data-queries",
        JSON.stringify(queries),
        "--start-time",
        start,
        "--end-time",
        end,
        "--scan-by",
        "TimestampAscending",
        "--no-cli-pager",
        "--output",
        "json",
      ],
      { env: childEnv, stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    fail("AWS CLI v2 could not be started; no section was published");
  }

  const [output, errorCode, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    awsErrorCode(command.stderr),
    command.exited,
  ]);
  if (exitCode !== 0) {
    fail(
      `CloudWatch query failed${errorCode ? ` (${errorCode})` : ""}; check the scoped AWS read credentials and IAM permission`,
    );
  }
  return output;
}

async function awsErrorCode(stderr: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  const limit = 4_096;
  let retainedBytes = 0;
  let retained = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - retainedBytes;
      if (remaining > 0) {
        const prefix = value.subarray(0, remaining);
        retained += decoder.decode(prefix, { stream: true });
        retainedBytes += prefix.byteLength;
      }
    }
    retained += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return extractAwsErrorCode(retained);
}

export async function postSection(sectionKey: string, token: string, payload: unknown) {
  let response: Response;
  try {
    response = await fetch(`${DASHBOARD_SECTIONS_URL}/${sectionKey}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new IngestError("dashboard ingest request failed; the write outcome is unknown");
  }
  if (!response.ok) {
    throw new IngestError(
      `dashboard returned HTTP ${response.status}; the write outcome may be unknown`,
    );
  }
}

/**
 * Run a collector and, on a collection failure, replace its section with a red
 * error-status metric so an unknown value never reads as a current one. The
 * failure detail goes only to the journal; the public status is generic.
 */
export function runCollector(options: {
  tag: string;
  sectionKey: string;
  tokenVariable: string;
  collect: () => Promise<void>;
  failureStatus: () => unknown;
}): void {
  const { tag, sectionKey, tokenVariable, collect, failureStatus } = options;
  collect().catch(async (error: unknown) => {
    const message =
      error instanceof CollectionError || error instanceof IngestError
        ? error.message
        : "unexpected collection error; no credentials or response bodies were logged";
    console.error(`[${tag}] ${message}`);

    // Once an ingest request has been sent, a timeout or server error can occur
    // after D1 committed it. A second error-status push could overwrite success.
    if (!shouldPublishFailureStatus(error)) {
      process.exit(1);
    }

    const token = Bun.env[tokenVariable];
    if (token?.trim()) {
      try {
        await postSection(sectionKey, token, failureStatus());
        console.info(`[${tag}] published the collector failure status`);
      } catch {
        console.error(
          `[${tag}] could not publish the collector failure status; the last section will age stale`,
        );
      }
    }
    process.exit(1);
  });
}
