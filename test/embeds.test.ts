// The public rules for embed loads of the signal viewer (nemar-observability#97):
// what the public page may say about embedding sites (counts, never names) and
// datasets (named only when public), how daily totals are planned, zero-filled
// and protected, how a card reflects the health of its sync, and how the edge
// is asked. Tests of pure rules over explicit inputs; the edge's own answers are
// in embed-captured.test.ts (captured live) and embed-sync.test.ts.

import { describe, expect, test } from "bun:test";
import {
  EMBED_DATASET_LIMIT,
  EMBED_RETENTION_DAYS,
  STALE_SYNC_MS,
  assertDatasetName,
  buildEmbedDays,
  buildLoadsBlock,
  detailWindow,
  embedDatasetsSql,
  embedDaysSql,
  embedSiteKindsSql,
  embedSitesSql,
  embedTotalSql,
  groupEmbedDays,
  isEmbedConfigured,
  isUnknownOrLocalHost,
  normalizeHost,
  normalizeKind,
  parseDatasetRows,
  parseEmbedDayRows,
  parseHostKindRows,
  parseHostRows,
  parseTotalRow,
  planEmbedPull,
  siteKey,
  strictCount,
  summarizeEmbedDatasets,
  summarizeEmbedSites,
  summarizeSitesForAdmin,
  websiteBase,
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
    "localhost.",
    "localhost..",
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
    "wiki.corp",
    "nas.home",
    "files.intranet",
    "vault.private",
    "app.test",
    "192-168-1-5.nip.io",
    "10.0.0.5.nip.io",
    "anything.sslip.io",
    "sslip.io",
    "myapp.localtest.me",
    "1.2.3",
    "example.123",
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
    "www.example.org",
    "notnip.io.example.org",
    "example.test.org",
    "mylocal.example",
  ])("%j is a site on the public internet", (host) => {
    expect(isUnknownOrLocalHost(host)).toBe(false);
  });

  test("every trailing dot is dropped, so one host is never several", () => {
    expect(normalizeHost("Example.ORG...")).toBe("example.org");
    expect(normalizeHost(" localhost. ")).toBe("localhost");
  });

  test("www is folded only when counting distinct sites", () => {
    expect(siteKey("WWW.Example.org.")).toBe("example.org");
    expect(siteKey("example.org")).toBe("example.org");
    expect(siteKey("web.example.org")).toBe("web.example.org");
  });
});

describe("summarizeEmbedSites", () => {
  const rows = (entries: [string, number][]) => entries.map(([host, loads]) => ({ host, loads }));

  test("the public answer is counts and carries no hostname at all", () => {
    const input = rows([
      ["big-partner.example", 400],
      ["small.example", 3],
      ["localhost", 500],
      ["127.0.0.1", 40],
      ["", 9],
      ["intranet", 2],
    ]);
    const out = summarizeEmbedSites(input, 954);
    expect(out).toEqual({
      unknown_or_local: 551,
      sites_loads: 403,
      distinct_sites: 2,
      total: 954,
      capped: false,
    });
    const text = JSON.stringify(out);
    for (const host of ["big-partner", "small.example", "localhost", "127.0.0.1", "intranet"]) {
      expect(text).not.toContain(host);
    }
    // Nothing in the shape can carry a name or a floor.
    expect(Object.keys(out).sort()).toEqual([
      "capped",
      "distinct_sites",
      "sites_loads",
      "total",
      "unknown_or_local",
    ]);
  });

  test("a host is counted whatever its count: there is no floor to probe", () => {
    const one = summarizeEmbedSites(rows([["tiny.example", 1]]), 1);
    const many = summarizeEmbedSites(rows([["tiny.example", 5000]]), 5000);
    expect(one.distinct_sites).toBe(1);
    expect(many.distinct_sites).toBe(1);
    expect(Object.keys(one)).toEqual(Object.keys(many));
  });

  test("spellings of one site are one distinct site", () => {
    const out = summarizeEmbedSites(
      rows([
        ["Partner.Example", 6],
        ["partner.example", 5],
        ["partner.example.", 4],
        ["www.partner.example", 3],
        ["other.example", 1],
      ]),
      19,
    );
    expect(out.distinct_sites).toBe(2);
    expect(out.sites_loads).toBe(19);
  });

  test("the parts add up to the total", () => {
    const out = summarizeEmbedSites(
      rows([
        ["a.example", 40],
        ["localhost", 7],
        ["", 3],
      ]),
      50,
    );
    expect(out.unknown_or_local + out.sites_loads).toBe(out.total);
  });

  test("a total above the rows (a capped read) is real-site loads, never a name", () => {
    const out = summarizeEmbedSites(rows([["big.example", 100]]), 130, true);
    expect(out.sites_loads).toBe(130);
    expect(out.capped).toBe(true);
  });

  test("a total below the rows is raised to them rather than going negative", () => {
    const out = summarizeEmbedSites(rows([["big.example", 100]]), 80);
    expect(out.total).toBe(100);
    expect(out.sites_loads).toBe(100);
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
      unknown_or_local: 0,
      sites_loads: 0,
      distinct_sites: 0,
      total: 0,
      capped: false,
    });
  });
});

