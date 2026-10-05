// loadEmbedLists over the captured live answers (test/helpers/ae-fixtures): the
// public sites counts, the public dataset check against a real SQLite catalog,
// the notes, the failure paths, the per-isolate memo and the shared query budget.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadEmbedLists, resetEmbedListsMemo } from "../src/lib/embed-lists";
import { claimQueryBudget } from "../src/lib/embed-store";
import { AE_ROW_LIMIT, LIST_QUERIES_PER_MINUTE, LIST_QUERY_COST } from "../src/lib/embeds";
import type { Bindings } from "../src/types";
import { type AeStub, stubAe } from "./helpers/ae-fixtures";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

let obs: Database;
let catalog: Database;
let ae: AeStub | null = null;
beforeEach(() => {
  obs = new Database(":memory:");
  for (const sql of MIGRATIONS) obs.run(sql);
  catalog = new Database(":memory:");
  catalog.run(`CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, is_sandbox INTEGER DEFAULT 0,
    status TEXT, visibility TEXT)`);
  resetEmbedListsMemo();
});
afterEach(() => {
  ae?.restore();
  ae = null;
  obs.close();
  catalog.close();
});

const env = (extra: object = {}) =>
  ({
    OBS_DB: asD1(obs),
    NEMAR_DB: asD1(catalog),
    CF_ACCOUNT_ID: "a",
    CF_ANALYTICS_TOKEN: "t",
    EMBED_AE_DATASET: "nemar_website_embeds_dev",
    ...extra,
  }) as unknown as Bindings;
const NOW = new Date("2026-10-05T15:00:00Z");
const publish = (id: string, owner = 1, sandbox = 0, status = "active", vis = "public") => {
  catalog.query("INSERT INTO datasets VALUES (?, ?, ?, ?, ?)").run(id, owner, sandbox, status, vis);
};
const quiet = () => {
  const real = console.error;
  console.error = () => {};
  return () => {
    console.error = real;
  };
};

describe("loadEmbedLists on the captured answers", () => {
  test("a dataset is named when it is public now and folded when it is not", async () => {
    // Public: on007753. xx099901 is a public sandbox dataset and nm000292 is not
    // in the catalog (the dev catalog's real state), so both fold.
    publish("on007753");
    publish("xx099901", 2, 1);
    ae = stubAe();
    const { datasets } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(datasets.summary?.rows).toEqual([
      { label: "on007753", value: 277, href: "https://nemar.org/dataset/on007753" },
    ]);
    expect(datasets.summary?.other).toBe(30);
    expect(datasets.summary?.total).toBe(307);
    const text = JSON.stringify(datasets);
    expect(text).not.toContain("xx099901");
    expect(text).not.toContain("nm000292");
  });

  test("a dataset that is made private stops being named on the next answer", async () => {
    publish("on007753");
    ae = stubAe();
    let { datasets } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(datasets.summary?.rows).toHaveLength(1);
    catalog.query("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'on007753'").run();
    // Past the memo's minute, so the answer is computed again.
    ({ datasets } = await loadEmbedLists(
      env(),
      "2026-10-04",
      "2026-10-05",
      new Date(NOW.getTime() + 61_000),
    ));
    expect(datasets.summary?.rows).toEqual([]);
    expect(datasets.summary?.other).toBe(307);
  });

  test("dataset links follow the environment's website", async () => {
    publish("on007753");
    ae = stubAe();
    const { datasets } = await loadEmbedLists(
      env({ WEBSITE_BASE_URL: "https://test.nemar.org" }),
      "2026-10-04",
      "2026-10-05",
      NOW,
    );
    expect(datasets.summary?.rows[0].href).toBe("https://test.nemar.org/dataset/on007753");
  });

  test("sites come back as counts only", async () => {
    ae = stubAe();
    const { sites } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(sites.summary).toEqual({
      unknown_or_local: 298,
      sites_loads: 9,
      distinct_sites: 6,
      total: 307,
      capped: false,
    });
    expect(JSON.stringify(sites)).not.toContain("example");
  });

  test("a range reaching today is partial with the in-progress note", async () => {
    ae = stubAe();
    const { sites } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(sites.status).toBe("partial");
    expect(sites.note).toBe("The current UTC day is still in progress.");
    expect(sites.window).toEqual({ start: "2026-10-04", end: "2026-10-05" });
  });

  test("a closed range inside retention is available with no note", async () => {
    ae = stubAe();
    const { sites } = await loadEmbedLists(env(), "2026-09-20", "2026-10-04", NOW);
    expect(sites.status).toBe("available");
    expect(sites.note).toBeUndefined();
  });

  test("a range reaching past retention is clipped, said so, and asks only for the kept days", async () => {
    ae = stubAe();
    const { sites } = await loadEmbedLists(env(), "2026-01-01", "2026-10-04", NOW);
    expect(sites.status).toBe("partial");
    expect(sites.note).toContain("only the part");
    expect(sites.window?.start).toBe("2026-07-13");
    expect(ae.asked[0]).toContain("toDateTime('2026-07-13 00:00:00')");
  });

  test("an unreadable catalog leaves the sites available and the datasets unavailable", async () => {
    const restore = quiet();
    ae = stubAe();
    const broken = new Database(":memory:");
    const { sites, datasets } = await loadEmbedLists(
      env({ NEMAR_DB: asD1(broken) }),
      "2026-10-04",
      "2026-10-05",
      NOW,
    );
    restore();
    broken.close();
    expect(sites.status).toBe("partial");
    expect(sites.summary?.total).toBe(307);
    expect(datasets.status).toBe("unavailable");
    expect(datasets.summary).toBeNull();
  });

  test("a 200 with an errors body, or an odd row, reads unavailable and is not memoized", async () => {
    const restore = quiet();
    ae = stubAe({ sites: () => ({ errors: [{ message: "denied" }] }) });
    let lists = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(lists.sites.status).toBe("unavailable");
    expect(lists.datasets.status).toBe("unavailable");
    ae.restore();
    ae = stubAe({ datasets: () => ({ data: [{ dataset_id: "on007753", loads: "many" }] }) });
    lists = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    restore();
    expect(lists.sites.status).toBe("unavailable");
    ae.restore();
    // The next call asks again and gets the good answer: failures are not kept.
    ae = stubAe();
    lists = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(lists.sites.status).toBe("partial");
  });

  test("an empty dataset answers with zero counts, not a fault", async () => {
    ae = stubAe({
      sites: () => ({ data: [] }),
      datasets: () => ({ data: [] }),
    });
    const { sites, datasets } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(sites.summary).toEqual({
      unknown_or_local: 0,
      sites_loads: 0,
      distinct_sites: 0,
      total: 0,
      capped: false,
    });
    expect(datasets.summary).toEqual({ rows: [], other: 0, total: 0 });
  });

  test("when a row cap is hit the total is queried, so the remainder stays right", async () => {
    const many = Array.from({ length: AE_ROW_LIMIT }, (_, i) => ({
      host: `h${i}.example`,
      loads: "1",
    }));
    ae = stubAe({
      sites: () => ({ data: many }),
      total: () => ({ data: [{ loads: String(AE_ROW_LIMIT + 700) }] }),
    });
    const { sites } = await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(sites.summary?.capped).toBe(true);
    expect(sites.summary?.total).toBe(AE_ROW_LIMIT + 700);
    expect(sites.summary?.sites_loads).toBe(AE_ROW_LIMIT + 700);
    expect(
      ae.asked.some((q) => q.includes("SUM(_sample_interval) AS loads") && !q.includes("GROUP BY")),
    ).toBe(true);
  });

  test("a normal answer needs only two queries: the rows add up to the total", async () => {
    ae = stubAe();
    await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    expect(ae.asked).toHaveLength(2);
  });
});

