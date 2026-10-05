// The public rules for embed loads of the signal viewer (nemar-observability#97):
// which hosts and datasets may be named on a page with no auth, how daily totals
// are planned, zero-filled and protected, and how the edge is asked.
//
// These are tests of pure rules over explicit inputs. The edge's own answers are
// not invented here: tests over a captured answer need the dev dataset read and
// are listed in test_requirements.md.

import { describe, expect, test } from "bun:test";
import {
  EMBED_LIST_LIMIT,
  EMBED_RETENTION_DAYS,
  MIN_NAMED_SITE_LOADS,
  buildEmbedDays,
  buildLoadsBlock,
  detailWindow,
  embedDatasetsSql,
  embedDaysSql,
  embedSitesSql,
  embedTotalSql,
  groupEmbedDays,
  isEmbedConfigured,
  isUnknownOrLocalHost,
  normalizeKind,
  parseEmbedDayRows,
  planEmbedPull,
  strictCount,
  summarizeEmbedDatasets,
  summarizeEmbedSites,
  writableEmbedDays,
} from "../src/lib/embeds";
import type { Bindings } from "../src/types";

const NOW = new Date("2026-10-05T12:00:00Z");
const day = (back: number) =>
  new Date(NOW.getTime() - back * 86_400_000).toISOString().slice(0, 10);
// Written a day after it closed plus grace: settled.
const settledAt = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000).toISOString();

describe("normalizeKind", () => {
  test("keeps the three recorded kinds and folds anything else into other", () => {
    expect(normalizeKind("iframe")).toBe("iframe");
    expect(normalizeKind("document")).toBe("document");
    expect(normalizeKind("none")).toBe("none");
    expect(normalizeKind("other")).toBe("other");
    expect(normalizeKind("worker")).toBe("other");
    expect(normalizeKind(undefined)).toBe("other");
    expect(normalizeKind(null)).toBe("other");
  });
});

describe("isUnknownOrLocalHost", () => {
  test.each([
    "",
    "   ",
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "10.0.0.7",
    "192.168.1.20",
    "8.8.8.8",
    "[::1]",
    "::1",
    "[2001:db8::1]",
    "intranet",
    "2130706433",
    "printer.local",
    "dev.localhost",
    "build.internal",
    "nas.lan",
    "router.home.arpa",
    "has space.example",
    "evil/path.example",
  ])("%j is unknown or local", (host) => {
    expect(isUnknownOrLocalHost(host)).toBe(true);
  });

  test.each([
    "example.org",
    "Example.ORG",
    "example.org.",
    "after-review.invalid",
    "docs.nemar.org",
    "xn--bcher-kva.example",
    "a.b.c.example.co.uk",
  ])("%j is a site that can be named", (host) => {
    expect(isUnknownOrLocalHost(host)).toBe(false);
  });
});

