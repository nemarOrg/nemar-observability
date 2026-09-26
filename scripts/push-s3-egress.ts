#!/usr/bin/env bun

declare const process: { exit(code: number): never };
declare const Bun: {
  env: Record<string, string | undefined>;
  spawn(
    command: string[],
    options: {
      env: Record<string, string>;
      stdout: "pipe";
      stderr: "ignore";
    },
  ): { stdout: ReadableStream<Uint8Array>; exited: Promise<number> };
};

const AWS_REGION = "us-east-2";
const BUCKET_NAME = "nemar";
const FILTER_ID = "EntireBucket";
const PERIOD_SECONDS = 86_400;
const DAY_MS = PERIOD_SECONDS * 1_000;
const DASHBOARD_ENDPOINT = "https://dashboard.nemar.org/observability/api/sections/egress";

type CloudWatchResult = {
  Id?: string;
  StatusCode?: string;
  Timestamps?: string[];
  Values?: number[];
};

class CollectionError extends Error {}

function fail(message: string): never {
  throw new CollectionError(message);
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function midnight(date: string): string {
  return `${date}T00:00:00Z`;
}

function lookbackDays(): number {
  const configured = Bun.env.EGRESS_LOOKBACK_DAYS ?? "14";
  if (!/^\d+$/.test(configured)) fail("EGRESS_LOOKBACK_DAYS must be an integer from 1 to 455");
  const days = Number(configured);
  if (!Number.isSafeInteger(days) || days < 1 || days > 455) {
    fail("EGRESS_LOOKBACK_DAYS must be an integer from 1 to 455");
  }
  return days;
}

function startDateForWindow(endDate: string): string {
  const configured = Bun.env.EGRESS_START_DATE;
  if (configured === undefined) {
    const days = lookbackDays();
    return utcDate(new Date(Date.parse(midnight(endDate)) - days * DAY_MS));
  }
  if (Bun.env.EGRESS_LOOKBACK_DAYS !== undefined) {
    fail("set only one of EGRESS_START_DATE or EGRESS_LOOKBACK_DAYS");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(configured)) {
    fail("EGRESS_START_DATE must be a valid UTC date in YYYY-MM-DD format");
  }
  const parsed = new Date(midnight(configured));
  if (!Number.isFinite(parsed.getTime()) || utcDate(parsed) !== configured) {
    fail("EGRESS_START_DATE must be a valid UTC date in YYYY-MM-DD format");
  }
  if (configured >= endDate) fail("EGRESS_START_DATE must be earlier than today's UTC date");
  return configured;
}

function requiredSecret(name: string): string {
  const value = Bun.env[name];
  if (!value?.trim()) fail(`required Infisical variable ${name} is missing`);
  return value;
}

function parsePoints(output: string, startDate: string, endDate: string) {
  let response: { MetricDataResults?: CloudWatchResult[] };
  try {
    response = JSON.parse(output) as { MetricDataResults?: CloudWatchResult[] };
  } catch {
    fail("CloudWatch returned an unreadable response; no section was published");
  }

  const result = response.MetricDataResults?.find((candidate) => candidate.Id === "s3bytes");
  if (!result || result.StatusCode !== "Complete") {
    fail("CloudWatch did not complete the daily S3 metric query; no section was published");
  }
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
    const normalizedTimestamp = timestamp
      .replace(/\.0+(?=Z|\+00:00$)/, "")
      .replace(/\+00:00$/, "Z");
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().replace(/\.000Z$/, "Z") !== normalizedTimestamp
    ) {
      fail("CloudWatch returned a non-UTC timestamp; no section was published");
    }
    if (
      parsed.getUTCHours() !== 0 ||
      parsed.getUTCMinutes() !== 0 ||
      parsed.getUTCSeconds() !== 0
    ) {
      fail("CloudWatch returned a non-midnight point for a daily UTC query");
    }
    const date = utcDate(parsed);
    if (date < startDate || date >= endDate) {
      fail("CloudWatch returned a point outside the requested UTC date range");
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("CloudWatch returned a byte total that is not a safe non-negative integer");
    }
    if (byDate.has(date)) fail("CloudWatch returned a duplicate daily timestamp");
    byDate.set(date, value);
  }

  const points = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, value }));
  if (points.length === 0) {
    fail("CloudWatch returned no daily observations; refusing to publish zero or empty coverage");
  }
  return points;
}

