// Issue #94: zone-wide daily edge requests are kept as a durable series, and a
// settled past day is never asked for again or overwritten with less.
// Pure planning functions plus a real SQLite OBS_DB with the real migrations.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncRequestSeries } from "../src/cron";
import { isSettled, planRequestPull, writablePoints } from "../src/lib/request-series";
import { loadDailySeries, loadSeriesPoints, saveDailySeries } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { clientLogic } from "./helpers/client-logic";
import { asD1 } from "./helpers/d1";

const { allTimeSpecs } = clientLogic(["allTimeSpecs"]);

const MIGRATIONS = await Promise.all(
  ["0002_cf_daily_host.sql", "0003_daily_series.sql", "0004_atomic_section_ingest.sql"].map((f) =>
    Bun.file(new URL(`../src/db/migrations/${f}`, import.meta.url)).text(),
  ),
);

let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
});
afterEach(() => engine.close());

const NOW = new Date("2026-09-30T12:00:00Z");
const day = (back: number) =>
  new Date(NOW.getTime() - back * 86_400_000).toISOString().slice(0, 10);
// Written a day after it closed plus grace: settled.
const settled = (date: string) => ({
  date,
  value: 100,
  updated_at: `${date}T00:00:00Z`.replace(
    /.*/,
    new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString(),
  ),
});

function full(window: number) {
  const out = [];
  for (let back = window; back >= 1; back--) out.push(settled(day(back)));
  return out;
}

describe("isSettled", () => {
  test("a day is settled only after it closed plus the grace period", () => {
    expect(isSettled("2026-09-29", "2026-09-29T23:00:00Z")).toBe(false);
    expect(isSettled("2026-09-29", "2026-09-30T05:59:00Z")).toBe(false);
    expect(isSettled("2026-09-29", "2026-09-30T06:00:00Z")).toBe(true);
  });
});

describe("planRequestPull", () => {
  test("a fresh deploy asks for the whole retention window in one range", () => {
    expect(planRequestPull([], NOW)).toEqual({ since: day(29), until: "2026-10-01" });
  });

  test("with every past day settled, only today is asked for", () => {
    expect(planRequestPull(full(29), NOW)).toEqual({ since: "2026-09-30", until: "2026-10-01" });
  });

  test("an unsettled yesterday is asked for once more, nothing older", () => {
    const stored = full(29).map((p) =>
      p.date === day(1) ? { ...p, updated_at: `${day(1)}T22:00:00Z` } : p,
    );
    expect(planRequestPull(stored, NOW).since).toBe(day(1));
  });

  test("a gap in the middle reopens the range from the oldest missing day", () => {
    const stored = full(29).filter((p) => p.date !== day(10));
    expect(planRequestPull(stored, NOW).since).toBe(day(10));
  });
});

describe("writablePoints", () => {
  test("a closed day never goes down, the open day is replaced", () => {
    const stored = [
      { date: "2026-09-29", value: 500, updated_at: "x" },
      { date: "2026-09-30", value: 50, updated_at: "x" },
    ];
    const out = writablePoints(
      stored,
      [
        { date: "2026-09-29", requests: 200 },
        { date: "2026-09-30", requests: 20 },
      ],
      "2026-09-30",
    );
    expect(out).toEqual([{ date: "2026-09-30", value: 20 }]);
  });

  test("a closed day can go up and a new day is kept", () => {
    const out = writablePoints(
      [{ date: "2026-09-29", value: 500, updated_at: "x" }],
      [
        { date: "2026-09-28", requests: 9 },
        { date: "2026-09-29", requests: 600 },
      ],
      "2026-09-30",
    );
    expect(out).toEqual([
      { date: "2026-09-28", value: 9 },
      { date: "2026-09-29", value: 600 },
    ]);
  });
});

describe("stored series", () => {
  const save = (points: { date: string; value: number }[], at: string) =>
    saveDailySeries(
      db,
      "cf",
      "cloudflare",
      [
        {
          key: "requests",
          label: "Network edge requests",
          unit: "count",
          aggregation: "sum",
          timezone: "UTC",
          coverage_start: points[0].date,
          coverage_end: points[points.length - 1].date,
          freshness_after_hours: 36,
          points,
        },
      ],
      at,
    );

  test("a later partial write widens coverage and keeps earlier days", async () => {
    await save([{ date: "2026-08-01", value: 100 }], "2026-08-02T10:00:00Z");
    await save([{ date: "2026-09-30", value: 7 }], "2026-09-30T10:00:00Z");
    const s = (await loadDailySeries(db, "2026-01-01", "2026-12-31")).find(
      (x) => x.section === "cf" && x.key === "requests",
    );
    expect(s?.coverage_start).toBe("2026-08-01");
    expect(s?.coverage_end).toBe("2026-09-30");
    expect(s?.points.map((p) => p.date)).toEqual(["2026-08-01", "2026-09-30"]);
    expect((await loadSeriesPoints(db, "cf", "requests")).map((p) => p.value)).toEqual([100, 7]);
  });

  test("without zone credentials the sync writes nothing and does not throw", async () => {
    await syncRequestSeries({ OBS_DB: db } as Bindings, NOW);
    expect(await loadSeriesPoints(db, "cf", "requests")).toEqual([]);
  });

  test("the all-time tile reads the stored series as a lifetime total", async () => {
    await save(
      [
        { date: "2026-09-28", value: 1000 },
        { date: "2026-09-29", value: 2000 },
      ],
      "2026-09-30T10:00:00Z",
    );
    const series = await loadDailySeries(db, "2026-09-01", "2026-09-30");
    const specs = allTimeSpecs({
      snapshot: { sections: [] },
      archive: { series },
      archiveWindow: { start: "2026-09-01", end: "2026-09-30" },
    }) as { label: string; value?: string }[];
    expect(specs.find((s) => s.label === "Requests")?.value).toBe("3K");
  });
});
