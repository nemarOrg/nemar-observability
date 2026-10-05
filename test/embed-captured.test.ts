// The embed rules over answers captured from the real Analytics Engine dataset
// nemar_website_embeds_dev (the website's staging and preview test traffic of
// 2026-10-05), read by the dev Worker itself. See the "source" and "query" of
// each fixture for how it was captured. Nothing here is invented: the hosts
// localhost, 127.0.0.1, example.org, after-review.invalid and the empty host are
// the ones the website's own checks sent.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  buildEmbedDays,
  buildLoadsBlock,
  embedDatasetsSql,
  embedDaysSql,
  embedRetentionStart,
  embedSitesSql,
  embedTotalSql,
  groupEmbedDays,
  normalizeKind,
  parseEmbedDayRows,
  summarizeEmbedDatasets,
  summarizeEmbedSites,
  summarizeSitesForAdmin,
} from "../src/lib/embeds";
import { publicDatasetIds } from "../src/lib/sql";
import datasets from "./fixtures/embed-ae-datasets-2026-10-05.json";
import days from "./fixtures/embed-ae-days-2026-10-05.json";
import daysRetention from "./fixtures/embed-ae-days-retention-window-2026-10-05.json";
import rows24h from "./fixtures/embed-ae-rows-24h-2026-10-05.json";
import sites from "./fixtures/embed-ae-sites-2026-10-05.json";
import total from "./fixtures/embed-ae-total-2026-10-05.json";
import unwrittenDays from "./fixtures/embed-ae-unwritten-dataset-days-2026-10-05.json";
import unwrittenSites from "./fixtures/embed-ae-unwritten-dataset-sites-2026-10-05.json";
import embedsApi from "./fixtures/embeds-api-2026-09-06-to-2026-10-05.json";
import { asD1 } from "./helpers/d1";

type AeRow = Record<string, string | number | null>;
const dataOf = (fixture: { response: { data: unknown } }) => fixture.response.data as AeRow[];
const num = (v: string | number | null | undefined) => Number(v ?? 0);
const siteRows = (fixture: typeof sites) =>
  dataOf(fixture).map((r) => ({ host: String(r.host ?? ""), loads: num(r.loads) }));
const datasetRows = (fixture: typeof datasets) =>
  dataOf(fixture).map((r) => ({ dataset_id: String(r.dataset_id ?? ""), loads: num(r.loads) }));
const totalLoads = num(dataOf(total)[0]?.loads);

describe("the queries are the ones that were captured", () => {
  test("each fixture holds the SQL the Worker builds for that window", () => {
    const ds = "nemar_website_embeds_dev";
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(days.query).toBe(squash(embedDaysSql(ds, "2026-10-05", "2026-10-06")));
    expect(sites.query).toBe(squash(embedSitesSql(ds, "2026-10-05", "2026-10-06")));
    expect(datasets.query).toBe(squash(embedDatasetsSql(ds, "2026-10-05", "2026-10-06")));
    expect(total.query).toBe(squash(embedTotalSql(ds, "2026-10-05", "2026-10-06")));
    for (const f of [days, sites, datasets, total]) expect(f.http_status).toBe(200);
  });
});

