import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { loadDailySeries, saveDailySeries } from "../src/lib/store";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

let engine: Database;
let db: D1Database;
beforeEach(() => {
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
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
  test("a closed day is never lowered, the open day is replaced", async () => {
    const write = (closed: number, open: number, at: string) =>
      saveDailySeries(
        db,
        "cf",
        "cloudflare",
        [
          {
            ...SERIES,
            key: "requests",
            coverage_start: "2026-09-02",
            coverage_end: "2026-09-03",
            points: [
              { date: "2026-09-02", value: closed },
              { date: "2026-09-03", value: open },
            ],
          },
        ],
        at,
      );
    await write(100, 10, "2026-09-03T10:00:00.000Z");
    await write(40, 4, "2026-09-03T11:00:00.000Z");
    const [row] = await loadDailySeries(db, "2026-09-02", "2026-09-03");
    expect(row.points).toEqual([
      { date: "2026-09-02", value: 100 },
      { date: "2026-09-03", value: 4 },
    ]);
  });

  test("overlapping observations replace values and bounded reads retain gaps", async () => {
    await saveDailySeries(db, "website", "umami", [SERIES], "2026-09-03T10:00:00.000Z");
    await saveDailySeries(
      db,
      "website",
      "umami",
      [
        {
          ...SERIES,
          coverage_start: "2026-09-02",
          coverage_end: "2026-09-04",
          points: [
            { date: "2026-09-02", value: 9 },
            { date: "2026-09-04", value: 5 },
          ],
        },
      ],
      "2026-09-03T11:00:00.000Z",
    );
    const rows = await loadDailySeries(db, "2026-09-01", "2026-09-04");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      section: "website",
      coverage_start: "2026-09-01",
      coverage_end: "2026-09-04",
      updated_at: "2026-09-03T11:00:00.000Z",
      latest_observation_date: "2026-09-04",
    });
    expect(rows[0].points).toEqual([
      { date: "2026-09-01", value: 4 },
      { date: "2026-09-02", value: 9 },
      { date: "2026-09-04", value: 5 },
    ]);
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
          latest_observation_date: "2026-09-02",
          points: [{ date: "2026-09-02", value: 0 }],
        },
      ],
    });
    const bad = await worker.fetch(
      new Request("https://x/observability/api/timeseries?start=2019-01-01&end=2030-01-01"),
      env,
      ctx,
    );
    expect(bad.status).toBe(400);
  });

  test("GET retains a covered series when the selected window has no observations", async () => {
    await saveDailySeries(db, "website", "umami", [SERIES], "2026-09-03T10:00:00.000Z");
    const env = { OBS_DB: db } as unknown as import("../src/types").Bindings;
    const res = await worker.fetch(
      new Request("https://x/observability/api/timeseries?start=2026-09-03&end=2026-09-03"),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      start: "2026-09-03",
      end: "2026-09-03",
      series: [
        {
          section: "website",
          source: "umami",
          key: "pageviews",
          coverage_start: "2026-09-01",
          coverage_end: "2026-09-03",
          latest_observation_date: "2026-09-02",
          points: [],
        },
      ],
    });
  });

  test("a series key cannot silently change its unit and relabel history", async () => {
    await saveDailySeries(db, "website", "umami", [SERIES], "2026-09-03T10:00:00.000Z");
    await expect(
      saveDailySeries(
        db,
        "website",
        "umami",
        [{ ...SERIES, unit: "bytes" }],
        "2026-09-03T11:00:00.000Z",
      ),
    ).rejects.toThrow("daily_series_semantics_immutable");
    const rows = await loadDailySeries(db, "2026-09-01", "2026-09-03");
    expect(rows[0].unit).toBe("count");
    expect(rows[0].points).toEqual(SERIES.points);
  });
});
