// Reading Zarr indexes over HTTP with an ETag-keyed summary cache, and listing
// the public catalog. The servers are real local HTTP servers (Bun.serve) that
// behave like S3 and the NEMAR API; the bodies they serve are the committed real
// indexes. Nothing replaces the collector's own code.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectionError } from "../scripts/lib/s3-cloudwatch";
import {
  SummaryCache,
  USER_AGENT,
  isDatasetId,
  listPublicDatasets,
  mapPool,
  readDatasetIndex,
  scanDatasets,
} from "../scripts/lib/zarr-index-source";
import { summarizeIndex } from "../scripts/lib/zarr-recordings";
import {
  type CatalogRow,
  type IndexServer,
  allFixtureObjects,
  datasetIdOf,
  fixtureBytes,
  fixtureObject,
  served,
  startCatalogServer,
  startDroppingServer,
  startIndexServer,
} from "./helpers/zarr-fixtures";

let dir: string;
let index: IndexServer;
let objects: ReturnType<typeof allFixtureObjects>;
let cacheDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zarr-source-"));
  cacheDir = join(dir, "summaries");
  objects = allFixtureObjects();
  index = startIndexServer(objects);
});

afterEach(async () => {
  index.stop();
  await rm(dir, { recursive: true, force: true });
});

const fast = { retryDelayMs: 0 };
const expectedSummary = (fixture: string) =>
  summarizeIndex(fixtureObject(fixture), datasetIdOf(fixture));
const opts = async (extra: Partial<Parameters<typeof readDatasetIndex>[1]> = {}) => ({
  indexBase: index.url,
  cache: await SummaryCache.open(cacheDir),
  ...fast,
  ...extra,
});

