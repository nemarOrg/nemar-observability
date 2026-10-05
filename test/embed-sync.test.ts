// The cron's embed sync end to end against the real Analytics Engine answers
// captured for nemar_website_embeds_dev, with a real SQLite store and the real
// migrations. Only the HTTP transport is stood in for (test/helpers/ae-fixtures).
// The success cases use the captures. The failure and quiet-dataset cases use
// hand-written bodies of shapes the edge can send (a 200 with an errors body, a
// row that does not parse, a refused read, an empty answer, rows around a quiet
// stretch); those are NOT captures, and only the unwritten-dataset answer
// (HTTP 200, no rows) was ever seen live.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncEmbedDays } from "../src/cron";
import { loadEmbedDays, loadEmbedSync } from "../src/lib/embed-store";
import type { Bindings } from "../src/types";
import { type AeStub, stubAe } from "./helpers/ae-fixtures";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

let engine: Database;
let db: D1Database;
let ae: AeStub | null = null;
beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
});
afterEach(() => {
  ae?.restore();
  ae = null;
  engine.close();
});

const env = () =>
  ({
    OBS_DB: db,
    CF_ACCOUNT_ID: "acct",
    CF_ANALYTICS_TOKEN: "t",
    EMBED_AE_DATASET: "nemar_website_embeds_dev",
  }) as unknown as Bindings;
// The day the captured answers were taken.
const NOW = new Date("2026-10-05T15:00:00Z");
const quiet = () => {
  const real = console.error;
  console.error = () => {};
  return () => {
    console.error = real;
  };
};