describe("summarizeSitesForAdmin", () => {
  test("one row per host with loads by kind, embedded first, local hosts flagged", () => {
    const out = summarizeSitesForAdmin([
      { host: "Partner.Example", kind: "iframe", loads: 30 },
      { host: "partner.example", kind: "document", loads: 2 },
      { host: "partner.example", kind: "none", loads: 1 },
      { host: "partner.example", kind: "other", loads: 4 },
      { host: "localhost", kind: "iframe", loads: 90 },
      { host: "quiet.example", kind: "document", loads: 7 },
    ]);
    expect(out).toEqual([
      { host: "localhost", embedded: 90, opened_directly: 0, other: 0, unknown_or_local: true },
      {
        host: "partner.example",
        embedded: 30,
        opened_directly: 2,
        other: 5,
        unknown_or_local: false,
      },
      { host: "quiet.example", embedded: 0, opened_directly: 7, other: 0, unknown_or_local: false },
    ]);
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
      { label: "on000001", value: 30, href: "https://nemar.org/dataset/on000001" },
      { label: "on000002", value: 10, href: "https://nemar.org/dataset/on000002" },
    ]);
    expect(out.other).toBe(25);
    expect(out.total).toBe(65);
    const text = JSON.stringify(out);
    expect(text).not.toContain("nm-private");
    expect(text).not.toContain("not-in-the-catalog");
  });

  test("links point at the website of this environment", () => {
    const out = summarizeEmbedDatasets(
      rows([["on000001", 3]]),
      new Set(["on000001"]),
      3,
      "https://test.nemar.org",
    );
    expect(out.rows[0].href).toBe("https://test.nemar.org/dataset/on000001");
  });

  test("with no public ids nothing is named, the whole total is unnamed", () => {
    const out = summarizeEmbedDatasets(rows([["on000001", 30]]), new Set(), 30);
    expect(out.rows).toEqual([]);
    expect(out.other).toBe(30);
  });

  test("a public dataset past the limit is folded, not dropped", () => {
    const many = Array.from({ length: EMBED_DATASET_LIMIT + 2 }, (_, i) => ({
      dataset_id: `on${String(i).padStart(6, "0")}`,
      loads: 50 - i,
    }));
    const total = many.reduce((n, r) => n + r.loads, 0);
    const out = summarizeEmbedDatasets(many, new Set(many.map((r) => r.dataset_id)), total);
    expect(out.rows).toHaveLength(EMBED_DATASET_LIMIT);
    const named = out.rows.reduce((n, r) => n + r.value, 0);
    expect(named + out.other).toBe(total);
  });
});