describe("reading an index", () => {
  test("downloads, summarizes, and caches it under its ETag", async () => {
    const options = await opts();
    const result = await readDatasetIndex("nm000118", options);
    expect(result).toEqual({
      kind: "summary",
      summary: expectedSummary("nm000118"),
      from: "network",
    });
    expect(index.requests).toEqual([
      expect.objectContaining({ id: "nm000118", ifNoneMatch: null, status: 200 }),
    ]);
    const entry = await options.cache.read("nm000118");
    expect(entry?.etag).toBe(objects.get("nm000118")?.etag);
    expect(entry?.summary).toEqual(expectedSummary("nm000118"));
    // The request identifies the collector honestly and carries no credential.
    expect(index.requests[0].userAgent).toBe(USER_AGENT);
    expect(index.requests[0].authorization).toBeNull();
  });

  test("a later run revalidates with If-None-Match and downloads no body", async () => {
    const options = await opts();
    await readDatasetIndex("on000117", options);
    index.requests.length = 0;
    const again = await readDatasetIndex("on000117", options);
    expect(again).toEqual({
      kind: "summary",
      summary: expectedSummary("on000117"),
      from: "cache",
    });
    expect(index.requests).toHaveLength(1);
    expect(index.requests[0].status).toBe(304);
    expect(index.requests[0].ifNoneMatch).toBe(objects.get("on000117")?.etag ?? "");
  });

  test("a changed index (new ETag) is downloaded again and replaces the cache entry", async () => {
    const options = await opts();
    await readDatasetIndex("nm000118", options);
    const before = await options.cache.read("nm000118");

    // The dataset is re-converted: the object now holds nm000105's stores
    // under nm000118's id, so both the ETag and the numbers change.
    const changed = fixtureObject("nm000105");
    changed.dataset_id = "nm000118";
    index.stop();
    const reconverted = allFixtureObjects();
    reconverted.set("nm000118", served(changed));
    index = startIndexServer(reconverted);

    const after = await readDatasetIndex("nm000118", { ...options, indexBase: index.url });
    expect(after.kind === "summary" && after.from).toBe("network");
    expect(index.requests[0]).toMatchObject({ ifNoneMatch: before?.etag, status: 200 });
    const updated = await options.cache.read("nm000118");
    expect(updated?.etag).not.toBe(before?.etag);
    expect(after.kind === "summary" && after.summary.measuredStores).toBe(100);
  });

  test("a server that ignores If-None-Match but sends the same ETag costs no re-parse", async () => {
    const options = await opts();
    await readDatasetIndex("nm000105", options);
    index.state.ignoreConditional = true;
    index.requests.length = 0;
    const again = await readDatasetIndex("nm000105", options);
    expect(again).toMatchObject({ kind: "summary", from: "cache" });
    expect(index.requests).toEqual([expect.objectContaining({ status: 200 })]);
  });

  test("a missing index answers 403 on S3 and 404 elsewhere; both mean no index when none was ever read", async () => {
    index.stop();
    index = startIndexServer(new Map());
    const options = await opts();
    for (const status of [403, 404]) {
      index.state.missingStatus = status;
      expect(await readDatasetIndex("nm000118", { ...options, indexBase: index.url })).toEqual({
        kind: "absent",
      });
    }
  });

  test("an index that was readable before and is missing now is a regression, not no index", async () => {
    const options = await opts();
    await readDatasetIndex("nm000118", options);
    const known = expectedSummary("nm000118").storeSeconds;
    index.stop();
    index = startIndexServer(new Map());
    for (const status of [403, 404]) {
      index.state.missingStatus = status;
      const result = await readDatasetIndex("nm000118", { ...options, indexBase: index.url });
      expect(result).toEqual({
        kind: "unavailable",
        reason: "the index was readable on an earlier run and is missing now",
        lastKnownSeconds: known,
      });
    }
    // The old summary stays on disk: it is the reference for how much is missing.
    expect((await options.cache.read("nm000118"))?.summary.storeSeconds).toBe(known);
  });

  test("a failed ETag check is never answered from the cache: the dataset is unavailable", async () => {
    const options = await opts();
    await readDatasetIndex("nm000118", options);
    index.state.failures.set("nm000118", [500, 500, 500]);
    index.requests.length = 0;
    const result = await readDatasetIndex("nm000118", options);
    expect(result).toEqual({
      kind: "unavailable",
      reason: "HTTP 500",
      lastKnownSeconds: expectedSummary("nm000118").storeSeconds,
    });
    expect(index.requests.map((request) => request.status)).toEqual([500, 500, 500]);
    // The cached summary is untouched, ready for the next successful check.
    expect(await options.cache.read("nm000118")).not.toBeNull();
  });

  test("a transient server error is retried and then succeeds", async () => {
    const options = await opts();
    index.state.failures.set("nm000118", [503, 429]);
    const result = await readDatasetIndex("nm000118", options);
    expect(result).toMatchObject({ kind: "summary", from: "network" });
    expect(index.requests.map((request) => request.status)).toEqual([503, 429, 200]);
  });

  test("a download cut off mid-body is retried, then reported unavailable", async () => {
    const dropping = startDroppingServer(fixtureBytes("nm000105"), 20_000);
    try {
      const options = { ...(await opts()), indexBase: dropping.url };
      const result = await readDatasetIndex("nm000105", options);
      expect(result.kind).toBe("unavailable");
      expect(dropping.connections()).toBe(3);
      expect(await options.cache.read("nm000105")).toBeNull();
    } finally {
      dropping.stop();
    }
  });

  test("a body that ends early without an error is retried as a truncated download", async () => {
    const half = fixtureBytes("nm000118").subarray(0, 4000);
    index.stop();
    index = startIndexServer(new Map([["nm000118", served(half)]]));
    const result = await readDatasetIndex("nm000118", await opts());
    expect(result).toEqual({ kind: "unavailable", reason: "the download ended early" });
    expect(index.requests).toHaveLength(3);
  });

  test("a complete but malformed index is not retried and nothing is cached", async () => {
    index.stop();
    index = startIndexServer(
      new Map([
        ["nm000118", served(new TextEncoder().encode("<html>Service unavailable</html>"))],
        [
          "on004457",
          served(new TextEncoder().encode('{"format":"nemar-zarr-index","stores":[{"a":}]}')),
        ],
      ]),
    );
    const options = await opts();
    for (const id of ["nm000118", "on004457"]) {
      const result = await readDatasetIndex(id, options);
      expect(result.kind).toBe("unavailable");
      expect(result.kind === "unavailable" && result.reason).toMatch(/malformed index/);
      expect(await options.cache.read(id)).toBeNull();
    }
    expect(index.requests).toHaveLength(2);
  });

  test("an index that belongs to another dataset is refused", async () => {
    index.stop();
    index = startIndexServer(new Map([["on004457", served(fixtureBytes("nm000118"))]]));
    const result = await readDatasetIndex("on004457", await opts());
    expect(result).toEqual({
      kind: "unavailable",
      reason: "unusable index: the index belongs to a different dataset",
    });
    expect(index.requests).toHaveLength(1);
  });

  test("a stalled download times out as unavailable", async () => {
    const stalled = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"format":"nemar-zarr-index","stores":['),
              );
              // never closes
            },
          }),
        ),
    });
    try {
      const result = await readDatasetIndex("nm000118", {
        indexBase: stalled.url.href,
        cache: await SummaryCache.open(null),
        attempts: 1,
        idleTimeoutMs: 100,
        headerTimeoutMs: 1000,
      });
      expect(result).toEqual({ kind: "unavailable", reason: "timed out" });
    } finally {
      stalled.stop(true);
    }
  });

  test("works with the cache disabled, downloading every time", async () => {
    const options = { indexBase: index.url, cache: await SummaryCache.open(null), ...fast };
    expect(options.cache.enabled).toBe(false);
    await readDatasetIndex("nm000118", options);
    await readDatasetIndex("nm000118", options);
    expect(index.requests.map((request) => request.status)).toEqual([200, 200]);
    expect(index.requests.every((request) => request.ifNoneMatch === null)).toBe(true);
  });
});