describe("daily totals from the captured answer", () => {
  test("the edge returns counts as strings and they parse to the kinds recorded", () => {
    expect(dataOf(days)[0].loads).toBe("307");
    expect(parseEmbedDayRows(dataOf(days))).toEqual([
      { date: "2026-10-05", kind: "iframe", loads: 307 },
      { date: "2026-10-05", kind: "none", loads: 6 },
      { date: "2026-10-05", kind: "document", loads: 19 },
    ]);
  });

  // The retention-window fixture was captured for a window starting 2026-07-12,
  // one day wider than the cron's first pull (embedRetentionStart is 2026-07-13:
  // 85 days including the day itself). The answer is the same for both, since
  // the edge holds rows for one day only, and the query is pinned here so a
  // reader sees exactly what was captured.
  test("the retention-window fixture is the days query over 2026-07-12 to 2026-10-06", () => {
    expect(daysRetention.query.replace(/\s+/g, " ")).toBe(
      embedDaysSql("nemar_website_embeds_dev", "2026-07-12", "2026-10-06")
        .replace(/\s+/g, " ")
        .trim(),
    );
    expect(embedRetentionStart(new Date("2026-10-05T15:00:00Z"))).toBe("2026-07-13");
  });

  test("the first pull stores the first counted day with all four kinds, other as a measured zero", () => {
    const parsed = parseEmbedDayRows(dataOf(daysRetention));
    const out = buildEmbedDays(
      parsed,
      embedRetentionStart(new Date("2026-10-05T15:00:00Z")),
      "2026-10-05",
      null,
    );
    expect(out).toEqual([
      { date: "2026-10-05", kind: "iframe", loads: 307 },
      { date: "2026-10-05", kind: "document", loads: 19 },
      { date: "2026-10-05", kind: "none", loads: 6 },
      { date: "2026-10-05", kind: "other", loads: 0 },
    ]);
  });

  test("grouped for the page: 307 embedded, 19 opened directly, 6 other", () => {
    expect(groupEmbedDays(parseEmbedDayRows(dataOf(days)))).toEqual([
      { date: "2026-10-05", embedded: 307, direct: 19, other: 6 },
    ]);
  });

  test("the per-kind totals agree with the per-host rows the owner read from the same dataset", () => {
    const byKind = new Map<string, number>();
    for (const r of dataOf(rows24h))
      byKind.set(String(r.kind), (byKind.get(String(r.kind)) ?? 0) + num(r.loads));
    expect(byKind.get("iframe")).toBe(307);
    expect(byKind.get("document")).toBe(19);
    expect(byKind.get("none")).toBe(6);
    expect(totalLoads).toBe(307);
  });
});

describe("embedding sites from the captured answer", () => {
  const out = summarizeEmbedSites(siteRows(sites), totalLoads);

  test("localhost, 127.0.0.1, the empty host and the reserved .example and .invalid names are unknown or local", () => {
    // 260 + 34 + 4, plus probe.example, repeat.example, miss-then-hit.example,
    // final-head.invalid and after-review.invalid (2 + 2 + 2 + 1 + 1).
    expect(out.unknown_or_local).toBe(260 + 34 + 4 + 2 + 2 + 2 + 1 + 1);
  });

  test("the one remaining real host, example.org, is counted, and none is named", () => {
    expect(out.sites_loads).toBe(1);
    expect(out.distinct_sites).toBe(1);
    const text = JSON.stringify(out);
    for (const host of [
      "localhost",
      "127.0.0.1",
      "example.org",
      "after-review.invalid",
      "probe.example",
      "repeat.example",
      "final-head.invalid",
      "miss-then-hit.example",
    ]) {
      expect(text).not.toContain(host);
    }
  });

  test("the pieces add up to the 307 embedded loads", () => {
    expect(out.total).toBe(307);
    expect(out.unknown_or_local + out.sites_loads).toBe(307);
  });

  test("the requests that must not count left no row in the dataset", () => {
    const hosts = new Set(dataOf(rows24h).map((r) => String(r.host)));
    for (const host of hosts) expect(host).not.toContain("must-not-count");
  });

  test("the admin list, from the same hosts, does name them all, with the local ones flagged", () => {
    const perKind = dataOf(rows24h).map((r) => ({
      host: String(r.host),
      kind: normalizeKind(r.kind),
      loads: num(r.loads),
    }));
    const admin = summarizeSitesForAdmin(perKind);
    const byHost = new Map(admin.map((a) => [a.host, a]));
    expect(byHost.get("localhost")).toEqual({
      host: "localhost",
      embedded: 260,
      opened_directly: 0,
      other: 0,
      unknown_or_local: true,
    });
    expect(byHost.get("example.org")).toMatchObject({
      embedded: 1,
      other: 1,
      unknown_or_local: false,
    });
    // A reserved .invalid name never resolves, so the admin list flags it too.
    expect(byHost.get("after-review.invalid")).toMatchObject({
      embedded: 1,
      unknown_or_local: true,
    });
    expect(byHost.get("")).toMatchObject({
      opened_directly: 19,
      embedded: 4,
      other: 5,
      unknown_or_local: true,
    });
    expect(admin[0].host).toBe("localhost");
  });
});

