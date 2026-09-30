// Issue #94: zone-wide daily requests are kept as a durable series that
// survives the cf_daily_host prune. Real SQLite OBS_DB with the real migrations.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveRequestSeries } from "../src/cron";
import { loadDailySeries, pruneHostDays, saveHostDays } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";

const MIGRATIONS = await Promise.all(
  ["0002_cf_daily_host.sql", "0003_daily_series.sql"].map((f) =>
    Bun.file(new URL(`../src/db/migrations/${f}`, import.meta.url)).text(),
  ),
);

let engine: Database;
let db: D1Database;
let env: Bindings;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
  env = { OBS_DB: db } as Bindings;
});
afterEach(() => engine.close());

const row = (date: string, host: string, requests: number) => ({
  date,
  host,
  requests,
  visits: 0,
  bytes: 0,
});
const at = "2026-09-30T12:00:00.000Z";

async function requests() {
  const series = await loadDailySeries(db, "2026-01-01", "2026-12-31");
  return series.find((s) => s.section === "cf" && s.key === "requests");
}

describe("cf request series", () => {
  test("sums hosts per day into one series", async () => {
    await saveHostDays(db, [row("2026-09-28", "a", 10), row("2026-09-28", "b", 5)], at);
    await saveHostDays(db, [row("2026-09-29", "a", 7)], at);
    await saveRequestSeries(env, at);
    const s = await requests();
    expect(s?.points).toEqual([
      { date: "2026-09-28", value: 15 },
      { date: "2026-09-29", value: 7 },
    ]);
    expect(s?.unit).toBe("count");
  });

  test("re-running replaces the open day instead of adding", async () => {
    await saveHostDays(db, [row("2026-09-30", "a", 10)], at);
    await saveRequestSeries(env, at);
    await saveHostDays(db, [row("2026-09-30", "a", 25)], at);
    await saveRequestSeries(env, at);
    expect((await requests())?.points).toEqual([{ date: "2026-09-30", value: 25 }]);
  });

  test("days survive the per-host prune", async () => {
    await saveHostDays(db, [row("2026-08-01", "a", 100)], at);
    await saveHostDays(db, [row("2026-09-29", "a", 7)], at);
    await saveRequestSeries(env, at);
    await pruneHostDays(db, "2026-08-30");
    await saveRequestSeries(env, at);
    const s = await requests();
    expect(s?.points.map((p) => p.date)).toEqual(["2026-08-01", "2026-09-29"]);
    expect(s?.coverage_start).toBe("2026-08-01");
  });

  test("no stored days writes nothing", async () => {
    await saveRequestSeries(env, at);
    expect(await requests()).toBeUndefined();
  });
});