describe("websiteBase", () => {
  test("the configured origin, without a trailing slash, else nemar.org", () => {
    expect(websiteBase({} as Bindings)).toBe("https://nemar.org");
    expect(websiteBase({ WEBSITE_BASE_URL: "https://test.nemar.org/" } as Bindings)).toBe(
      "https://test.nemar.org",
    );
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

  test("an entirely empty answer writes nothing, even with a first day stored", () => {
    // A typo'd or overridden dataset answers like this, so it must not settle zeros.
    expect(buildEmbedDays([], day(2), day(0), day(8))).toEqual([]);
    expect(buildEmbedDays([], day(2), day(0), null)).toEqual([]);
  });

  test("a quiet stretch is zeros when the same answer has rows for another day", () => {
    const out = buildEmbedDays(
      [{ date: day(9), kind: "iframe", loads: 4 }],
      day(3),
      day(0),
      day(8),
    );
    // Written from `since`, all four kinds, zero where the edge had nothing.
    expect(out).toHaveLength(4 * 4);
    expect(out[0].date).toBe(day(3));
    expect(out.every((r) => r.loads === 0)).toBe(true);
  });

  test("rows before `since` prove the dataset is live and find the first day, but are not rewritten", () => {
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
    expect(out[0].date).toBe(day(5));
    expect(out.find((r) => r.date === day(1) && r.kind === "iframe")?.loads).toBe(3);
    expect(out.find((r) => r.date === day(3))?.loads).toBe(0);
  });

  test("rows after today are ignored", () => {
    expect(
      buildEmbedDays([{ date: day(-2), kind: "iframe", loads: 1 }], day(3), day(0), null),
    ).toEqual([]);
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
    embedSiteKindsSql(ds, "2026-10-01", "2026-10-06"),
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

  test("the admin site list reads every kind per host, not only embeds", () => {
    const sql = embedSiteKindsSql(ds, "2026-10-01", "2026-10-06");
    expect(sql).toContain("GROUP BY host, kind");
    expect(sql).not.toContain("blob3 = 'iframe'");
  });

  test("a dataset name that is not a plain identifier cannot reach any query", () => {
    for (const bad of ["x; DROP TABLE y", "a b", "", "1abc", "name-with-dash", "d'--"]) {
      expect(() => embedDaysSql(bad, "2026-10-01", "2026-10-06")).toThrow(
        "not a valid dataset name",
      );
      expect(() => embedSitesSql(bad, "2026-10-01", "2026-10-06")).toThrow(
        "not a valid dataset name",
      );
      expect(() => embedDatasetsSql(bad, "2026-10-01", "2026-10-06")).toThrow(
        "not a valid dataset name",
      );
      expect(() => embedTotalSql(bad, "2026-10-01", "2026-10-06")).toThrow(
        "not a valid dataset name",
      );
      expect(() => embedSiteKindsSql(bad, "2026-10-01", "2026-10-06")).toThrow(
        "not a valid dataset name",
      );
    }
    expect(() => assertDatasetName("nemar_website_embeds_dev")).not.toThrow();
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
  const fresh = {
    last_ok_at: "2026-10-05T11:47:00.000Z",
    last_error: null,
    last_run_at: "2026-10-05T11:47:00.000Z",
  };
  const ctx = (extra: object = {}) => ({ configured: true, firstDay: null, sync: fresh, ...extra });

  test("not configured is not configured, never zero", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, ctx({ configured: false }));
    expect(out.status).toBe("unconfigured");
    expect(out.totals).toBeNull();
  });

  test("configured, synced and nothing recorded is a normal empty state, not a fault", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, ctx());
    expect(out.status).toBe("available");
    expect(out.empty_reason).toBe("none_yet");
    expect(out.totals).toBeNull();
    expect(out.days_in_range).toBe(30);
    expect(out.last_synced_at).toBe(fresh.last_ok_at);
  });

  test("a fresh deploy whose first sync failed is unavailable, never none recorded", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, {
      configured: true,
      firstDay: null,
      sync: {
        last_ok_at: null,
        last_error: "read the edge: AE SQL 403",
        last_run_at: "2026-10-05T11:47:00.000Z",
      },
    });
    expect(out.status).toBe("unavailable");
    expect(out.empty_reason).toBeNull();
    expect(out.note).toContain("failed");
    expect(out.note).not.toContain("No embed loads are recorded");
    expect(out.last_synced_at).toBeNull();
  });

  test("before the first sync has run at all it says so, also not none recorded", () => {
    const out = buildLoadsBlock([], day(30), day(1), NOW, {
      configured: true,
      firstDay: null,
      sync: { last_ok_at: null, last_error: null, last_run_at: null },
    });
    expect(out.status).toBe("unavailable");
    expect(out.note).toContain("not been collected yet");
  });

  test("a missing status row counts as never synced", () => {
    expect(buildLoadsBlock([], day(30), day(1), NOW, ctx({ sync: null })).status).toBe(
      "unavailable",
    );
  });

  test("an empty answer from a sync that went stale is unavailable and says when it last updated", () => {
    const old = new Date(NOW.getTime() - STALE_SYNC_MS - 60_000).toISOString();
    // The range reaches today, a day the missed syncs would have added.
    const out = buildLoadsBlock(
      [],
      day(30),
      day(0),
      NOW,
      ctx({ sync: { ...fresh, last_ok_at: old } }),
    );
    expect(out.status).toBe("unavailable");
    expect(out.note).toContain("Last updated");
  });

  test("recorded days with a stale sync are partial, and say when they last updated", () => {
    const old = new Date(NOW.getTime() - STALE_SYNC_MS - 60_000).toISOString();
    const out = buildLoadsBlock(
      [row(day(1), "iframe", 5), row(day(0), "iframe", 2)],
      day(1),
      day(0),
      NOW,
      ctx({ sync: { ...fresh, last_ok_at: old } }),
    );
    expect(out.status).toBe("partial");
    expect(out.totals?.embedded).toBe(7);
    expect(out.note).toContain("Last updated");
  });

  test("a stale sync does not downgrade a range that ended before its last successful day", () => {
    const old = new Date(NOW.getTime() - STALE_SYNC_MS - 60_000).toISOString();
    const stale = ctx({ sync: { ...fresh, last_ok_at: old } });
    const lastDay = old.slice(0, 10);
    const before = day(10);
    expect(before < lastDay).toBe(true);
    // Recorded days, range closed before the last good sync: complete, not partial.
    const withData = buildLoadsBlock([row(before, "iframe", 5)], before, before, NOW, stale);
    expect(withData.status).toBe("available");
    expect(withData.note).toBeUndefined();
    // Nothing recorded for such a range: the normal empty state, not unavailable.
    const empty = buildLoadsBlock([], day(20), before, NOW, stale);
    expect(empty.status).toBe("available");
    expect(empty.empty_reason).toBe("none_yet");
    // A range that reaches the last good sync's day is downgraded.
    expect(buildLoadsBlock([], day(20), lastDay, NOW, stale).status).toBe("unavailable");
    expect(buildLoadsBlock([row(lastDay, "iframe", 5)], lastDay, lastDay, NOW, stale).status).toBe(
      "partial",
    );
  });

  test("a sync just inside the stale limit is not stale", () => {
    const ok = new Date(NOW.getTime() - STALE_SYNC_MS + 60_000).toISOString();
    const out = buildLoadsBlock(
      [row(day(2), "iframe", 5), row(day(1), "iframe", 2)],
      day(2),
      day(1),
      NOW,
      ctx({ sync: { ...fresh, last_ok_at: ok } }),
    );
    expect(out.status).toBe("available");
  });

  test("a range before counting began is unknown, not none recorded", () => {
    const out = buildLoadsBlock([], day(30), day(20), NOW, ctx({ firstDay: day(10) }));
    expect(out.empty_reason).toBe("before_counting");
    expect(out.status).toBe("available");
    expect(out.totals).toBeNull();
    expect(out.note).toContain(`Counting began on ${day(10)}`);
    expect(out.note).toContain("unknown, not zero");
    expect(out.counting_began).toBe(day(10));
  });

  test("a range wholly in the future has its own note, not the empty-state one", () => {
    const out = buildLoadsBlock([], "2026-12-01", "2026-12-31", NOW, ctx());
    expect(out.empty_reason).toBe("future");
    expect(out.note).toContain("in the future");
    expect(out.note).not.toContain("No embed loads are recorded");
  });

  test("a range recorded in full and closed is available, with the three groups summed", () => {
    const rows = [
      row(day(2), "iframe", 5),
      row(day(2), "none", 2),
      row(day(1), "document", 4),
      row(day(1), "other", 1),
    ];
    const out = buildLoadsBlock(rows, day(2), day(1), NOW, ctx());
    expect(out.status).toBe("available");
    expect(out.totals).toEqual({ embedded: 5, direct: 4, other: 3 });
    expect(out.coverage).toEqual({ start: day(2), end: day(1) });
    expect(out.empty_reason).toBeNull();
    expect(out.note).toBeUndefined();
  });

  test("days not recorded make it partial and say unknown, not zero", () => {
    const out = buildLoadsBlock([row(day(1), "iframe", 5)], day(10), day(1), NOW, ctx());
    expect(out.status).toBe("partial");
    expect(out.note).toContain("1 of 10 days");
    expect(out.note).toContain("not zero");
  });

  test("a range that includes today is partial", () => {
    const out = buildLoadsBlock([row(day(0), "iframe", 5)], day(0), day(0), NOW, ctx());
    expect(out.status).toBe("partial");
    expect(out.note).toContain("in progress");
  });
});

