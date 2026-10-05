// GET /observability/api/embeds and its admin drill-down against the real Worker,
// with a real SQLite store behind the D1 surface and the real migrations. Where
// the edge is involved the answers are the live captures (test/helpers/ae-fixtures),
// a refused read, or a hand-written body where a case needs one (not a capture); the identity check of the drill-down is stood in for by a
// local HTTP server answering the one request the Worker makes of nemar-cli.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { resetEmbedListsMemo } from "../src/lib/embed-lists";
import { recordEmbedSync, saveEmbedDays } from "../src/lib/embed-store";
import type { EmbedsResponse } from "../src/lib/embeds";
import type { Bindings } from "../src/types";
import { type AeStub, stubAe } from "./helpers/ae-fixtures";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let engine: Database;
let db: D1Database;
let ae: AeStub | null = null;
beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  db = asD1(engine);
  resetEmbedListsMemo();
});
afterEach(() => {
  ae?.restore();
  ae = null;
  engine.close();
});

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
const configured = {
  CF_ACCOUNT_ID: "a",
  CF_ANALYTICS_TOKEN: "t",
  EMBED_AE_DATASET: "nemar_website_embeds_dev",
} as const;
const get = (path: string, env: Partial<Bindings>, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request(`https://dashboard.nemar.org/observability/api${path}`, { headers }),
    { OBS_DB: db, ...env } as unknown as Bindings,
    ctx,
  );
const allKinds = (date: string, loads: [number, number, number, number]) =>
  (["iframe", "document", "none", "other"] as const).map((kind, i) => ({
    date,
    kind,
    loads: loads[i],
  }));
const syncedNow = () => recordEmbedSync(db, true, new Date().toISOString());