async function queryCloudWatch(
  start: string,
  end: string,
  accessKey: string,
  secretKey: string,
): Promise<string> {
  const childEnv: Record<string, string> = {
    HOME: Bun.env.HOME ?? "/home/yahya",
    PATH: Bun.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
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
        JSON.stringify([
          {
            Id: "s3bytes",
            MetricStat: {
              Metric: {
                Namespace: "AWS/S3",
                MetricName: "BytesDownloaded",
                Dimensions: [
                  { Name: "BucketName", Value: BUCKET_NAME },
                  { Name: "FilterId", Value: FILTER_ID },
                ],
              },
              Period: PERIOD_SECONDS,
              Stat: "Sum",
            },
            ReturnData: true,
          },
        ]),
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
      { env: childEnv, stdout: "pipe", stderr: "ignore" },
    );
  } catch {
    fail("AWS CLI v2 could not be started; no section was published");
  }

  const [output, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    command.exited,
  ]);
  if (exitCode !== 0) {
    fail("CloudWatch query failed; check the scoped AWS read credentials and IAM permission");
  }
  return output;
}

async function postSection(token: string, payload: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(DASHBOARD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("dashboard ingest request failed; no section was confirmed");
  }
  if (!response.ok) fail(`dashboard rejected the section with HTTP ${response.status}`);
}

async function pushSection(token: string, points: { date: string; value: number }[]) {
  const first = points[0];
  const latest = points[points.length - 1];
  const payload = {
    key: "egress",
    label: "S3 egress",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "egress.s3.latest_daily_bytes",
        label: "Latest reported S3 download day",
        value: latest.value,
        unit: "bytes",
        severity: "info",
        hint: `${latest.date} UTC; bucket-wide response bytes, including conversion reads.`,
      },
      {
        key: "egress.collector.errors",
        label: "Latest collector run errors",
        value: 0,
        unit: "errors",
        severity: "ok",
        hint: "The latest scheduled CloudWatch query and dashboard push completed.",
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

  await postSection(token, payload);
  console.info(
    `[s3-egress] posted ${points.length} daily points (${first.date} through ${latest.date} UTC)`,
  );
}

function failureStatus(message: string) {
  return {
    key: "egress",
    label: "S3 egress",
    source: "aws-s3-cloudwatch",
    metrics: [
      {
        key: "egress.collector.errors",
        label: "Latest collector run errors",
        value: 1,
        unit: "errors",
        severity: "error",
        hint: `${utcDate(new Date())} UTC collection failed: ${message}. Existing daily points were not replaced.`,
      },
    ],
  };
}

async function main() {
  const ingestToken = requiredSecret("OBS_EGRESS_INGEST_TOKEN");
  const accessKey = requiredSecret("AWS_ACCESS_KEY_ID");
  const secretKey = requiredSecret("AWS_SECRET_ACCESS_KEY");
  const configuredRegion = requiredSecret("AWS_REGION");
  if (configuredRegion !== AWS_REGION) fail(`AWS_REGION must be ${AWS_REGION}`);

  const endDate = utcDate(new Date());
  const startDate = startDateForWindow(endDate);
  const start = midnight(startDate);
  const end = midnight(endDate);

  // The AWS subprocess receives only the two expected key variables, so it
  // cannot use a profile, metadata credential, or the section-ingest token.
  const output = await queryCloudWatch(start, end, accessKey, secretKey);
  const points = parsePoints(output, startDate, endDate);
  await pushSection(ingestToken, points);
}

main().catch(async (error: unknown) => {
  const message =
    error instanceof CollectionError
      ? error.message
      : "unexpected collection error; no credentials or response bodies were logged";
  console.error(`[s3-egress] ${message}`);

  const token = Bun.env.OBS_EGRESS_INGEST_TOKEN;
  if (token?.trim()) {
    try {
      await postSection(token, failureStatus(message));
      console.info(
        "[s3-egress] published the collector failure status; daily points are unchanged",
      );
    } catch {
      console.error(
        "[s3-egress] could not publish collector status; the daily series will age stale",
      );
    }
  }
  process.exit(1);
});

export {};
