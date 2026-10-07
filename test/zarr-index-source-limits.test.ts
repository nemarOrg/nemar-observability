// What the collector does when the network or the data misbehaves: which
// failures are retried and which are final, the limits on one index read, a
// catalog that cannot be trusted to be complete, and the cache's guarantees
// under rewrites. Servers are real local HTTP or TCP servers; hostile documents
// are built by editing or extending the real fixtures.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonShapeError, StreamReadError } from "../scripts/lib/json-stream";
import { CollectionError } from "../scripts/lib/s3-cloudwatch";
import {
  SummaryCache,
  assertCatalogPlausible,
  classifyFailure,
  listPublicDatasets,
  readDatasetIndex,
  retryPauses,
} from "../scripts/lib/zarr-index-source";
import {
  type DatasetSummary,
  IndexFormatError,
  SUMMARY_VERSION,
  summarizeIndex,
} from "../scripts/lib/zarr-recordings";
import {
  type CatalogRow,
  type IndexServer,
  allFixtureObjects,
  fixtureObject,
  served,
  startCatalogServer,
  startIndexServer,
  startTricklingServer,
} from "./helpers/zarr-fixtures";

let dir: string;
let index: IndexServer;
let cacheDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zarr-limits-"));
  cacheDir = join(dir, "summaries");
  index = startIndexServer(allFixtureObjects());
});

afterEach(async () => {
  index.stop();
  await rm(dir, { recursive: true, force: true });
});

const read = async (id: string, extra: Record<string, unknown> = {}) =>
  readDatasetIndex(id, {
    indexBase: index.url,
    cache: await SummaryCache.open(cacheDir),
    retryDelayMs: 0,
    ...extra,
  });

const encode = (text: string) => new TextEncoder().encode(text);
const ROOT = '{"format":"nemar-zarr-index","format_version":3,"dataset_id":"nm000118",';

describe("which failures are retried", () => {
  const ctx = { limit: null, aborted: false, stage: "body" as const };

  test("only the network's own failures are retried", () => {
    const retry = (error: unknown, context = ctx) => classifyFailure(error, context).attempt;
    expect(retry(new TypeError("fetch failed"), { ...ctx, stage: "fetch" })).toEqual({
      kind: "retry",
      reason: "network error",
    });
    expect(retry(new StreamReadError(new Error("reset")))).toEqual({
      kind: "retry",
      reason: "network error",
    });
    expect(retry(new Error("x"), { ...ctx, aborted: true })).toEqual({
      kind: "retry",
      reason: "timed out",
    });
    expect(retry(new JsonShapeError("cut", true))).toEqual({
      kind: "retry",
      reason: "the download ended early",
    });
  });

  test("a bad document, a broken limit, and a bug are final, and only a bug is reported as one", () => {
    const final = classifyFailure(new IndexFormatError("wrong dataset"), ctx);
    expect(final.attempt).toEqual({ kind: "unavailable", reason: "unusable index: wrong dataset" });
    expect(final.bug).toBeUndefined();
    const malformed = classifyFailure(new JsonShapeError("bad bracket"), ctx);
    expect(malformed.attempt).toEqual({
      kind: "unavailable",
      reason: "malformed index: bad bracket",
    });
    const limited = classifyFailure(new Error("aborted by the limit"), {
      ...ctx,
      limit: "the index is larger than 5 bytes",
      aborted: true,
    });
    expect(limited.attempt).toEqual({
      kind: "unavailable",
      reason: "the index is larger than 5 bytes",
    });
    expect(limited.bug).toBeUndefined();

    for (const bug of [
      new TypeError("x is not a function"),
      new RangeError("stack"),
      "thrown text",
    ]) {
      const verdict = classifyFailure(bug, ctx);
      expect(verdict.attempt.kind).toBe("unavailable");
      expect(verdict.bug).toBe(bug);
    }
  });

  test("a client error is final and a server error is not", async () => {
    index.state.failures.set("nm000118", [400]);
    expect(await read("nm000118")).toEqual({ kind: "unavailable", reason: "HTTP 400" });
    expect(index.requests.map((r) => r.status)).toEqual([400]);

    index.requests.length = 0;
    index.state.failures.set("on004457", [408, 429]);
    expect(await read("on004457")).toMatchObject({ kind: "summary", from: "network" });
    expect(index.requests.map((r) => r.status)).toEqual([408, 429, 200]);
  });
});