describe("parse errors carry no values", () => {
  const SECRET_HOST = "secret-partner.example";
  const SECRET_ID = "nm-secret-private-dataset";
  const message = (call: () => unknown) => {
    try {
      call();
    } catch (err) {
      return String(err);
    }
    throw new Error("did not throw");
  };

  test("a bad row is named by position and field, never by value", () => {
    const messages = [
      message(() => parseHostRows([{ host: SECRET_HOST, loads: "abc" }])),
      message(() => parseHostKindRows([{ host: SECRET_HOST, kind: "iframe", loads: null }])),
      message(() => parseDatasetRows([{ dataset_id: SECRET_ID, loads: -1 }])),
      message(() => parseEmbedDayRows([{ day: "2026-10-05", kind: SECRET_HOST, loads: "x" }])),
      message(() => parseTotalRow([{ loads: SECRET_ID }])),
    ];
    for (const m of messages) {
      expect(m).not.toContain(SECRET_HOST);
      expect(m).not.toContain(SECRET_ID);
      expect(m).toContain("could not be parsed");
    }
    expect(messages[0]).toBe("Error: embed host row 0 could not be parsed (bad fields: loads)");
    expect(
      message(() =>
        parseHostRows([
          { host: 5, loads: 1 },
          { host: "a", loads: 1 },
        ]),
      ),
    ).toBe("Error: embed host row 0 could not be parsed (bad fields: host)");
    expect(
      message(() =>
        parseHostRows([
          { host: "a", loads: 1 },
          { host: "b", loads: "z" },
        ]),
      ),
    ).toContain("row 1");
  });
});

