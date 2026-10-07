import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { loadDailySeries, loadPushedSections } from "../src/lib/store";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const TOKEN = "website-ingest-token";
let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  db = asD1(engine);
});
afterEach(() => engine.close());

function section(value: number, unit: "count" | "bytes" = "count") {
  return {
    key: "website",
    label: "Website usage",
    source: "umami",
    metrics: [{ key: "website.pageviews", label: "Pageviews", value }],
    daily_series: [
      {
        key: "pageviews",
        label: "Pageviews",
        unit,
        aggregation: "sum",
        timezone: "UTC",
        coverage_start: "2026-09-01",
        coverage_end: "2026-09-02",
        freshness_after_hours: 36,
        points: [{ date: "2026-09-01", value }],
      },
    ],
  };
}

async function post(body: unknown, tokenMap = `{"website":"${TOKEN}"}`): Promise<Response> {
  const env = {
    OBS_DB: db,
    OBS_INGEST_TOKENS_JSON: tokenMap,
  } as unknown as import("../src/types").Bindings;
  return worker.fetch(
    new Request("https://x/observability/api/sections/website", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
}

describe("section ingest contract and atomic publication", () => {
  test("rejects token reuse across section keys", async () => {
    const response = await post(section(1), '{"website":"shared","egress":" shared "}');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Section ingest tokens must be distinct per section",
    });
  });

  test("applies cross-field date rules beyond JSON Schema field validation", async () => {
    const invalid = section(1);
    invalid.daily_series[0].points = [
      { date: "2026-09-01", value: 1 },
      { date: "2026-09-01", value: 2 },
    ];
    const response = await post(invalid);
    expect(response.status).toBe(422);
  });

  test("rejects changed series semantics without relabeling prior points", async () => {
    expect((await post(section(3))).status).toBe(200);
    const response = await post(section(30, "bytes"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ series_key: "pageviews" });
    const rows = await loadDailySeries(db, "2026-09-01", "2026-09-02");
    expect(rows[0]).toMatchObject({ unit: "count", points: [{ date: "2026-09-01", value: 3 }] });
  });

  test("a series write failure leaves the previous headline and complete series visible", async () => {
    expect((await post(section(4))).status).toBe(200);
    engine.run(`CREATE TRIGGER fail_daily_point_update
      BEFORE UPDATE ON daily_series_points
      BEGIN SELECT RAISE(ABORT, 'test_daily_point_failure'); END`);

    const failed = await post(section(40));
    expect(failed.status).toBe(500);
    const sections = await loadPushedSections(db);
    expect(sections[0].metrics[0].value).toBe(4);
    const series = await loadDailySeries(db, "2026-09-01", "2026-09-02");
    expect(series[0].points).toEqual([{ date: "2026-09-01", value: 4 }]);
  });
});

describe("channel_hours through the push endpoint", () => {
  const sample = JSON.parse(
    readFileSync(new URL("./fixtures/channel-hours.sample.json", import.meta.url), "utf8"),
  );
  const RECORDINGS_TOKEN = "recordings-ingest-token";

  function recordings(channelHours: unknown) {
    return {
      key: "recordings",
      label: "Recorded data",
      source: "nemar-zarr-index",
      metrics: [{ key: "recordings.hours", label: "Recorded hours", value: 5640, unit: "hours" }],
      channel_hours: channelHours,
    };
  }

  async function postRecordings(body: unknown): Promise<Response> {
    const env = {
      OBS_DB: db,
      OBS_INGEST_TOKENS_JSON: `{"recordings":"${RECORDINGS_TOKEN}"}`,
    } as unknown as import("../src/types").Bindings;
    return worker.fetch(
      new Request("https://x/observability/api/sections/recordings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RECORDINGS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
  }

  test("a valid payload is stored and read back unchanged", async () => {
    expect((await postRecordings(recordings(sample))).status).toBe(200);
    const stored = (await loadPushedSections(db)).find((s) => s.key === "recordings");
    expect(stored?.channel_hours).toEqual(sample);
  });

  test("inconsistent totals are rejected with 422 and nothing is stored", async () => {
    const bad = structuredClone(sample);
    bad.modalities[0].hours += 1;
    const response = await postRecordings(recordings(bad));
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("hours must equal the sum over bins");
    expect(await loadPushedSections(db)).toEqual([]);
  });

  test("a payload carrying a dataset identifier is rejected, not stored", async () => {
    const bad = structuredClone(sample);
    bad.modalities[0].bins[0].dataset_id = "nm000001";
    const response = await postRecordings(recordings(bad));
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("unrecognized_keys");
    expect(await loadPushedSections(db)).toEqual([]);
  });
});