describe("the memo and the shared query budget", () => {
  test("the same window within a minute is answered once, concurrent requests included", async () => {
    ae = stubAe();
    const [a, b] = await Promise.all([
      loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW),
      loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW),
    ]);
    await loadEmbedLists(env(), "2026-10-04", "2026-10-05", new Date(NOW.getTime() + 30_000));
    expect(a).toBe(b);
    expect(ae.asked).toHaveLength(2);
  });

  test("past the minute the window is asked again", async () => {
    ae = stubAe();
    await loadEmbedLists(env(), "2026-10-04", "2026-10-05", NOW);
    await loadEmbedLists(env(), "2026-10-04", "2026-10-05", new Date(NOW.getTime() + 61_000));
    expect(ae.asked).toHaveLength(4);
  });

  test("once the minute's budget is spent, further windows are refused without asking the edge", async () => {
    ae = stubAe();
    const perMinute = Math.floor(LIST_QUERIES_PER_MINUTE / LIST_QUERY_COST);
    const statuses: string[] = [];
    // Distinct windows defeat the memo, as a flood of random ranges would.
    for (let i = 0; i < perMinute + 3; i++) {
      const start = new Date(Date.UTC(2026, 8, 1 + (i % 28))).toISOString().slice(0, 10);
      const { sites } = await loadEmbedLists(env(), start, `2026-10-0${1 + (i % 4)}`, NOW);
      statuses.push(`${sites.status}:${sites.note ?? ""}`);
    }
    const refused = statuses.filter((s) => s.includes("busy"));
    expect(refused.length).toBeGreaterThanOrEqual(3);
    // 2 queries per allowed load, none for a refused one.
    expect(ae.asked.length).toBeLessThanOrEqual(LIST_QUERIES_PER_MINUTE);
  });

  test("a budget that cannot be claimed fails closed", async () => {
    const restore = quiet();
    ae = stubAe();
    const bare = new Database(":memory:");
    const { sites } = await loadEmbedLists(
      env({ OBS_DB: asD1(bare) }),
      "2026-10-04",
      "2026-10-05",
      NOW,
    );
    restore();
    bare.close();
    expect(sites.status).toBe("unavailable");
    expect(ae.asked).toHaveLength(0);
  });

  test("claimQueryBudget counts per UTC minute, refuses past the cap, and forgets old minutes", async () => {
    const db = asD1(obs);
    const t = (s: string) => new Date(`2026-10-05T14:${s}Z`);
    expect(await claimQueryBudget(db, t("47:05"), 3, 5)).toBe(true);
    expect(await claimQueryBudget(db, t("47:40"), 2, 5)).toBe(true);
    expect(await claimQueryBudget(db, t("47:59"), 1, 5)).toBe(false);
    // A new minute starts fresh.
    expect(await claimQueryBudget(db, t("48:01"), 3, 5)).toBe(true);
    // Much later, the old rows are gone.
    await claimQueryBudget(db, new Date("2026-10-05T15:30:00Z"), 1, 5);
    const left = obs.query("SELECT COUNT(*) AS n FROM embed_query_budget").get() as { n: number };
    expect(left.n).toBe(1);
  });
});
