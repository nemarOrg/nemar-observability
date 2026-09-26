import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { loadDailySeries, saveDailySeries } from "../src/lib/store";
import { asD1 } from "./helpers/d1";

const MIGRATION = await Bun.file(new URL("../src/db/migrations/0003_daily_series.sql", import.meta.url)).text();
let engine: Database;
let db: D1Database;
beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(MIGRATION);
  db = asD1(engine);
});
afterEach(() => engine.close());

const SERIES = {
  key: "pageviews",
  label: "Pageviews",
  unit: "count" as const,
  aggregation: "sum" as const,
  timezone: "UTC" as const,
  coverage_start: "2026-09-01",
  coverage_end: "2026-09-03",
  freshness_after_hours: 36,
  points: [
    { date: "2026-09-01", value: 4 },
    { date: "2026-09-02", value: 0 },
  ],
};

describe("daily series store and API", () => {
  test("overlapping observations replace values and bounded reads retain gaps", async () => {
    await saveDailySeries(db, "website", "umami", [SERIES], "2026-09-03T10:00:00.000Z");
    await saveDailySeries(
      db,
      "website",
      "umami",
      [{
        ...SERIES,
        coverage_start: "2026-09-02",
        coverage_end: "2026-09-04",
        points: [
          { date: "2026-09-02", value: 9 },
          { date: "2026-09-04", value: 5 },
        ],
      }],
      "2026-09-03T11:00:00.000Z",
    );
    const rows = await loadDailySeries(db, "2026-09-01", "2026-09-04");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      section: "website",
      coverage_start: "2026-09-01",
      coverage_end: "2026-09-04",
      updated_at: "2026-09-03T11:00:00.000Z",
    });
    expect(rows[0].points).toEqual([{ date: "2026-09-01", value: 4 }, { date: "2026-09-02", value: 9 }, { date: "2026-09-04", value: 5 }]);
  });

  test("GET validates range and returns aggregate metadata and only in-range observations", async () => {
    await saveDailySeries(db, "website", "umami", [SERIES], "2026-09-03T10:00:00.000Z");
    const ctx = {} as ExecutionContext;
    const env = { OBS_DB: db } as unknown as import("../src/types").Bindings;
    const res = await worker.fetch(
      new Request("https://x/observability/api/timeseries?start=2026-09-02&end=2026-09-03"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      start: "2026-09-02",
      end: "2026-09-03",
      series: [
        {
          section: "website",
          source: "umami",
          key: "pageviews",
          points: [{ date: "2026-09-02", value: 0 }],
        },
      ],
    });
    const bad = await worker.fetch(
      new Request("https://x/observability/api/timeseries?start=2020-01-01&end=2030-01-01"),
      env,
      ctx,
    );
    expect(bad.status).toBe(400);
  });
});