describe("syncEmbedDays on the captured answers", () => {
  test("the first pull stores the first counted day, all four kinds, and records success", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    expect(await loadEmbedDays(db, "2026-10-01", "2026-10-06")).toEqual([
      { date: "2026-10-05", kind: "document", loads: 19 },
      { date: "2026-10-05", kind: "iframe", loads: 307 },
      { date: "2026-10-05", kind: "none", loads: 6 },
      { date: "2026-10-05", kind: "other", loads: 0 },
    ]);
    const sync = await loadEmbedSync(db);
    expect(sync?.last_ok_at).toBe(NOW.toISOString());
    expect(sync?.last_error).toBeNull();
    // One ranged read, from the start of retention, reaching tomorrow (exclusive).
    expect(ae.asked).toHaveLength(1);
    expect(ae.asked[0]).toContain("toDateTime('2026-07-13 00:00:00')");
    expect(ae.asked[0]).toContain("toDateTime('2026-10-06 00:00:00')");
  });

  const stamp = (date: string) =>
    (
      engine
        .query("SELECT MIN(updated_at) AS at FROM embed_daily_loads WHERE date = ?")
        .get(date) as { at: string | null }
    ).at;

  test("a day is rewritten until it is written after it closed plus the grace, then left alone", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    expect(stamp("2026-10-05")).toBe(NOW.toISOString());
    // The query always covers the retention window; what is written is the planner's days.
    expect(ae.asked[0]).toContain("toDateTime('2026-07-13 00:00:00')");
    // Next morning, 2026-10-05 was only written while it was open: rewritten.
    const morning = new Date("2026-10-06T08:00:00Z");
    await syncEmbedDays(env(), morning);
    expect(stamp("2026-10-05")).toBe(morning.toISOString());
    // That wrote it after it closed plus the grace, so it is settled and not
    // rewritten; 2026-10-06 (zero-filled while open) is the oldest unsettled day.
    const later = new Date("2026-10-07T08:00:00Z");
    await syncEmbedDays(env(), later);
    expect(stamp("2026-10-05")).toBe(morning.toISOString());
    expect(stamp("2026-10-06")).toBe(later.toISOString());
  });

  test("an entirely empty answer settles no zeros for days it did not cover, history included", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    ae.restore();
    // The dataset name is wrong from now on: it answers 200 with no rows.
    ae = stubAe({ days: () => ({ data: [] }) });
    await syncEmbedDays(env(), new Date("2026-10-08T08:00:00Z"));
    const days = engine
      .query("SELECT DISTINCT date FROM embed_daily_loads ORDER BY date")
      .all() as { date: string }[];
    expect(days.map((d) => d.date)).toEqual(["2026-10-05"]);
    // The sync still succeeded: nothing was found, nothing was settled.
    expect((await loadEmbedSync(db))?.last_ok_at).toBe("2026-10-08T08:00:00.000Z");
  });

  test("a typo'd dataset never stores a zero; correcting it fills the history it missed", async () => {
    ae = stubAe({ days: () => ({ data: [] }) });
    await syncEmbedDays(env(), new Date("2026-10-04T08:00:00Z"));
    await syncEmbedDays(env(), new Date("2026-10-05T08:00:00Z"));
    expect(await loadEmbedDays(db, "2026-01-01", "2026-12-31")).toEqual([]);
    ae.restore();
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    expect(
      (await loadEmbedDays(db, "2026-10-05", "2026-10-05")).find((r) => r.kind === "iframe")?.loads,
    ).toBe(307);
  });

  test("a quiet stretch is filled with zeros once the answer has rows around it", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    ae.restore();
    // Four days later, the edge has the first day's rows and a new embed on 10-09.
    ae = stubAe({
      days: () => ({
        data: [
          { day: "2026-10-05", kind: "iframe", loads: "307" },
          { day: "2026-10-09", kind: "iframe", loads: "2" },
        ],
      }),
    });
    await syncEmbedDays(env(), new Date("2026-10-09T09:00:00Z"));
    const rows = await loadEmbedDays(db, "2026-10-06", "2026-10-08");
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.loads === 0)).toBe(true);
  });

  test("an empty dataset is a normal answer: nothing stored, success recorded", async () => {
    ae = stubAe({ days: () => ({ meta: [], data: [], rows: 0, rows_before_limit_at_least: 0 }) });
    await syncEmbedDays(env(), NOW);
    expect(await loadEmbedDays(db, "2026-01-01", "2026-12-31")).toEqual([]);
    expect((await loadEmbedSync(db))?.last_ok_at).toBe(NOW.toISOString());
  });

  test("a 200 with an errors body stores nothing and records the failure, not a zero", async () => {
    const restore = quiet();
    ae = stubAe({ days: () => ({ errors: [{ message: "denied" }] }) });
    await syncEmbedDays(env(), NOW);
    restore();
    expect(await loadEmbedDays(db, "2026-01-01", "2026-12-31")).toEqual([]);
    const sync = await loadEmbedSync(db);
    expect(sync?.last_ok_at).toBeNull();
    expect(sync?.last_error).toContain("read the edge");
    expect(sync?.last_run_at).toBe(NOW.toISOString());
  });

  test("a row that does not parse stores nothing and records the failure", async () => {
    const restore = quiet();
    ae = stubAe({
      days: () => ({ data: [{ day: "2026-10-05", kind: "iframe", loads: "abc" }] }),
    });
    await syncEmbedDays(env(), NOW);
    restore();
    expect(await loadEmbedDays(db, "2026-01-01", "2026-12-31")).toEqual([]);
    expect((await loadEmbedSync(db))?.last_error).toContain("read the edge");
  });

  test("a failure after a success keeps the last success and stored days", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    ae.restore();
    const restore = quiet();
    ae = stubAe({ days: () => new Response("quota", { status: 429 }) });
    await syncEmbedDays(env(), new Date("2026-10-05T16:00:00Z"));
    restore();
    const sync = await loadEmbedSync(db);
    expect(sync?.last_ok_at).toBe(NOW.toISOString());
    expect(sync?.last_error).toContain("429");
    expect((await loadEmbedDays(db, "2026-10-05", "2026-10-05")).length).toBe(4);
  });

  test("a lower re-read of a closed day neither lowers it nor stamps it", async () => {
    ae = stubAe();
    await syncEmbedDays(env(), NOW);
    ae.restore();
    // The next day the edge answers with less for 2026-10-05 (a partial read).
    const restore = quiet();
    ae = stubAe({
      days: () => ({ data: [{ day: "2026-10-05", kind: "iframe", loads: "100" }] }),
    });
    await syncEmbedDays(env(), new Date("2026-10-06T08:00:00Z"));
    restore();
    const rows = await loadEmbedDays(db, "2026-10-05", "2026-10-05");
    expect(rows.find((r) => r.kind === "iframe")?.loads).toBe(307);
    const stamp = engine
      .query("SELECT MIN(updated_at) AS at FROM embed_daily_loads WHERE date = '2026-10-05'")
      .get() as { at: string };
    expect(stamp.at).toBe(NOW.toISOString());
  });

  test("without configuration it asks nothing, warns, and records nothing", async () => {
    ae = stubAe();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    await syncEmbedDays({ OBS_DB: db, CF_ACCOUNT_ID: "a" } as Bindings, NOW);
    console.warn = realWarn;
    expect(ae.asked).toHaveLength(0);
    expect(warnings.join(" ")).toContain("not configured");
    expect((await loadEmbedSync(db))?.last_run_at).toBeNull();
  });
});
