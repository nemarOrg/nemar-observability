// GET /observability/api/embeds against the real Worker, with a real SQLite
// store behind the D1 surface and the real migrations. Where the edge itself is
// involved, only failure and not-configured paths run here (a refused read);
// the success path needs a captured answer (test_requirements.md).

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { saveEmbedDays } from "../src/lib/embed-store";
import type { EmbedsResponse } from "../src/lib/embeds";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const realFetch = globalThis.fetch;

let engine: Database;
let db: D1Database;
beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
});
afterEach(() => {
  engine.close();
  globalThis.fetch = realFetch;
});

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const get = (path: string, env: Partial<Bindings>) =>
  worker.fetch(
    new Request(`https://dashboard.nemar.org/observability/api${path}`),
    { OBS_DB: db, ...env } as unknown as Bindings,
    ctx,
  );

describe("GET /embeds", () => {
  test("rejects a missing, malformed or reversed range", async () => {
    for (const q of ["", "?start=2026-10-01", "?start=x&end=y", `?start=${day(1)}&end=${day(5)}`]) {
      expect((await get(`/embeds${q}`, {})).status).toBe(400);
    }
  });

  test("rejects a range wider than the API serves", async () => {
    expect((await get("/embeds?start=2015-01-01&end=2026-10-01", {})).status).toBe(400);
  });

  test("a fresh deploy with nothing configured says so and invents no zero", async () => {
    const res = await get(`/embeds?start=${day(30)}&end=${day(1)}`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");
    const body = (await res.json()) as EmbedsResponse;
    expect(body.loads.status).toBe("unconfigured");
    expect(body.loads.totals).toBeNull();
    expect(body.sites.status).toBe("unconfigured");
    expect(body.sites.summary).toBeNull();
    expect(body.datasets.status).toBe("unconfigured");
    expect(body.datasets.summary).toBeNull();
  });

  test("stored daily totals are served by group, and an unrecorded day stays unknown", async () => {
    await saveEmbedDays(
      db,
      [
        { date: day(3), kind: "iframe", loads: 12 },
        { date: day(3), kind: "document", loads: 2 },
        { date: day(3), kind: "none", loads: 1 },
        { date: day(3), kind: "other", loads: 1 },
        { date: day(2), kind: "iframe", loads: 0 },
        { date: day(2), kind: "document", loads: 0 },
        { date: day(2), kind: "none", loads: 0 },
        { date: day(2), kind: "other", loads: 0 },
      ],
      new Date().toISOString(),
    );
    const body = (await (
      await get(`/embeds?start=${day(5)}&end=${day(1)}`, {
        CF_ACCOUNT_ID: "a",
        CF_ANALYTICS_TOKEN: "t",
        EMBED_AE_DATASET: "nemar_website_embeds_dev",
      })
    ).json()) as EmbedsResponse;
    expect(body.loads.totals).toEqual({ embedded: 12, direct: 2, other: 2 });
    expect(body.loads.days).toEqual([
      { date: day(3), embedded: 12, direct: 2, other: 2 },
      { date: day(2), embedded: 0, direct: 0, other: 0 },
    ]);
    expect(body.loads.days_recorded).toBe(2);
    expect(body.loads.days_in_range).toBe(5);
    expect(body.loads.status).toBe("partial");
    expect(body.loads.note).toContain("2 of 5 days");
  });

  // A refused read must show as unavailable on the lists, never as an empty
  // ranking, and must not take the stored totals down with it.
  test("an edge that refuses the read makes the lists unavailable and keeps the totals", async () => {
    await saveEmbedDays(
      db,
      (["iframe", "document", "none", "other"] as const).map((kind) => ({
        date: day(2),
        kind,
        loads: kind === "iframe" ? 7 : 0,
      })),
      new Date().toISOString(),
    );
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const body = (await (
      await get(`/embeds?start=${day(3)}&end=${day(1)}`, {
        CF_ACCOUNT_ID: "a",
        CF_ANALYTICS_TOKEN: "t",
        EMBED_AE_DATASET: "nemar_website_embeds_dev",
      })
    ).json()) as EmbedsResponse;
    expect(body.loads.totals?.embedded).toBe(7);
    expect(body.sites.status).toBe("unavailable");
    expect(body.sites.summary).toBeNull();
    expect(body.datasets.status).toBe("unavailable");
    expect(body.datasets.summary).toBeNull();
    expect(JSON.stringify(body)).not.toContain("forbidden");
  });

  test("a store that is not migrated reports the totals as unavailable, not zero", async () => {
    const bare = new Database(":memory:");
    const res = await worker.fetch(
      new Request(
        `https://dashboard.nemar.org/observability/api/embeds?start=${day(5)}&end=${day(1)}`,
      ),
      { OBS_DB: asD1(bare) } as unknown as Bindings,
      ctx,
    );
    bare.close();
    const body = (await res.json()) as EmbedsResponse;
    expect(body.loads.status).toBe("unavailable");
    expect(body.loads.totals).toBeNull();
  });

  test("a range wholly older than the edge keeps has no per-site detail", async () => {
    const body = (await (
      await get("/embeds?start=2025-01-01&end=2025-01-31", {
        CF_ACCOUNT_ID: "a",
        CF_ANALYTICS_TOKEN: "t",
        EMBED_AE_DATASET: "nemar_website_embeds_dev",
      })
    ).json()) as EmbedsResponse;
    expect(body.sites.status).toBe("unavailable");
    expect(body.sites.note).toContain("three months");
  });
});