describe("the public /embeds answer captured from the dev Worker", () => {
  const body = embedsApi.response;
  const text = JSON.stringify(body);

  test("carries no hostname, no dataset name and no naming floor", () => {
    for (const secret of [
      "localhost",
      "127.0.0.1",
      "example.org",
      "after-review.invalid",
      "probe.example",
      "repeat.example",
      "final-head.invalid",
      "miss-then-hit.example",
      "on007753",
      "xx099901",
      "nm000292",
      "min_named_loads",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("sites are counts that add up, and datasets are folded into one unnamed count", () => {
    const sites = body.sites.summary;
    expect(Object.keys(sites).sort()).toEqual([
      "capped",
      "distinct_sites",
      "sites_loads",
      "total",
      "unknown_or_local",
    ]);
    expect(sites.unknown_or_local + sites.sites_loads).toBe(sites.total);
    expect(sites.distinct_sites).toBeGreaterThan(0);
    expect(body.datasets.summary.rows).toEqual([]);
    expect(body.datasets.summary.other).toBe(body.datasets.summary.total);
    expect(body.datasets.summary.total).toBe(sites.total);
  });

  test("the loads block reports its sync and what it does not know", () => {
    expect(body.loads.last_synced_at).toMatch(/^2026-10-05T/);
    expect(body.loads.counting_began).toBe("2026-10-05");
    expect(body.loads.days_recorded).toBe(1);
    expect(body.loads.days_in_range).toBe(30);
    expect(body.loads.note).toContain("not zero");
  });
});

describe("embedded datasets from the captured answer", () => {
  const rows = datasetRows(datasets);

  // The dev catalog (nemar-db-dev) at capture time: xx099901 is an active, public
  // sandbox dataset; on007753 and nm000292 are not in it. Built as a real table
  // so the real predicate decides.
  function devCatalog() {
    const engine = new Database(":memory:");
    engine.run(`CREATE TABLE datasets (
      dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, is_sandbox INTEGER DEFAULT 0,
      status TEXT, visibility TEXT)`);
    engine.query("INSERT INTO datasets VALUES ('xx099901', 2, 1, 'active', 'public')").run();
    return engine;
  }

  test("a public sandbox dataset and ids absent from the catalog are never named", async () => {
    const engine = devCatalog();
    const publicIds = await publicDatasetIds(
      asD1(engine),
      rows.map((r) => r.dataset_id),
    );
    engine.close();
    expect(publicIds.size).toBe(0);
    const out = summarizeEmbedDatasets(rows, publicIds, totalLoads);
    expect(out.rows).toEqual([]);
    expect(out.other).toBe(307);
    const text = JSON.stringify(out);
    for (const id of ["xx099901", "on007753", "nm000292"]) expect(text).not.toContain(id);
  });

  test("were on007753 public it would be named, and the other two stay folded", () => {
    const out = summarizeEmbedDatasets(rows, new Set(["on007753"]), totalLoads);
    expect(out.rows).toEqual([
      { label: "on007753", value: 277, href: "https://nemar.org/dataset/on007753" },
    ]);
    expect(out.other).toBe(28 + 2);
    expect(JSON.stringify(out)).not.toContain("xx099901");
  });
});

describe("a dataset nothing has been written to yet", () => {
  // The production situation before the website's counting ships: the edge
  // answers 200 with no rows, not an error.
  test("the edge answers with an empty result, not a failure", () => {
    expect(unwrittenDays.http_status).toBe(200);
    expect(unwrittenDays.response.data).toEqual([]);
    expect(unwrittenSites.response.data).toEqual([]);
  });

  test("an empty answer stores nothing, and the page says none are recorded rather than unavailable", () => {
    const parsed = parseEmbedDayRows(dataOf(unwrittenDays));
    expect(parsed).toEqual([]);
    expect(buildEmbedDays(parsed, "2026-07-13", "2026-10-05", null)).toEqual([]);
    // After a sync that succeeded with nothing to write.
    const block = buildLoadsBlock(
      [],
      "2026-09-06",
      "2026-10-05",
      new Date("2026-10-05T15:00:00Z"),
      {
        configured: true,
        firstDay: null,
        sync: {
          last_ok_at: "2026-10-05T14:47:00.000Z",
          last_error: null,
          last_run_at: "2026-10-05T14:47:00.000Z",
        },
      },
    );
    expect(block.status).toBe("available");
    expect(block.empty_reason).toBe("none_yet");
    expect(block.note).toBe("No embed loads are recorded for these dates.");
    const sitesSummary = summarizeEmbedSites(siteRows(unwrittenSites), 0);
    expect(sitesSummary).toEqual({
      unknown_or_local: 0,
      sites_loads: 0,
      distinct_sites: 0,
      total: 0,
      capped: false,
    });
  });
});
