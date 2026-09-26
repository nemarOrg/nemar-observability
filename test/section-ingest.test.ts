import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { loadDailySeries, loadPushedSections } from "../src/lib/store";
import { asD1 } from "./helpers/d1";

const MIGRATIONS = await Promise.all(
  ["0001_init.sql", "0003_daily_series.sql", "0004_atomic_section_ingest.sql"].map((name) =>
    Bun.file(new URL(`../src/db/migrations/${name}`, import.meta.url)).text(),
  ),
);
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
