// The cf section's two load-bearing rules (issue #10):
//   1. rate-limit.internal and machine hosts must not be read as visitors
//   2. re-pulling the current day must REPLACE it, never accumulate
// Both are tested against a real SQLite OBS_DB carrying the real migration.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { classifyHost } from "../src/lib/cf-analytics";
import { loadHostRollup, pruneHostDays, saveHostDays } from "../src/lib/store";
import { asD1 } from "./helpers/d1";

const MIGRATION = await Bun.file(
  new URL("../src/db/migrations/0002_cf_daily_host.sql", import.meta.url),
).text();

let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(MIGRATION);
  db = asD1(engine);
});
afterEach(() => engine.close());

describe("classifyHost", () => {
  test("separates browsable surfaces from machine traffic", () => {
    expect(classifyHost("nemar.org")).toBe("web");
    expect(classifyHost("ww2.nemar.org")).toBe("web");
    expect(classifyHost("app.nemar.org")).toBe("web");
    expect(classifyHost("dashboard.nemar.org")).toBe("web");
    expect(classifyHost("data.nemar.org")).toBe("data");
    expect(classifyHost("zarr.nemar.org")).toBe("data");
    expect(classifyHost("api.nemar.org")).toBe("api");
    // 361 GB in a single day flows through this one; folding it into "web"
    // would make the zone look like it serves a third of a terabyte to readers.
    expect(classifyHost("nemar.s3.us-east-2.amazonaws.com")).toBe("origin");
    expect(classifyHost("something-else.example")).toBe("other");
  });
});

describe("cf_daily_host accumulation", () => {
  const at = "2026-07-29T12:00:00.000Z";

  // The bug this guards: the cron re-pulls today every hour while the day is
  // still filling. If the write added instead of replacing, today's traffic
  // would be multiplied by the number of cron runs so far.
  test("re-pulling the same day replaces it rather than adding", async () => {
    await saveHostDays(
      db,
      [{ date: "2026-07-29", host: "data.nemar.org", requests: 100, visits: 10, bytes: 1000 }],
      at,
    );
    await saveHostDays(
      db,
      [{ date: "2026-07-29", host: "data.nemar.org", requests: 250, visits: 22, bytes: 2500 }],
      at,
    );

    const { hosts, days } = await loadHostRollup(db, "2026-07-01");
    expect(days).toBe(1);
    expect(hosts).toEqual([{ host: "data.nemar.org", requests: 250, visits: 22, bytes: 2500 }]);
  });

  test("distinct days sum, and coverage counts them", async () => {
    await saveHostDays(
      db,
      [
        { date: "2026-07-27", host: "ww2.nemar.org", requests: 10, visits: 4, bytes: 100 },
        { date: "2026-07-28", host: "ww2.nemar.org", requests: 20, visits: 6, bytes: 200 },
      ],
      at,
    );
    const { hosts, days } = await loadHostRollup(db, "2026-07-01");
    expect(days).toBe(2);
    expect(hosts[0]).toEqual({
      host: "ww2.nemar.org",
      requests: 30,
      visits: 10,
      bytes: 300,
    });
  });

  test("the window boundary excludes older days from both totals and coverage", async () => {
    await saveHostDays(
      db,
      [
        { date: "2026-06-01", host: "nemar.org", requests: 999, visits: 999, bytes: 999 },
        { date: "2026-07-28", host: "nemar.org", requests: 5, visits: 2, bytes: 50 },
      ],
      at,
    );
    const { hosts, days } = await loadHostRollup(db, "2026-07-01");
    expect(days).toBe(1);
    expect(hosts[0].requests).toBe(5);
  });

  test("prune drops days before the cutoff and keeps the cutoff day itself", async () => {
    await saveHostDays(
      db,
      [
        { date: "2026-06-01", host: "nemar.org", requests: 1, visits: 1, bytes: 1 },
        { date: "2026-06-28", host: "nemar.org", requests: 2, visits: 2, bytes: 2 },
        { date: "2026-07-28", host: "nemar.org", requests: 3, visits: 3, bytes: 3 },
      ],
      at,
    );
    await pruneHostDays(db, "2026-06-28");
    const { days } = await loadHostRollup(db, "2026-01-01");
    expect(days).toBe(2);
  });

  test("an empty pull is a no-op, not an error", async () => {
    await saveHostDays(db, [], at);
    expect((await loadHostRollup(db, "2026-07-01")).days).toBe(0);
  });

  // latestDate is what lets the section tell "backfilling" from "broken". The
  // cron pulls yesterday+today every run, so a healthy table always carries
  // today; a frozen latestDate is the only in-band evidence that pulls are
  // failing, since the failure path deliberately doesn't throw.
  test("latestDate reports the newest day present, and is null when empty", async () => {
    expect((await loadHostRollup(db, "2026-07-01")).latestDate).toBeNull();
    await saveHostDays(
      db,
      [
        { date: "2026-07-20", host: "nemar.org", requests: 1, visits: 1, bytes: 1 },
        { date: "2026-07-28", host: "nemar.org", requests: 2, visits: 2, bytes: 2 },
        { date: "2026-07-24", host: "nemar.org", requests: 3, visits: 3, bytes: 3 },
      ],
      at,
    );
    expect((await loadHostRollup(db, "2026-07-01")).latestDate).toBe("2026-07-28");
  });

  test("latestDate respects the window floor", async () => {
    await saveHostDays(
      db,
      [{ date: "2026-06-01", host: "nemar.org", requests: 1, visits: 1, bytes: 1 }],
      at,
    );
    expect((await loadHostRollup(db, "2026-07-01")).latestDate).toBeNull();
  });
});