describe("strict list rows", () => {
  test("host, dataset and total rows parse counts, strings included", () => {
    expect(parseHostRows([{ host: "a.example", loads: "12" }])).toEqual([
      { host: "a.example", loads: 12 },
    ]);
    expect(parseDatasetRows([{ dataset_id: "on1", loads: 3 }])).toEqual([
      { dataset_id: "on1", loads: 3 },
    ]);
    expect(parseHostKindRows([{ host: "", kind: "worker", loads: "2" }])).toEqual([
      { host: "", kind: "other", loads: 2 },
    ]);
    expect(parseTotalRow([{ loads: "307" }])).toBe(307);
    expect(parseTotalRow([])).toBeNull();
  });

  test.each([
    () => parseHostRows([{ host: "a.example", loads: "abc" }]),
    () => parseHostRows([{ host: null, loads: 3 }]),
    () => parseDatasetRows([{ dataset_id: "on1", loads: null }]),
    () => parseDatasetRows([{ loads: 3 }]),
    () => parseHostKindRows([{ host: "a", kind: "iframe", loads: -1 }]),
    () => parseTotalRow([{ loads: "x" }]),
  ])("an odd row fails the read instead of becoming a zero (%#)", (call) => {
    expect(call).toThrow("could not be parsed");
  });
});