describe("summarizeEmbedSites", () => {
  const rows = (entries: [string, number][]) => entries.map(([host, loads]) => ({ host, loads }));

  test("names a site at the floor and folds one just under it", () => {
    const out = summarizeEmbedSites(
      rows([
        ["at-floor.example", MIN_NAMED_SITE_LOADS],
        ["under.example", MIN_NAMED_SITE_LOADS - 1],
      ]),
      MIN_NAMED_SITE_LOADS * 2 - 1,
    );
    expect(out.rows).toEqual([{ label: "at-floor.example", value: MIN_NAMED_SITE_LOADS }]);
    expect(out.other_sites).toBe(MIN_NAMED_SITE_LOADS - 1);
    expect(out.unknown_or_local).toBe(0);
  });

  test("localhost, addresses and empty hosts are never named, however large", () => {
    const out = summarizeEmbedSites(
      rows([
        ["localhost", 500],
        ["127.0.0.1", 400],
        ["", 300],
        ["[::1]", 200],
        ["partner.example", 50],
      ]),
      1450,
    );
    expect(out.rows).toEqual([{ label: "partner.example", value: 50 }]);
    expect(out.unknown_or_local).toBe(1400);
    expect(out.other_sites).toBe(0);
    const text = JSON.stringify(out);
    for (const secret of ["localhost", "127.0.0.1", "::1"]) expect(text).not.toContain(secret);
  });

  test("the same site under different spellings is one row", () => {
    const out = summarizeEmbedSites(
      rows([
        ["Partner.Example", 6],
        ["partner.example", 5],
        ["partner.example.", 4],
      ]),
      15,
    );
    expect(out.rows).toEqual([{ label: "partner.example", value: 15 }]);
  });

  test("rows add up to the total: named, unknown or local, and other sites", () => {
    const input = rows([
      ["a.example", 40],
      ["b.example", 25],
      ["c.example", 12],
      ["d.example", 9],
      ["e.example", 1],
      ["localhost", 7],
      ["", 3],
    ]);
    const out = summarizeEmbedSites(input, 97);
    const named = out.rows.reduce((n, r) => n + r.value, 0);
    expect(named + out.unknown_or_local + out.other_sites).toBe(out.total);
    expect(out.total).toBe(97);
    expect(out.rows.map((r) => r.label)).toEqual(["a.example", "b.example", "c.example"]);
    expect(out.unknown_or_local).toBe(10);
    expect(out.other_sites).toBe(10);
  });

  test("a total above the rows (a capped read) lands in other sites, never in a name", () => {
    const out = summarizeEmbedSites(rows([["big.example", 100]]), 130);
    expect(out.rows).toEqual([{ label: "big.example", value: 100 }]);
    expect(out.other_sites).toBe(30);
    expect(out.total).toBe(130);
  });

  test("a total below the rows is raised to them rather than going negative", () => {
    const out = summarizeEmbedSites(rows([["big.example", 100]]), 80);
    expect(out.total).toBe(100);
    expect(out.other_sites).toBe(0);
  });

  test("a ranking is cut at the limit and the rest is folded into other sites", () => {
    const many = Array.from({ length: EMBED_LIST_LIMIT + 3 }, (_, i) => ({
      host: `site-${String(i).padStart(2, "0")}.example`,
      loads: 100 - i,
    }));
    const total = many.reduce((n, r) => n + r.loads, 0);
    const out = summarizeEmbedSites(many, total);
    expect(out.rows).toHaveLength(EMBED_LIST_LIMIT);
    expect(out.rows[0]).toEqual({ label: "site-00.example", value: 100 });
    const tail = many.slice(EMBED_LIST_LIMIT).reduce((n, r) => n + r.loads, 0);
    expect(out.other_sites).toBe(tail);
  });

  test("ties are ordered by name so the page does not shuffle", () => {
    const out = summarizeEmbedSites(
      rows([
        ["b.example", 20],
        ["a.example", 20],
      ]),
      40,
    );
    expect(out.rows.map((r) => r.label)).toEqual(["a.example", "b.example"]);
  });

  test("zero, negative and non-finite counts are ignored", () => {
    const out = summarizeEmbedSites(
      rows([
        ["a.example", 0],
        ["b.example", -4],
        ["c.example", Number.NaN],
      ]),
      0,
    );
    expect(out).toEqual({
      rows: [],
      unknown_or_local: 0,
      other_sites: 0,
      total: 0,
      min_named_loads: MIN_NAMED_SITE_LOADS,
    });
  });
});

describe("summarizeEmbedDatasets", () => {
  const rows = (entries: [string, number][]) =>
    entries.map(([dataset_id, loads]) => ({ dataset_id, loads }));

  test("names only public datasets and folds every other id into one unnamed count", () => {
    const out = summarizeEmbedDatasets(
      rows([
        ["on000001", 30],
        ["nm-private", 20],
        ["on000002", 10],
        ["not-in-the-catalog", 5],
      ]),
      new Set(["on000001", "on000002"]),
      65,
    );
    expect(out.rows).toEqual([
      { label: "on000001", value: 30 },
      { label: "on000002", value: 10 },
    ]);
    expect(out.other).toBe(25);
    expect(out.total).toBe(65);
    const text = JSON.stringify(out);
    expect(text).not.toContain("nm-private");
    expect(text).not.toContain("not-in-the-catalog");
  });

  test("with no public ids nothing is named, the whole total is unnamed", () => {
    const out = summarizeEmbedDatasets(rows([["on000001", 30]]), new Set(), 30);
    expect(out.rows).toEqual([]);
    expect(out.other).toBe(30);
  });

  test("a public dataset past the limit is folded, not dropped", () => {
    const many = Array.from({ length: EMBED_LIST_LIMIT + 2 }, (_, i) => ({
      dataset_id: `on${String(i).padStart(6, "0")}`,
      loads: 50 - i,
    }));
    const total = many.reduce((n, r) => n + r.loads, 0);
    const out = summarizeEmbedDatasets(many, new Set(many.map((r) => r.dataset_id)), total);
    expect(out.rows).toHaveLength(EMBED_LIST_LIMIT);
    const named = out.rows.reduce((n, r) => n + r.value, 0);
    expect(named + out.other).toBe(total);
  });
});

