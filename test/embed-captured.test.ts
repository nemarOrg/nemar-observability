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
  embedSitesSql,
  embedTotalSql,
  groupEmbedDays,
  parseEmbedDayRows,
  summarizeEmbedDatasets,
  summarizeEmbedSites,
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

  test("the first pull stores the first counted day with all four kinds, other as a measured zero", () => {
    const parsed = parseEmbedDayRows(dataOf(daysRetention));
    // The pull reaches back 85 days, but the edge has rows for one day only.
    const out = buildEmbedDays(parsed, "2026-07-12", "2026-10-05", null);
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

  test("localhost and 127.0.0.1 and the empty host are grouped as unknown or local", () => {
    expect(out.unknown_or_local).toBe(260 + 34 + 4);
    const text = JSON.stringify(out);
    expect(text).not.toContain("localhost");
    expect(text).not.toContain("127.0.0.1");
  });

  test("every real site here has fewer than 10 embedded loads, so none is named", () => {
    expect(out.rows).toEqual([]);
    expect(out.other_sites).toBe(2 + 2 + 2 + 1 + 1 + 1);
    const text = JSON.stringify(out);
    for (const host of [
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
    expect(out.rows.reduce((n, r) => n + r.value, 0) + out.unknown_or_local + out.other_sites).toBe(
      307,
    );
  });

  test("the requests that must not count left no row in the dataset", () => {
    const hosts = new Set(dataOf(rows24h).map((r) => String(r.host)));
    for (const host of hosts) expect(host).not.toContain("must-not-count");
  });

  test("a site that did reach the floor would be named, and local hosts still would not", () => {
    // Same captured rows with one real host's count raised to the floor.
    const raised = siteRows(sites).map((r) => (r.host === "example.org" ? { ...r, loads: 10 } : r));
    const named = summarizeEmbedSites(raised, totalLoads + 9);
    expect(named.rows).toEqual([{ label: "example.org", value: 10 }]);
    expect(named.unknown_or_local).toBe(298);
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
    expect(out.rows).toEqual([{ label: "on007753", value: 277 }]);
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
    expect(buildEmbedDays(parsed, "2026-07-12", "2026-10-05", null)).toEqual([]);
    const block = buildLoadsBlock(
      [],
      "2026-09-06",
      "2026-10-05",
      new Date("2026-10-05T15:00:00Z"),
      true,
    );
    expect(block.status).toBe("available");
    expect(block.note).toBe("No embed loads are recorded for these dates.");
    const sitesSummary = summarizeEmbedSites(siteRows(unwrittenSites), 0);
    expect(sitesSummary).toEqual({
      rows: [],
      unknown_or_local: 0,
      other_sites: 0,
      total: 0,
      min_named_loads: 10,
    });
  });
});