describe("the summary cache", () => {
  test("is safe to lose: deleting it only costs a download", async () => {
    const options = await opts();
    await readDatasetIndex("nm000118", options);
    await rm(cacheDir, { recursive: true, force: true });
    const reopened = await opts();
    const result = await readDatasetIndex("nm000118", reopened);
    expect(result).toMatchObject({ kind: "summary", from: "network" });
    expect(result.kind === "summary" && result.summary).toEqual(expectedSummary("nm000118"));
  });

  test("ignores a corrupt, foreign, or outdated entry instead of trusting it", async () => {
    const options = await opts();
    await readDatasetIndex("nm000118", options);
    const path = join(cacheDir, "nm000118.json");
    const good = JSON.parse(await readFile(path, "utf8"));
    const variants: Record<string, string> = {
      "not json": "{ broken",
      "empty file": "",
      "another version": JSON.stringify({ ...good, v: 99 }),
      "another dataset": JSON.stringify({ ...good, dataset_id: "nm000999" }),
      "no etag": JSON.stringify({ ...good, etag: "" }),
      "bad summary": JSON.stringify({ ...good, summary: { modalities: "x" } }),
      "wrong type": "[]",
    };
    for (const [name, text] of Object.entries(variants)) {
      await writeFile(path, text);
      expect({ name, entry: await options.cache.read("nm000118") }).toEqual({ name, entry: null });
      index.requests.length = 0;
      const result = await readDatasetIndex("nm000118", options);
      // Without a usable entry the request is unconditional and re-fills the cache.
      expect({ name, from: result.kind === "summary" && result.from }).toEqual({
        name,
        from: "network",
      });
      expect(index.requests[0].ifNoneMatch).toBeNull();
      expect(await options.cache.read("nm000118")).not.toBeNull();
    }
  });

  test("a write leaves no temporary file behind and replaces an entry whole", async () => {
    const cache = await SummaryCache.open(cacheDir);
    const summary = expectedSummary("on004457");
    for (let i = 0; i < 20; i += 1)
      expect(await cache.write("on004457", `"etag-${i}"`, summary)).toBe(true);
    expect((await readdir(cacheDir)).sort()).toEqual(["on004457.json"]);
    expect((await cache.read("on004457"))?.etag).toBe('"etag-19"');
  });

  test("concurrent runs sharing one cache directory leave valid entries", async () => {
    const ids = ["nm000118", "on004457", "nm000105", "on000117", "on005873", "on005065"];
    const run = async () => {
      const cache = await SummaryCache.open(cacheDir);
      return Promise.all(
        ids.map((id) => readDatasetIndex(id, { indexBase: index.url, cache, ...fast })),
      );
    };
    const results = (await Promise.all([run(), run(), run(), run()])).flat();
    expect(results.every((result) => result.kind === "summary")).toBe(true);
    const files = (await readdir(cacheDir)).sort();
    expect(files).toEqual(ids.map((id) => `${id}.json`).sort());
    const cache = await SummaryCache.open(cacheDir);
    for (const id of ids) expect((await cache.read(id))?.summary).toBeDefined();
    // And a following run is entirely revalidation.
    index.requests.length = 0;
    await run();
    expect(index.requests.every((request) => request.status === 304)).toBe(true);
  });

  test("sweeps temporary files an interrupted run left, but not a fresh one", async () => {
    await mkdir(cacheDir, { recursive: true });
    const old = join(cacheDir, ".nm000118.123.aaaa.tmp");
    const fresh = join(cacheDir, ".nm000118.456.bbbb.tmp");
    await writeFile(old, "partial");
    await writeFile(fresh, "in progress");
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await utimes(old, longAgo, longAgo);
    await SummaryCache.open(cacheDir);
    expect(await readdir(cacheDir)).toEqual([".nm000118.456.bbbb.tmp"]);
  });

  test("prunes entries for datasets that are no longer public", async () => {
    const cache = await SummaryCache.open(cacheDir);
    const summary = expectedSummary("on004457");
    await cache.write("on004457", '"a"', summary);
    await cache.write("nm000118", '"b"', summary);
    await writeFile(join(cacheDir, "notes.txt"), "keep");
    expect(await cache.prune(new Set(["nm000118"]))).toBe(1);
    expect((await readdir(cacheDir)).sort()).toEqual(["nm000118.json", "notes.txt"]);
  });

  test("refuses ids that are not plain dataset ids, so a path can never escape the directory", async () => {
    const cache = await SummaryCache.open(cacheDir);
    const summary = expectedSummary("on004457");
    for (const bad of ["../escape", "nm000118/../x", "NM000118", "nm00118", "", "a b"]) {
      expect(isDatasetId(bad)).toBe(false);
      expect(await cache.write(bad, '"a"', summary)).toBe(false);
      expect(await cache.read(bad)).toBeNull();
    }
    expect(await readdir(cacheDir)).toEqual([]);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  test("an unusable cache directory degrades to no cache instead of failing the run", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "a file, not a directory");
    const warnings: string[] = [];
    const cache = await SummaryCache.open(join(blocker, "summaries"), (message) =>
      warnings.push(message),
    );
    expect(cache.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(await cache.write("nm000118", '"a"', expectedSummary("nm000118"))).toBe(false);
  });
});

describe("scanning every public dataset", () => {
  const dataset = (id: string, expectIndex = true) => ({ id, valid: isDatasetId(id), expectIndex });

  test("separates summaries, datasets without an index, and unreadable ones", async () => {
    index.state.failures.set("on004457", [500, 500, 500]);
    const unavailable: string[] = [];
    const outcomes = await scanDatasets(
      [
        dataset("nm000118"),
        dataset("on004457"), // server error
        dataset("nm000999", false), // no Zarr copy, none expected
        dataset("on009999", true), // marked ready but its index is gone
        dataset("../bad"), // an id the catalog should never give
        dataset("nm000105"),
      ],
      {
        indexBase: index.url,
        cache: await SummaryCache.open(cacheDir),
        ...fast,
        concurrency: 3,
        onUnavailable: (id) => unavailable.push(id),
      },
    );
    expect(outcomes.map((outcome) => [outcome.id, outcome.kind])).toEqual([
      ["nm000118", "summary"],
      ["on004457", "unavailable"],
      ["nm000999", "absent"],
      ["on009999", "unavailable"],
      ["../bad", "unavailable"],
      ["nm000105", "summary"],
    ]);
    expect(unavailable.sort()).toEqual(["../bad", "on004457", "on009999"]);
    // The unusable id never reached the network.
    expect(index.requests.some((request) => request.id === "")).toBe(false);
  });

  test("mapPool keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapPool([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running -= 1;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
  });
});