describe("groupEmbedDays", () => {
  test("folds none and other into one group and keeps days in order", () => {
    const out = groupEmbedDays([
      { date: "2026-10-05", kind: "iframe", loads: 4 },
      { date: "2026-10-04", kind: "none", loads: 3 },
      { date: "2026-10-04", kind: "other", loads: 2 },
      { date: "2026-10-04", kind: "document", loads: 1 },
      { date: "2026-10-04", kind: "iframe", loads: 7 },
    ]);
    expect(out).toEqual([
      { date: "2026-10-04", embedded: 7, direct: 1, other: 5 },
      { date: "2026-10-05", embedded: 4, direct: 0, other: 0 },
    ]);
  });
});

describe("planEmbedPull", () => {
  const stamps = (dates: string[], at = settledAt) => new Map(dates.map((d) => [d, at(d)]));
  const retentionStart = day(EMBED_RETENTION_DAYS - 1);

  test("with nothing stored the whole retention window is asked for once", () => {
    expect(planEmbedPull(null, new Map(), NOW)).toEqual({
      since: retentionStart,
      until: "2026-10-06",
    });
  });

  test("with every day since the first settled, only today is asked for", () => {
    const dates = [day(5), day(4), day(3), day(2), day(1)];
    expect(planEmbedPull(day(5), stamps(dates), NOW)).toEqual({
      since: "2026-10-05",
      until: "2026-10-06",
    });
  });

  test("days before the first stored day are not missing", () => {
    // The window reaches back 84 days, but nothing was counted before day(5).
    const out = planEmbedPull(day(5), stamps([day(5), day(4), day(3), day(2), day(1)]), NOW);
    expect(out.since).toBe("2026-10-05");
  });

  test("an unsettled yesterday is asked for once more, nothing older", () => {
    const dates = [day(5), day(4), day(3), day(2), day(1)];
    const out = planEmbedPull(
      day(5),
      stamps(dates, (d) => (d === day(1) ? `${d}T22:00:00Z` : settledAt(d))),
      NOW,
    );
    expect(out.since).toBe(day(1));
  });

  test("a gap in the middle reopens the range from the oldest missing day", () => {
    const dates = [day(5), day(4), day(2), day(1)];
    expect(planEmbedPull(day(5), stamps(dates), NOW).since).toBe(day(3));
  });

  test("a first day older than retention starts at the retention window", () => {
    const first = day(200);
    expect(planEmbedPull(first, new Map(), NOW).since).toBe(retentionStart);
  });
});

describe("buildEmbedDays", () => {
  test("nothing returned and nothing stored writes nothing", () => {
    expect(buildEmbedDays([], day(10), day(0), null)).toEqual([]);
  });

  test("writes all four kinds for each day from the first row, zero where absent", () => {
    const out = buildEmbedDays(
      [
        { date: day(2), kind: "iframe", loads: 6 },
        { date: day(0), kind: "document", loads: 1 },
      ],
      day(10),
      day(0),
      null,
    );
    // Days before the first row are unknown and absent; day(2) through today are
    // measured, so the quiet day(1) is a zero.
    expect(out.map((r) => r.date)).toEqual(
      Array.from({ length: 12 }, (_, i) => day(2 - Math.floor(i / 4))),
    );
    expect(out.filter((r) => r.date === day(1)).every((r) => r.loads === 0)).toBe(true);
    expect(out.find((r) => r.date === day(2) && r.kind === "iframe")?.loads).toBe(6);
    expect(out.find((r) => r.date === day(2) && r.kind === "document")?.loads).toBe(0);
    expect(out.find((r) => r.date === day(0) && r.kind === "document")?.loads).toBe(1);
  });

  test("with a first day stored, a quiet pull is zeros from the pull's start", () => {
    const out = buildEmbedDays([], day(2), day(0), day(8));
    expect(out).toHaveLength(3 * 4);
    expect(out.every((r) => r.loads === 0)).toBe(true);
    expect(out[0].date).toBe(day(2));
  });

  test("rows outside the pulled range are ignored", () => {
    const out = buildEmbedDays(
      [
        { date: day(30), kind: "iframe", loads: 99 },
        { date: day(1), kind: "iframe", loads: 3 },
      ],
      day(5),
      day(0),
      null,
    );
    expect(out.find((r) => r.loads === 99)).toBeUndefined();
    expect(out[0].date).toBe(day(1));
  });
});