describe("limits on one index read", () => {
  test("a body over the byte cap is final, after one request", async () => {
    const result = await read("nm000105", { maxBytes: 5_000 });
    expect(result).toEqual({
      kind: "unavailable",
      reason: "the index is larger than 5000 bytes",
    });
    expect(index.requests).toHaveLength(1);
    // Nothing partial was cached.
    expect(await (await SummaryCache.open(cacheDir)).read("nm000105")).toBeNull();
  });

  test("a body that trickles forever hits the deadline even though it is never idle", async () => {
    const trickle = startTricklingServer(5);
    try {
      const started = Date.now();
      const result = await readDatasetIndex("nm000118", {
        indexBase: trickle.url,
        cache: await SummaryCache.open(null),
        retryDelayMs: 0,
        idleTimeoutMs: 10_000, // bytes keep arriving, so this never fires
        deadlineMs: 1_000,
      });
      expect(result).toEqual({
        kind: "unavailable",
        reason: "the index took longer than 1 s to read",
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(trickle.connections()).toBe(1); // final: not asked again
    } finally {
      trickle.stop();
    }
  });

  test("an entry nested a million brackets deep is final and cheap", async () => {
    // A hostile copy of nothing real: one store that never closes its brackets.
    index.stop();
    index = startIndexServer(
      new Map([["nm000118", served(encode(`${ROOT}"stores":[{"x":${"[".repeat(1_000_000)}`))]]),
    );
    const result = await read("nm000118");
    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.reason).toMatch(
      /malformed index: .*nests deeper/,
    );
    expect(index.requests).toHaveLength(1);
  });

  test("a single store entry over 16 MiB is final", async () => {
    index.stop();
    const huge = `${ROOT}"stores":[{"x":"${"y".repeat(17 * 1024 * 1024)}"}]}`;
    index = startIndexServer(new Map([["nm000118", served(encode(huge))]]));
    const result = await read("nm000118");
    expect(result.kind === "unavailable" && result.reason).toMatch(/larger than 16777216 bytes/);
    expect(index.requests).toHaveLength(1);
  });

  test("a truncated copy of a real index that still parses is refused by its own count", async () => {
    // A real index cut after four stores and closed properly: it parses, but its
    // store_count still says nine.
    const cut = fixtureObject("nm000118") as { stores: unknown[] };
    cut.stores = cut.stores.slice(0, 4);
    index.stop();
    index = startIndexServer(new Map([["nm000118", served(cut)]]));
    const result = await read("nm000118");
    expect(result).toEqual({
      kind: "unavailable",
      reason: "unusable index: the index declares 9 stores but lists 4; it may be truncated",
    });
    expect(index.requests).toHaveLength(1);
  });

  test("an index of another format version is final", async () => {
    const other = fixtureObject("nm000118");
    other.format_version = 4;
    index.stop();
    index = startIndexServer(new Map([["nm000118", served(other)]]));
    const result = await read("nm000118");
    expect(result.kind === "unavailable" && result.reason).toContain(
      "unsupported index format_version 4",
    );
    expect(index.requests).toHaveLength(1);
  });
});

describe("a catalog that cannot be trusted to be complete", () => {
  const ids = (count: number): CatalogRow[] =>
    Array.from({ length: count }, (_, i) => ({ dataset_id: `nm${String(i).padStart(6, "0")}` }));
  const options = { retryDelayMs: 0, attempts: 3, pageSize: 200 };
  let catalog: ReturnType<typeof startCatalogServer>;
  afterEach(() => catalog.stop());

  test("page one served and page two failing for good rejects", async () => {
    catalog = startCatalogServer(ids(450));
    catalog.state.failPages.set(200, [500, 500, 500]);
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow(CollectionError);
    expect(catalog.seen.map((r) => r.url)).toEqual([
      "/datasets?limit=200&offset=0",
      "/datasets?limit=200&offset=200",
      "/datasets?limit=200&offset=200",
      "/datasets?limit=200&offset=200",
    ]);
  });

  test("page two failing once and then answering is read in full", async () => {
    catalog = startCatalogServer(ids(450));
    catalog.state.failPages.set(200, [503]);
    expect(await listPublicDatasets(catalog.url, options)).toHaveLength(450);
  });

  test("a total_count shorter than the real catalog rejects (the COUNT query failed upstream)", async () => {
    catalog = startCatalogServer(ids(450));
    catalog.state.totalCount = 200; // one page's length, as nemar-cli reports when its COUNT fails
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow(
      "lists 450 datasets but reports a total of 200",
    );
    // It was read twice, to rule out a dataset added between pages.
    expect(catalog.seen.filter((r) => r.url.endsWith("offset=0"))).toHaveLength(2);
  });

  test("a total_count longer than the real catalog rejects", async () => {
    catalog = startCatalogServer(ids(450));
    catalog.state.totalCount = 500;
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow(
      "reports a total of 500",
    );
  });

  test("a degraded fallback response, or any warning, is refused", async () => {
    catalog = startCatalogServer(ids(5));
    catalog.state.extra = {
      fallback: true,
      warning: "Catalog not available; filters not included",
    };
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow("degraded mode");
    catalog.state.extra = { warning: "something is off" };
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow("degraded mode");
    catalog.state.extra = {};
    expect(await listPublicDatasets(catalog.url, options)).toHaveLength(5);
  });

  test("a catalog that never ends is not read forever and is not silently cut", async () => {
    let served = 0;
    const endless = Bun.serve({
      port: 0,
      fetch: () => {
        served += 1;
        return Response.json({
          datasets: [
            {
              dataset_id: `nm${String(served).padStart(6, "0")}`,
              status: "active",
              visibility: "public",
            },
          ],
          total_count: 10_000,
        });
      },
    });
    try {
      await expect(
        listPublicDatasets(endless.url.href, { ...options, pageSize: 1, maxPages: 5 }),
      ).rejects.toThrow("did not end within 5 pages");
      expect(served).toBe(5);
    } finally {
      endless.stop(true);
    }
  });

  test("a body that is not JSON is said to be that, not a failed request", async () => {
    catalog = startCatalogServer(ids(5));
    catalog.state.rawBody = "<html>maintenance</html>";
    await expect(listPublicDatasets(catalog.url, { ...options, attempts: 2 })).rejects.toThrow(
      "the response was not valid JSON",
    );
  });

  test("an error status other than 408, 429 and 5xx is final at once", async () => {
    catalog = startCatalogServer(ids(5));
    catalog.state.failWith = 403;
    await expect(listPublicDatasets(catalog.url, options)).rejects.toThrow("HTTP 403");
    expect(catalog.seen).toHaveLength(1);
  });

  test("a locked database for several tries is waited out", async () => {
    catalog = startCatalogServer(ids(5));
    catalog.state.failPages.set(0, [500, 500, 500, 500, 500, 500]);
    const datasets = await listPublicDatasets(catalog.url, {
      attempts: 10,
      retryDelayMs: 1,
      maxDelayMs: 4,
    });
    expect(datasets).toHaveLength(5);
  });

  test("the default schedule waits out about five minutes with capped pauses", () => {
    const pauses = retryPauses(10, 2_000, 60_000);
    expect(pauses).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60].map((s) => s * 1000));
    const total = pauses.reduce((n, p) => n + p, 0);
    expect(total).toBeGreaterThanOrEqual(280_000);
    expect(total).toBeLessThanOrEqual(320_000);
    expect(retryPauses(1, 2_000, 60_000)).toEqual([]);
  });

  test("a catalog far smaller than the cache is refused, a modest change is not", () => {
    const datasets = (n: number) =>
      ids(n).map((r) => ({ id: r.dataset_id, valid: true, expectIndex: true }));
    expect(() => assertCatalogPlausible(datasets(100), 766)).toThrow("holds 766");
    expect(() => assertCatalogPlausible(datasets(382), 766)).toThrow(CollectionError);
    expect(() => assertCatalogPlausible(datasets(383), 766)).not.toThrow();
    expect(() => assertCatalogPlausible(datasets(800), 766)).not.toThrow();
    expect(() => assertCatalogPlausible(datasets(2), 9)).not.toThrow(); // too few cached to judge
    expect(() => assertCatalogPlausible(datasets(2), 0)).not.toThrow(); // a first run
  });
});

