// Embed loads kept in this Worker's own D1 (migration 0006): a settled day is
// written once, a closed day never goes down, and the public dataset check runs
// the real predicate. Real SQL against a real SQLite engine behind the D1
// adapter, with the real migrations; no mocks.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { syncEmbedDays } from "../src/cron";
import {
  loadEmbedDayStamps,
  loadEmbedDays,
  loadEmbedSync,
  loadFirstEmbedDay,
  recordEmbedSync,
  saveEmbedDays,
} from "../src/lib/embed-store";
import type { EmbedDayRow } from "../src/lib/embeds";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
});
afterEach(() => engine.close());

const allKinds = (date: string, loads: [number, number, number, number]): EmbedDayRow[] =>
  (["iframe", "document", "none", "other"] as const).map((kind, i) => ({
    date,
    kind,
    loads: loads[i],
  }));

const embedded = async (date: string) =>
  (await loadEmbedDays(db, date, date)).find((r) => r.kind === "iframe")?.loads;

describe("embed_daily_loads", () => {
  test("a day is stored as four rows and read back in order", async () => {
    await saveEmbedDays(
      db,
      [...allKinds("2026-10-04", [5, 1, 2, 0]), ...allKinds("2026-10-03", [3, 0, 0, 0])],
      "2026-10-05T10:00:00Z",
    );
    const rows = await loadEmbedDays(db, "2026-10-03", "2026-10-04");
    expect(rows.map((r) => `${r.date} ${r.kind} ${r.loads}`)).toEqual([
      "2026-10-03 document 0",
      "2026-10-03 iframe 3",
      "2026-10-03 none 0",
      "2026-10-03 other 0",
      "2026-10-04 document 1",
      "2026-10-04 iframe 5",
      "2026-10-04 none 2",
      "2026-10-04 other 0",
    ]);
    expect(await loadFirstEmbedDay(db)).toBe("2026-10-03");
  });

  test("the schema rejects an unknown kind and a negative count", () => {
    const insert = (kind: string, loads: number) =>
      engine
        .query("INSERT INTO embed_daily_loads (date, kind, loads, updated_at) VALUES (?, ?, ?, ?)")
        .run("2026-10-04", kind, loads, "2026-10-05T00:00:00Z");
    expect(() => insert("worker", 1)).toThrow();
    expect(() => insert("iframe", -1)).toThrow();
  });

  test("a closed day never goes down, even when a lower write arrives", async () => {
    await saveEmbedDays(db, allKinds("2026-10-03", [50, 0, 0, 0]), "2026-10-04T08:00:00Z");
    // A partial or empty re-read of a day that closed long ago.
    await saveEmbedDays(db, allKinds("2026-10-03", [10, 0, 0, 0]), "2026-10-05T10:00:00Z");
    expect(await embedded("2026-10-03")).toBe(50);
    // A genuinely higher figure is taken.
    await saveEmbedDays(db, allKinds("2026-10-03", [60, 0, 0, 0]), "2026-10-05T11:00:00Z");
    expect(await embedded("2026-10-03")).toBe(60);
  });

  test("the open day takes the new day-to-date figure, up or down", async () => {
    await saveEmbedDays(db, allKinds("2026-10-05", [9, 0, 0, 0]), "2026-10-05T09:00:00Z");
    await saveEmbedDays(db, allKinds("2026-10-05", [4, 0, 0, 0]), "2026-10-05T10:00:00Z");
    expect(await embedded("2026-10-05")).toBe(4);
  });

  test("a write that only keeps the stored value does not re-stamp the day as settled", async () => {
    await saveEmbedDays(db, allKinds("2026-10-03", [50, 0, 0, 0]), "2026-10-03T22:00:00Z");
    expect((await loadEmbedDayStamps(db, "2026-10-01")).get("2026-10-03")).toBe(
      "2026-10-03T22:00:00Z",
    );
    // A lower iframe figure for a closed day is not trusted: the row is left as
    // it was, so the day is still unsettled and will be asked for again.
    await saveEmbedDays(db, allKinds("2026-10-03", [10, 0, 0, 0]), "2026-10-04T07:00:00Z");
    expect(await embedded("2026-10-03")).toBe(50);
    expect((await loadEmbedDayStamps(db, "2026-10-01")).get("2026-10-03")).toBe(
      "2026-10-03T22:00:00Z",
    );
    // A trusted read (not lower) does stamp it.
    await saveEmbedDays(db, allKinds("2026-10-03", [50, 0, 0, 0]), "2026-10-04T07:00:00Z");
    expect((await loadEmbedDayStamps(db, "2026-10-01")).get("2026-10-03")).toBe(
      "2026-10-04T07:00:00Z",
    );
  });

  test("a day with fewer than all four kinds does not count as stored", async () => {
    engine
      .query("INSERT INTO embed_daily_loads (date, kind, loads, updated_at) VALUES (?, ?, ?, ?)")
      .run("2026-10-04", "iframe", 3, "2026-10-05T00:00:00Z");
    expect((await loadEmbedDayStamps(db, "2026-10-01")).has("2026-10-04")).toBe(false);
  });

  test("loading respects the range bounds", async () => {
    await saveEmbedDays(
      db,
      [
        ...allKinds("2026-10-01", [1, 0, 0, 0]),
        ...allKinds("2026-10-02", [2, 0, 0, 0]),
        ...allKinds("2026-10-03", [3, 0, 0, 0]),
      ],
      "2026-10-05T10:00:00Z",
    );
    const rows = await loadEmbedDays(db, "2026-10-02", "2026-10-02");
    expect(new Set(rows.map((r) => r.date))).toEqual(new Set(["2026-10-02"]));
  });
});

