// last_ok_at remembers the last delivery whose collector run succeeded, so
// /health can tolerate one failed run yet catch a collector that has not
// succeeded for a day. A failed run publishes an error-only status that replaces
// the section and refreshes received_at, which is why received_at alone is not
// enough. The Umami pusher's success contract is tested here too, with its real
// payload shape. Real SQLite, the real ingest route, and the real migration.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { loadPushedProblems, loadSeriesBehind } from "../src/lib/freshness";
import type { Section } from "../src/lib/schema";
import { savePushedSection } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const TOKEN = "egress-ingest-token";
let engine: Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
});
afterEach(() => engine.close());

const success = {
  key: "egress",
  label: "Storage egress",
  source: "aws-s3-cloudwatch",
  metrics: [
    { key: "egress.collector.errors", label: "Errors", value: 0, unit: "errors", severity: "ok" },
  ],
};
const failure = {
  key: "egress",
  label: "Storage egress",
  source: "aws-s3-cloudwatch",
  metrics: [
    {
      key: "egress.collector.errors",
      label: "Errors",
      value: 1,
      unit: "errors",
      severity: "error",
    },
  ],
};

async function push(body: unknown): Promise<void> {
  const env = {
    OBS_DB: asD1(engine),
    OBS_INGEST_TOKENS_JSON: JSON.stringify({ egress: TOKEN }),
  } as unknown as Bindings;
  const res = await worker.fetch(
    new Request("https://x/observability/api/sections/egress", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(200);
}

const row = () =>
  engine
    .query("SELECT received_at, last_ok_at FROM ingested_sections WHERE key = 'egress'")
    .get() as { received_at: string; last_ok_at: string | null };

describe("last_ok_at through the ingest route", () => {
  test("a successful delivery sets it to that delivery", async () => {
    await push(success);
    const { received_at, last_ok_at } = row();
    expect(last_ok_at).toBe(received_at);
  });

  test("a later failed run refreshes received_at but keeps the last success", async () => {
    await push(success);
    const first = row();
    await Bun.sleep(5);
    await push(failure);
    const after = row();
    expect(after.received_at > first.received_at).toBe(true);
    expect(after.last_ok_at).toBe(first.last_ok_at);
  });

  test("a failed run as the very first delivery leaves it empty", async () => {
    await push(failure);
    expect(row().last_ok_at).toBeNull();
  });

  test("the next success moves it forward again", async () => {
    await push(success);
    await push(failure);
    await Bun.sleep(5);
    await push(success);
    const { received_at, last_ok_at } = row();
    expect(last_ok_at).toBe(received_at);
  });
});

describe("last_ok_at through savePushedSection", () => {
  const section = (metrics: Section["metrics"], at: string): Section => ({
    key: "egress",
    label: "Storage egress",
    source: "aws-s3-cloudwatch",
    updated_at: at,
    metrics,
  });

  test("follows the same rule as the ingest route", async () => {
    const db = asD1(engine);
    await savePushedSection(
      db,
      section(success.metrics as Section["metrics"], "2026-09-30T01:00:00Z"),
    );
    expect(row().last_ok_at).toBe("2026-09-30T01:00:00Z");
    await savePushedSection(
      db,
      section(failure.metrics as Section["metrics"], "2026-09-30T02:00:00Z"),
    );
    expect(row()).toEqual({
      received_at: "2026-09-30T02:00:00Z",
      last_ok_at: "2026-09-30T01:00:00Z",
    });
  });
});

describe("migration 0005 on existing rows", () => {
  test("backfills successes, leaves failures and unreadable rows empty", async () => {
    const before = new Database(":memory:");
    for (const [i, sql] of MIGRATIONS.entries()) if (i < 4) before.run(sql);
    const insert = before.query(
      "INSERT INTO ingested_sections (key, section_json, source, received_at) VALUES (?, ?, 'x', ?)",
    );
    insert.run("good", JSON.stringify(success), "2026-09-30T01:00:00Z");
    insert.run("bad", JSON.stringify(failure), "2026-09-30T02:00:00Z");
    insert.run("broken", "{not json", "2026-09-30T03:00:00Z");
    insert.run(
      "plain",
      JSON.stringify({ metrics: [{ key: "a.b", severity: "info" }] }),
      "2026-09-30T04:00:00Z",
    );

    before.run(MIGRATIONS[4]);
    const rows = before.query("SELECT key, last_ok_at FROM ingested_sections ORDER BY key").all();
    expect(rows).toEqual([
      { key: "bad", last_ok_at: null },
      { key: "broken", last_ok_at: null },
      { key: "good", last_ok_at: "2026-09-30T01:00:00Z" },
      { key: "plain", last_ok_at: "2026-09-30T04:00:00Z" },
    ]);
    before.close();
  });
});

// The Umami pusher (nemar-umami push/push-section.sh) posts one metric,
// `collector_health`, whose severity is "warn" for a week with no page views or a
// tracker asset that is down. That is a display level, never a failed run: the
// pusher signals failure by not posting at all. So every delivery must move
// last_ok_at, and health must stay clean for a warning.
describe("the Umami pusher's delivery through the real ingest route", () => {
  const WEBSITE_TOKEN = "website-ingest-token";
  const NOW = new Date("2026-09-30T08:30:00Z");

  const pusherPayload = (severity: "ok" | "warn") => ({
    key: "website",
    label: "Website",
    source: "umami",
    metrics: [
      {
        key: "collector_health",
        label: "Collector health",
        value: severity === "ok" ? 1 : 0,
        unit: "status",
        severity,
        hint:
          severity === "ok"
            ? "collector healthy: Umami API returned complete daily data and public tracker returned HTTP 200"
            : "zero pageviews in the last 7 complete UTC days; public tracker probe returned HTTP 503",
      },
    ],
    daily_series: [
      {
        key: "pageviews",
        label: "Umami pageviews",
        unit: "count",
        aggregation: "sum",
        timezone: "UTC",
        coverage_start: "2026-09-28",
        coverage_end: "2026-09-29",
        freshness_after_hours: 36,
        points: [
          { date: "2026-09-28", value: 26 },
          { date: "2026-09-29", value: 1132 },
        ],
      },
    ],
  });

  async function pushWebsite(body: unknown): Promise<void> {
    const env = {
      OBS_DB: asD1(engine),
      OBS_INGEST_TOKENS_JSON: JSON.stringify({ egress: TOKEN, website: WEBSITE_TOKEN }),
    } as unknown as Bindings;
    const res = await worker.fetch(
      new Request("https://x/observability/api/sections/website", {
        method: "POST",
        headers: { Authorization: `Bearer ${WEBSITE_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  }

  const websiteRow = () =>
    engine
      .query("SELECT received_at, last_ok_at FROM ingested_sections WHERE key = 'website'")
      .get() as { received_at: string; last_ok_at: string | null };

  for (const severity of ["ok", "warn"] as const) {
    test(`a ${severity} delivery sets last_ok_at and leaves health clean`, async () => {
      await pushWebsite(pusherPayload(severity));
      const { received_at, last_ok_at } = websiteRow();
      expect(last_ok_at).toBe(received_at);

      const at = new Date(Date.parse(received_at) + 3_600_000);
      const problems = await loadPushedProblems(asD1(engine), at, true);
      expect(problems.filter((p) => p.section === "website")).toEqual([]);

      // The series is judged against the day expected at NOW, whatever the
      // wall clock says when the test runs.
      const behind = await loadSeriesBehind(asD1(engine), NOW, true);
      expect(behind.filter((s) => s.key === "pageviews")).toEqual([]);
    });
  }
});