describe("the summary cache under change", () => {
  const summaryOf = (bins: number): DatasetSummary => ({
    modalities: [
      {
        modality: "EEG",
        bins: Array.from({ length: bins }, (_, i) => ({
          channels: i + 1,
          seconds: 3600,
          recordings: 1,
        })),
      },
    ],
    stores: bins,
    excluded: 0,
    measuredStores: bins,
    storeSeconds: 3600 * bins,
    unmeasuredStores: 0,
    unmeasured: 0,
    implausible: 0,
    failed: 0,
    pending: 0,
    multiGroupStores: 0,
    multiModalityStores: 0,
  });

  test("an entry written under the previous summary version is ignored and rebuilt", async () => {
    const cache = await SummaryCache.open(cacheDir);
    await cache.write("nm000118", '"etag"', summaryOf(2));
    const path = join(cacheDir, "nm000118.json");
    const entry = JSON.parse(await Bun.file(path).text());
    expect(entry.v).toBe(SUMMARY_VERSION);
    await writeFile(path, JSON.stringify({ ...entry, v: SUMMARY_VERSION - 1 }));
    expect(await cache.read("nm000118")).toBeNull();
    // A read therefore sends no If-None-Match, downloads, and replaces the entry.
    const result = await read("nm000118");
    expect(result).toMatchObject({ kind: "summary", from: "network" });
    expect(index.requests[0].ifNoneMatch).toBeNull();
    expect((await cache.read("nm000118"))?.summary).toEqual(
      summarizeIndex(fixtureObject("nm000118"), "nm000118"),
    );
  });

  test("a reader never sees a torn or missing entry while a large one is rewritten", async () => {
    const cache = await SummaryCache.open(cacheDir);
    const big = summaryOf(1_000); // about 60 KB per entry
    await cache.write("nm000118", '"e0"', big);
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 300; i += 1) await cache.write("nm000118", `"e${i % 3}"`, big);
      writing = false;
    })();
    const seen = new Set<string>();
    let reads = 0;
    const reader = (async () => {
      while (writing) {
        const entry = await cache.read("nm000118");
        reads += 1;
        // null would mean a torn or half-renamed file was read
        expect(entry).not.toBeNull();
        expect(entry?.summary.modalities[0].bins).toHaveLength(1_000);
        seen.add(entry?.etag ?? "");
      }
    })();
    await Promise.all([writer, reader]);
    expect(reads).toBeGreaterThan(20);
    expect([...seen].every((etag) => ['"e0"', '"e1"', '"e2"'].includes(etag))).toBe(true);
    expect((await readdir(cacheDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("count sees entry files only", async () => {
    const cache = await SummaryCache.open(cacheDir);
    expect(await cache.count()).toBe(0);
    await cache.write("nm000118", '"a"', summaryOf(1));
    await cache.write("on004457", '"b"', summaryOf(1));
    await writeFile(join(cacheDir, "notes.txt"), "x");
    await writeFile(join(cacheDir, ".nm000118.1.aaaa.tmp"), "x");
    expect(await cache.count()).toBe(2);
    expect(await (await SummaryCache.open(null)).count()).toBe(0);
  });
});