describe("GET /embeds", () => {
  test("rejects a missing, malformed or reversed range", async () => {
    for (const q of ["", "?start=2026-10-01", "?start=x&end=y", `?start=${day(1)}&end=${day(5)}`]) {
      expect((await get(`/embeds${q}`, {})).status).toBe(400);
    }
  });

  test("a range of exactly 3660 days is served and 3661 is refused", async () => {
    const end = "2026-10-01";
    const startOf = (days: number) =>
      new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    expect((await get(`/embeds?start=${startOf(3660)}&end=${end}`, {})).status).toBe(200);
    expect((await get(`/embeds?start=${startOf(3661)}&end=${end}`, {})).status).toBe(400);
  });

  test("a fresh deploy with nothing configured says so, invents no zero, and caches briefly", async () => {
    const res = await get(`/embeds?start=${day(30)}&end=${day(1)}`, {});
    expect(res.status).toBe(200);
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("s-maxage=60");
    expect(cache).not.toContain("stale-while-revalidate");
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
      [...allKinds(day(3), [12, 2, 1, 1]), ...allKinds(day(2), [0, 0, 0, 0])],
      new Date().toISOString(),
    );
    await syncedNow();
    ae = stubAe();
    const body = (await (
      await get(`/embeds?start=${day(5)}&end=${day(1)}`, configured)
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
    expect(body.loads.counting_began).toBe(day(3));
    expect(body.loads.last_synced_at).not.toBeNull();
  });

  test("the public answer carries counts for sites and no hostname anywhere", async () => {
    await saveEmbedDays(db, allKinds(day(2), [307, 19, 6, 0]), new Date().toISOString());
    await syncedNow();
    ae = stubAe();
    const res = await get(`/embeds?start=${day(10)}&end=${day(1)}`, configured);
    const text = await res.text();
    const body = JSON.parse(text) as EmbedsResponse;
    expect(body.sites.summary).toEqual({
      unknown_or_local: 298,
      sites_loads: 9,
      distinct_sites: 6,
      total: 307,
      capped: false,
    });
    for (const host of [
      "localhost",
      "127.0.0.1",
      "example.org",
      "after-review.invalid",
      "probe.example",
    ]) {
      expect(text).not.toContain(host);
    }
    expect(text).not.toContain("min_named_loads");
  });

  // A refused read must show as unavailable on the lists, never as an empty
  // ranking, must not take the stored totals down with it, and must not be cached.
  test("an edge that refuses the read makes the lists unavailable, keeps the totals, and is not cached", async () => {
    await saveEmbedDays(db, allKinds(day(2), [7, 0, 0, 0]), new Date().toISOString());
    await syncedNow();
    const real = console.error;
    console.error = () => {};
    ae = stubAe({ sites: () => new Response("forbidden", { status: 403 }) });
    const res = await get(`/embeds?start=${day(3)}&end=${day(1)}`, configured);
    console.error = real;
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as EmbedsResponse;
    expect(body.loads.totals?.embedded).toBe(7);
    expect(body.sites.status).toBe("unavailable");
    expect(body.sites.summary).toBeNull();
    expect(body.datasets.status).toBe("unavailable");
    expect(JSON.stringify(body)).not.toContain("forbidden");
  });

  test("a store that is not migrated reports the totals as unavailable, not zero", async () => {
    const bare = new Database(":memory:");
    const real = console.error;
    console.error = () => {};
    const res = await worker.fetch(
      new Request(
        `https://dashboard.nemar.org/observability/api/embeds?start=${day(5)}&end=${day(1)}`,
      ),
      { OBS_DB: asD1(bare) } as unknown as Bindings,
      ctx,
    );
    console.error = real;
    bare.close();
    const body = (await res.json()) as EmbedsResponse;
    expect(body.loads.status).toBe("unavailable");
    expect(body.loads.totals).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a fresh deploy whose first sync failed is unavailable, with the lists answering", async () => {
    await recordEmbedSync(db, false, new Date().toISOString(), "read the edge: AE SQL 403");
    ae = stubAe();
    const body = (await (
      await get(`/embeds?start=${day(10)}&end=${day(1)}`, configured)
    ).json()) as EmbedsResponse;
    expect(body.loads.status).toBe("unavailable");
    expect(body.loads.note).not.toContain("No embed loads are recorded");
    expect(JSON.stringify(body.loads)).not.toContain("403");
  });

  test("future dates have their own note, and the edge is not asked", async () => {
    ae = stubAe();
    await syncedNow();
    const body = (await (
      await get("/embeds?start=2999-01-01&end=2999-01-31", configured)
    ).json()) as EmbedsResponse;
    expect(body.loads.empty_reason).toBe("future");
    expect(body.sites.reason).toBe("future");
    expect(body.sites.note).toContain("in the future");
    expect(ae.asked).toHaveLength(0);
  });

  test("a range wholly before counting began reads the same on every card, and asks the edge nothing", async () => {
    await saveEmbedDays(db, allKinds(day(10), [4, 0, 0, 0]), new Date().toISOString());
    await syncedNow();
    ae = stubAe();
    const body = (await (
      await get(`/embeds?start=${day(40)}&end=${day(20)}`, configured)
    ).json()) as EmbedsResponse;
    expect(body.loads.empty_reason).toBe("before_counting");
    expect(body.loads.totals).toBeNull();
    expect(body.sites.reason).toBe("before_counting");
    expect(body.datasets.reason).toBe("before_counting");
    expect(body.sites.summary).toBeNull();
    expect(body.sites.note).toBe(body.loads.note);
    expect(body.sites.note).toContain("unknown, not zero");
    expect(ae.asked).toHaveLength(0);
  });

  test("a range wholly older than the edge keeps has no per-site detail, said as such", async () => {
    await syncedNow();
    ae = stubAe();
    const body = (await (
      await get("/embeds?start=2025-01-01&end=2025-01-31", configured)
    ).json()) as EmbedsResponse;
    expect(body.sites.status).toBe("unavailable");
    expect(body.sites.reason).toBe("expired");
    expect(body.sites.note).toContain("three months");
    expect(body.loads.empty_reason).not.toBe("future");
    expect(ae.asked).toHaveLength(0);
  });
});

// The embedding host list: admins only, through the existing bearer drill-down.
describe("GET /drilldown/embed-sites", () => {
  let identity: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    // The one request the Worker makes of nemar-cli: who owns this bearer.
    identity = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization");
        if (auth === "Bearer admin-key")
          return Response.json({ user: { username: "ada", role: "admin" } });
        if (auth === "Bearer user-key")
          return Response.json({ user: { username: "bob", role: "user" } });
        return new Response("no", { status: 401 });
      },
    });
  });
  afterAll(() => identity.stop(true));
  const env = () => ({ ...configured, NEMAR_API_BASE: `http://localhost:${identity.port}` });
  const path = `/drilldown/embed-sites?start=${day(10)}&end=${day(0)}`;

  test("an unauthenticated request is refused, with no store and no hostnames", async () => {
    ae = stubAe();
    const res = await get(path, env());
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("localhost");
    expect(ae.asked).toHaveLength(0);
  });

  test("a malformed, unknown or non-admin bearer is refused", async () => {
    ae = stubAe();
    for (const header of ["Basic abc", "Bearer ", "Bearer wrong-key", "Bearer user-key"]) {
      const res = await get(path, env(), { Authorization: header });
      expect(res.status).toBe(401);
    }
    expect(ae.asked).toHaveLength(0);
  });

  test("an admin gets every host with loads by kind, uncached", async () => {
    ae = stubAe();
    const res = await get(path, env(), { Authorization: "Bearer admin-key" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      key: string;
      kind: string;
      count: number;
      items: {
        host: string;
        embedded: number;
        opened_directly: number;
        other: number;
        unknown_or_local: boolean;
      }[];
      note: string;
    };
    expect(body.key).toBe("embed-sites");
    expect(body.kind).toBe("embed_site");
    const byHost = new Map(body.items.map((i) => [i.host, i]));
    expect(byHost.get("localhost")).toMatchObject({ embedded: 260, unknown_or_local: true });
    expect(byHost.get("example.org")).toMatchObject({
      embedded: 1,
      other: 1,
      unknown_or_local: false,
    });
    expect(byHost.get("after-review.invalid")?.embedded).toBe(1);
    expect(body.count).toBe(body.items.length);
    expect(body.note).toContain("claims");
    expect(ae.asked[0]).toContain("GROUP BY host, kind");
  });

  test("a bad range is a 400 and a failed read is a 503, never an empty list", async () => {
    ae = stubAe();
    const bad = await get("/drilldown/embed-sites?start=x&end=y", env(), {
      Authorization: "Bearer admin-key",
    });
    expect(bad.status).toBe(400);
    ae.restore();
    const real = console.error;
    console.error = () => {};
    ae = stubAe({ sitekinds: () => ({ errors: [{ message: "denied" }] }) });
    const down = await get(path, env(), { Authorization: "Bearer admin-key" });
    console.error = real;
    expect(down.status).toBe(503);
  });

  test("the other drill-down keys are unchanged: still admin only", async () => {
    const res = await get("/drilldown/archive.missing", env());
    expect(res.status).toBe(401);
  });
});