describe("writableEmbedDays", () => {
  test("a closed day never goes down and its lower row is not written; the open day is replaced", () => {
    const stored = [
      { date: day(1), kind: "iframe" as const, loads: 500 },
      { date: day(0), kind: "iframe" as const, loads: 50 },
    ];
    const out = writableEmbedDays(
      stored,
      [
        { date: day(1), kind: "iframe", loads: 200 },
        { date: day(0), kind: "iframe", loads: 20 },
      ],
      day(0),
    );
    // The lower closed-day row is dropped, not written back at the stored value:
    // writing it would stamp the day as settled on a read that was not trusted.
    expect(out).toEqual([{ date: day(0), kind: "iframe", loads: 20 }]);
  });

  test("a closed day can go up and a day not yet stored is kept", () => {
    const out = writableEmbedDays(
      [{ date: day(1), kind: "iframe", loads: 5 }],
      [
        { date: day(2), kind: "iframe", loads: 9 },
        { date: day(1), kind: "iframe", loads: 6 },
      ],
      day(0),
    );
    expect(out.map((r) => r.loads)).toEqual([9, 6]);
  });
});

describe("the edge queries", () => {
  const ds = "nemar_website_embeds_dev";
  const sqls = [
    embedDaysSql(ds, "2026-10-01", "2026-10-06"),
    embedSitesSql(ds, "2026-10-01", "2026-10-06"),
    embedDatasetsSql(ds, "2026-10-01", "2026-10-06"),
    embedTotalSql(ds, "2026-10-01", "2026-10-06"),
  ];

  test("every query weights by the sample interval and never counts rows", () => {
    for (const sql of sqls) {
      expect(sql).toContain("SUM(_sample_interval)");
      expect(sql).not.toMatch(/COUNT\s*\(/i);
      expect(sql).toContain(`FROM ${ds}`);
    }
  });

  test("the window is half open on whole UTC days", () => {
    for (const sql of sqls) {
      expect(sql).toContain("timestamp >= toDateTime('2026-10-01 00:00:00')");
      expect(sql).toContain("timestamp < toDateTime('2026-10-06 00:00:00')");
    }
  });

  test("the rankings read only real embeds, and the daily totals read every kind", () => {
    expect(embedSitesSql(ds, "2026-10-01", "2026-10-06")).toContain("blob3 = 'iframe'");
    expect(embedDatasetsSql(ds, "2026-10-01", "2026-10-06")).toContain("blob3 = 'iframe'");
    expect(embedTotalSql(ds, "2026-10-01", "2026-10-06")).toContain("blob3 = 'iframe'");
    expect(embedDaysSql(ds, "2026-10-01", "2026-10-06")).not.toContain("WHERE blob3");
  });

  test("a value that is not a day cannot reach the query", () => {
    expect(() => embedDaysSql(ds, "2026-10-01'; DROP", "2026-10-06")).toThrow();
  });

  test("parseEmbedDayRows reads the edge's day and sum, tolerating strings", () => {
    expect(
      parseEmbedDayRows([
        { day: "2026-10-05", kind: "iframe", loads: "12" },
        { day: "2026-10-05", kind: "worker", loads: 3 },
      ]),
    ).toEqual([
      { date: "2026-10-05", kind: "iframe", loads: 12 },
      { date: "2026-10-05", kind: "other", loads: 3 },
    ]);
  });

  // A row that does not parse must fail the pull, never become a zero (or a
  // missing row that a zero-fill would then settle).
  test.each([
    [{ day: "not a day", kind: "iframe", loads: 1 }],
    [{ day: "2026-10-05", kind: "iframe", loads: "abc" }],
    [{ day: "2026-10-05", kind: "iframe", loads: null }],
    [{ day: "2026-10-05", kind: "iframe", loads: -3 }],
    [{ day: "2026-10-05", kind: "iframe" }],
    [{ day: null, kind: "iframe", loads: 4 }],
  ])("parseEmbedDayRows refuses the odd row %j", (row) => {
    expect(() => parseEmbedDayRows([row as never])).toThrow("could not be parsed");
  });

  test("strictCount accepts finite non-negative numbers and numeric strings only", () => {
    expect(strictCount(0)).toBe(0);
    expect(strictCount("307")).toBe(307);
    for (const bad of [
      null,
      undefined,
      "",
      " ",
      "x",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      {},
    ]) {
      expect(strictCount(bad)).toBeNull();
    }
  });
});

describe("isEmbedConfigured", () => {
  const env = (extra: Partial<Bindings>) =>
    ({ CF_ACCOUNT_ID: "acct", ...extra }) as unknown as Bindings;
  test("needs the token and the dataset name", () => {
    expect(isEmbedConfigured(env({}))).toBe(false);
    expect(isEmbedConfigured(env({ CF_ANALYTICS_TOKEN: "t" }))).toBe(false);
    expect(isEmbedConfigured(env({ EMBED_AE_DATASET: "d" }))).toBe(false);
    expect(isEmbedConfigured(env({ CF_ANALYTICS_TOKEN: " ", EMBED_AE_DATASET: "d" }))).toBe(false);
    expect(isEmbedConfigured(env({ CF_ANALYTICS_TOKEN: "t", EMBED_AE_DATASET: "d" }))).toBe(true);
  });
});

describe("detailWindow", () => {
  test("the selected dates inside what the edge keeps", () => {
    expect(detailWindow(day(30), day(1), NOW)).toEqual({
      start: day(30),
      end: day(1),
      clipped: false,
    });
  });
  test("dates older than retention are clipped, dates in the future are clipped to today", () => {
    expect(detailWindow(day(400), day(1), NOW)).toEqual({
      start: day(EMBED_RETENTION_DAYS - 1),
      end: day(1),
      clipped: true,
    });
    expect(detailWindow(day(3), "2026-12-31", NOW)).toEqual({
      start: day(3),
      end: "2026-10-05",
      clipped: true,
    });
  });
  test("a range wholly outside retention has no window", () => {
    expect(detailWindow(day(300), day(200), NOW)).toBeNull();
    expect(detailWindow("2026-11-01", "2026-11-30", NOW)).toBeNull();
  });
});

describe("buildLoadsBlock", () => {
  const row = (date: string, kind: "iframe" | "document" | "none" | "other", loads: number) => ({
    date,
    kind,
    loads,
  });

  test("not configured and nothing stored is not configured, never zero", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, false);
    expect(out.status).toBe("unconfigured");
    expect(out.totals).toBeNull();
  });

  test("configured with nothing stored is a normal empty state, not a fault", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, true);
    expect(out.status).toBe("available");
    expect(out.totals).toBeNull();
    expect(out.days_recorded).toBe(0);
    expect(out.days_in_range).toBe(30);
  });

  test("a range recorded in full and closed is available, with the three groups summed", () => {
    const rows = [
      row(day(2), "iframe", 5),
      row(day(2), "none", 2),
      row(day(1), "document", 4),
      row(day(1), "other", 1),
    ];
    const out = buildLoadsBlock(rows, day(2), day(1), NOW, true);
    expect(out.status).toBe("available");
    expect(out.totals).toEqual({ embedded: 5, direct: 4, other: 3 });
    expect(out.coverage).toEqual({ start: day(2), end: day(1) });
    expect(out.note).toBeUndefined();
  });

  test("days not recorded make it partial and say unknown, not zero", () => {
    const out = buildLoadsBlock([row(day(1), "iframe", 5)], day(10), day(1), NOW, true);
    expect(out.status).toBe("partial");
    expect(out.note).toContain("1 of 10 days");
    expect(out.note).toContain("not zero");
  });

  test("a range that includes today is partial", () => {
    const out = buildLoadsBlock([row(day(0), "iframe", 5)], day(0), day(0), NOW, true);
    expect(out.status).toBe("partial");
    expect(out.note).toContain("in progress");
  });
});