describe("recordEmbedSync", () => {
  test("creates the status row when it is missing, for success and failure", async () => {
    engine.run("DELETE FROM embed_sync_status");
    await recordEmbedSync(db, false, "2026-10-05T10:00:00Z", "read the edge: AE SQL 403");
    expect(await loadEmbedSync(db)).toEqual({
      last_ok_at: null,
      last_error: "read the edge: AE SQL 403",
      last_run_at: "2026-10-05T10:00:00Z",
    });
    engine.run("DELETE FROM embed_sync_status");
    await recordEmbedSync(db, true, "2026-10-05T11:00:00Z");
    expect(await loadEmbedSync(db)).toEqual({
      last_ok_at: "2026-10-05T11:00:00Z",
      last_error: null,
      last_run_at: "2026-10-05T11:00:00Z",
    });
  });

  test("a failure keeps the last success, and a success clears the error", async () => {
    await recordEmbedSync(db, true, "2026-10-05T10:00:00Z");
    await recordEmbedSync(db, false, "2026-10-05T11:00:00Z", "boom");
    expect((await loadEmbedSync(db))?.last_ok_at).toBe("2026-10-05T10:00:00Z");
    await recordEmbedSync(db, true, "2026-10-05T12:00:00Z");
    expect((await loadEmbedSync(db))?.last_error).toBeNull();
  });
});

describe("syncEmbedDays", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const NOW = new Date("2026-10-05T12:00:00Z");

  test("without the token or dataset it writes nothing and does not throw", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await syncEmbedDays({ OBS_DB: db, CF_ACCOUNT_ID: "a" } as Bindings, NOW);
    expect(called).toBe(0);
    expect(await loadFirstEmbedDay(db)).toBeNull();
  });

  // The edge refusing the read (a revoked token, a quota) must leave the stored
  // history alone and must not stop the rest of the cron.
  test("an edge error leaves the stored days unchanged and does not throw", async () => {
    await saveEmbedDays(db, allKinds("2026-10-03", [50, 0, 0, 0]), "2026-10-04T08:00:00Z");
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await syncEmbedDays(
      {
        OBS_DB: db,
        CF_ACCOUNT_ID: "a",
        CF_ANALYTICS_TOKEN: "t",
        EMBED_AE_DATASET: "nemar_website_embeds_dev",
      } as Bindings,
      NOW,
    );
    expect(await embedded("2026-10-03")).toBe(50);
    expect(await loadFirstEmbedDay(db)).toBe("2026-10-03");
  });

  test("a dataset name that is not a plain identifier is refused before any request", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await syncEmbedDays(
      {
        OBS_DB: db,
        CF_ACCOUNT_ID: "a",
        CF_ANALYTICS_TOKEN: "t",
        EMBED_AE_DATASET: "x; DROP",
      } as Bindings,
      NOW,
    );
    expect(called).toBe(0);
  });
});