describe("listing the public catalog", () => {
  const ids = (count: number, prefix = "nm"): CatalogRow[] =>
    Array.from({ length: count }, (_, i) => ({
      dataset_id: `${prefix}${String(i).padStart(6, "0")}`,
    }));

  test("pages through the whole catalog, anonymously", async () => {
    const catalog = startCatalogServer(ids(450));
    try {
      const datasets = await listPublicDatasets(catalog.url, { pageSize: 200, retryDelayMs: 0 });
      expect(datasets).toHaveLength(450);
      // Paging runs to an empty page rather than stopping at total_count.
      expect(catalog.seen.map((request) => request.url)).toEqual([
        "/datasets?limit=200&offset=0",
        "/datasets?limit=200&offset=200",
        "/datasets?limit=200&offset=400",
        "/datasets?limit=200&offset=450",
      ]);
      expect(catalog.seen.every((request) => request.authorization === null)).toBe(true);
      expect(catalog.seen.every((request) => request.userAgent === USER_AGENT)).toBe(true);
    } finally {
      catalog.stop();
    }
  });

  test("keeps only active public managed datasets, once each, and marks the ready ones", async () => {
    const rows: CatalogRow[] = [
      { dataset_id: "nm000001" },
      { dataset_id: "nm000002", zarr_status: "failed" },
      { dataset_id: "nm000003", zarr_status: "pending" },
      { dataset_id: "nm000004", zarr_status: null },
      { dataset_id: "nm000005", visibility: "private" },
      { dataset_id: "nm000006", status: "draft" },
      { dataset_id: "nm000007", source_type: "catalog" },
      { dataset_id: "not an id" },
    ];
    const catalog = startCatalogServer(rows);
    try {
      const datasets = await listPublicDatasets(catalog.url, { retryDelayMs: 0 });
      expect(datasets).toEqual([
        { id: "nm000001", valid: true, expectIndex: true },
        { id: "nm000002", valid: true, expectIndex: false },
        { id: "nm000003", valid: true, expectIndex: false },
        { id: "nm000004", valid: true, expectIndex: false },
        { id: "not an id", valid: false, expectIndex: true },
      ]);
      expect(datasets.map((d) => d.id)).not.toContain("nm000005");
    } finally {
      catalog.stop();
    }
  });

  test("a catalog that cannot be read in full fails the run", async () => {
    const catalog = startCatalogServer(ids(5));
    try {
      catalog.state.failWith = 500;
      const options = { retryDelayMs: 0, attempts: 3 };
      await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow(CollectionError);
      await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow("HTTP 500");
      expect(catalog.seen).toHaveLength(6); // three tries each
    } finally {
      catalog.stop();
    }
  });

  test("an empty catalog is a failure, not zero datasets", async () => {
    const catalog = startCatalogServer([]);
    try {
      await expect(listPublicDatasets(catalog.url, { retryDelayMs: 0 })).rejects.toThrow(
        "no public datasets",
      );
    } finally {
      catalog.stop();
    }
  });

  test("a catalog that ends before its own total is a failure, never a short list", async () => {
    const shortServer = Bun.serve({
      port: 0,
      fetch: (request) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        const rows = offset === 0 ? ids(2) : [];
        return Response.json({
          datasets: rows.map((row) => ({ status: "active", visibility: "public", ...row })),
          total_count: 5,
        });
      },
    });
    try {
      await expect(
        listPublicDatasets(shortServer.url.href, { pageSize: 2, retryDelayMs: 0 }),
      ).rejects.toThrow("lists 2 datasets but reports a total of 5");
    } finally {
      shortServer.stop(true);
    }
  });

  test("an unexpected response shape is a failure", async () => {
    const odd = Bun.serve({ port: 0, fetch: () => Response.json({ rows: [] }) });
    try {
      await expect(listPublicDatasets(odd.url.href, { retryDelayMs: 0 })).rejects.toThrow(
        "unexpected shape",
      );
    } finally {
      odd.stop(true);
    }
  });
});
