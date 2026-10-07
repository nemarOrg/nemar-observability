// The input side of the Zarr recordings collector: which datasets are public
// (the anonymous NEMAR catalog), how each dataset's Zarr index is read (a
// conditional GET, streamed so even a 300 MB index never sits in memory), and a
// per-dataset summary cache keyed by the index's ETag. Dependency-free, so it
// runs from a bare checkout without `bun install`.
//
// Cache semantics, deliberately strict: a cached summary is reused only when the
// ETag check itself succeeded and matched (HTTP 304, or a 200 whose ETag equals
// the cached one). If the check fails for any reason the dataset is reported
// unavailable for this run; a stale summary is never passed off as fresh. The
// cache is only an optimization: deleting it, or any file in it, costs one
// re-download and changes no result. What it remembers is also used as a
// reference: an index that was readable on an earlier run and is missing or
// unreadable now is a regression, and its last known hours say how much the
// run is missing.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pid } from "node:process";
import { JsonShapeError, StreamReadError } from "./json-stream";
import { fail } from "./s3-cloudwatch";
import type { DatasetOutcome } from "./zarr-aggregate";
import {
  type DatasetSummary,
  IndexFormatError,
  MAX_DURATION_HOURS,
  SUMMARY_VERSION,
  parseDatasetSummary,
  summarizeIndexStream,
} from "./zarr-recordings";

export const DEFAULT_API_BASE = "https://api.nemar.org";
export const DEFAULT_INDEX_BASE = "https://nemar.s3.us-east-2.amazonaws.com";
/** Identify the collector honestly, as the other NEMAR monitors do. */
export const USER_AGENT =
  "nemar-observability-recordings/1 (+https://github.com/nemarOrg/nemar-observability)";

/** The ids the catalog gives are used in URLs and file names, so they must be plain. */
export function isDatasetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{2}[0-9]{6}$/.test(value);
}

export type PublicDataset = {
  id: string;
  /** False when the catalog gave an id that is not safe to use in a URL or file name. */
  valid: boolean;
  /** The catalog says the Zarr conversion is complete, so a missing index is a fault. */
  expectIndex: boolean;
};

export type CatalogOptions = {
  pageSize?: number;
  /** Tries per page; default 10, which with the pauses below waits out about 5 minutes. */
  attempts?: number;
  /** First pause between tries, doubled each time up to `maxDelayMs`; default 2 s. */
  retryDelayMs?: number;
  /** Longest pause between tries; default 60 s. */
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Pages after which paging is declared endless; default 1000. */
  maxPages?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The pauses before tries 2, 3, and so on: the base, doubling, capped. With the
 * catalog's defaults (10 tries, 2 s, capped at 60 s) they are 2, 4, 8, 16, 32,
 * then 60 s four times: about five minutes, the longest the hourly `nemar-db`
 * export is expected to hold the catalog's database locked.
 */
export function retryPauses(attempts: number, baseMs: number, maxMs: number): number[] {
  return Array.from({ length: Math.max(0, attempts - 1) }, (_, i) =>
    Math.min(baseMs * 2 ** i, maxMs),
  );
}

/** Statuses worth asking again about: the server's trouble, not ours. */
const isTransientStatus = (status: number) => status >= 500 || status === 429 || status === 408;

/**
 * One catalog page. The catalog reads `nemar-db`, which is locked by an hourly
 * export for part of each hour (AGENTS.md) and then answers 5xx, so a failing
 * page is retried with capped backoff for about five minutes. A 4xx other than
 * 408 and 429 is permanent and fails at once.
 */
async function getCatalogPage(
  url: string,
  options: Required<Pick<CatalogOptions, "attempts" | "retryDelayMs" | "maxDelayMs" | "timeoutMs">>,
): Promise<Record<string, unknown>> {
  let reason = "unknown error";
  const pauses = retryPauses(options.attempts, options.retryDelayMs, options.maxDelayMs);
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (attempt > 1) await sleep(pauses[attempt - 2]);
    let response: Response;
    try {
      // Anonymous on purpose: no credential is ever sent to the catalog, so the
      // answer is exactly what any visitor sees (public, active datasets only).
      response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      reason = "the request failed or timed out";
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      reason = `HTTP ${response.status}`;
      if (isTransientStatus(response.status)) continue;
      break;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      reason = "the response was not valid JSON";
      continue;
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    reason = "the response was not a JSON object";
  }
  return fail(`the public dataset catalog could not be read (${reason}); no section was published`);
}

async function listOnce(base: string, options: CatalogOptions): Promise<PublicDataset[]> {
  const pageSize = options.pageSize ?? 200;
  const maxPages = options.maxPages ?? 1_000;
  const page = {
    attempts: options.attempts ?? 10,
    retryDelayMs: options.retryDelayMs ?? 2_000,
    maxDelayMs: options.maxDelayMs ?? 60_000,
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  const byId = new Map<string, PublicDataset>();
  /** Every id the catalog listed, kept or not: total_count counts all of them. */
  const listed = new Set<string>();
  let offset = 0;
  let lastTotal = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const body = await getCatalogPage(`${base}/datasets?limit=${pageSize}&offset=${offset}`, page);
    // nemar-cli answers a degraded query with the first page of a reduced
    // projection and `fallback: true`, and sets total_count to that page's length
    // when its COUNT query fails; neither can be told from a complete catalog by
    // the rows alone.
    if (body.fallback || body.warning) {
      fail("the public dataset catalog is in a degraded mode; no section was published");
    }
    const rows = body.datasets;
    const total = body.total_count;
    if (!Array.isArray(rows) || typeof total !== "number") {
      fail("the public dataset catalog returned an unexpected shape; no section was published");
    }
    lastTotal = total;
    for (const row of rows) {
      const record =
        typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
      const id = typeof record.dataset_id === "string" ? record.dataset_id : "(unnamed)";
      listed.add(id);
      if (record.visibility !== "public" || record.status !== "active") continue;
      if (record.source_type !== undefined && record.source_type !== "managed") continue;
      if (byId.has(id)) continue;
      byId.set(id, { id, valid: isDatasetId(id), expectIndex: record.zarr_status === "ready" });
    }
    // Page until an empty page rather than trusting total_count to say where the
    // end is; the total is checked against what was listed afterwards.
    if (rows.length === 0) {
      if (listed.size !== lastTotal) {
        fail(
          `the public dataset catalog lists ${listed.size} datasets but reports a total of ${lastTotal}; no section was published`,
        );
      }
      if (byId.size === 0) {
        fail("the public dataset catalog reported no public datasets; refusing to publish zero");
      }
      return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    offset += rows.length;
  }
  return fail(
    `the public dataset catalog did not end within ${maxPages} pages; no section was published`,
  );
}

/**
 * Every public dataset, from the anonymous catalog `GET /datasets`. That
 * endpoint lists only status "active" and visibility "public" datasets to an
 * anonymous caller and hides sandbox datasets other than flagged exemplars (none
 * exist today); it pages with `limit` (at most 200) and `offset`, reporting
 * `total_count`. Rows are filtered again here (public, active, managed) so that
 * a change in the endpoint can never put a private dataset into the totals.
 *
 * A catalog that cannot be read in full fails the run: a partial list would
 * publish a plausible but wrong total. Paging runs to an empty page, the number
 * of distinct ids listed must equal `total_count` (a catalog whose COUNT failed
 * reports a total as short as one page), and a degraded response (`fallback` or
 * `warning`) is refused. A catalog that disagrees with itself is read once more,
 * since a dataset added between two pages can shift them.
 */
export async function listPublicDatasets(
  apiBase: string,
  options: CatalogOptions = {},
): Promise<PublicDataset[]> {
  const base = apiBase.replace(/\/$/, "");
  try {
    return await listOnce(base, options);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("reports a total of")) throw error;
    return listOnce(base, options);
  }
}

/**
 * A catalog far smaller than the cache directory is a catalog that lost
 * datasets (or a cache from another environment), not a catalog that shrank:
 * refuse it rather than publish totals for a fraction of NEMAR.
 */
export function assertCatalogPlausible(datasets: PublicDataset[], cachedEntries: number): void {
  if (cachedEntries >= 10 && datasets.length < cachedEntries * 0.5) {
    fail(
      `the public dataset catalog lists ${datasets.length} datasets but the cache holds ${cachedEntries}; refusing to publish a section built from a fraction of NEMAR`,
    );
  }
}

export type CacheEntry = {
  v: number;
  dataset_id: string;
  etag: string;
  cached_at: string;
  summary: DatasetSummary;
};

/**
 * A temporary file this old belongs to a run that died: one cache write takes
 * milliseconds and a whole run well under an hour (its service stops after 45
 * minutes), so only a crash leaves one older.
 */
const STALE_TEMP_MS = 60 * 60 * 1000;
/**
 * A summary holds at most 32 modalities of at most 1024 channel counts, a few
 * hundred kilobytes at the very most, and the largest real one is 7 KB. A file
 * bigger than this is not one of ours and is ignored.
 */
const MAX_CACHE_FILE_BYTES = 4 * 1024 * 1024;

/**
 * One small JSON file per dataset, `<dir>/<id>.json`, holding the index's ETag
 * and the summary computed from it.
 *
 * Safe against partial writes and concurrent runs: a file is written under a
 * unique temporary name and renamed into place (atomic on one filesystem), so a
 * reader sees the old file or the new one, never half of either, and two runs
 * writing the same dataset just leave the last complete file. A file that is
 * unreadable, malformed, from another summary version, or for another dataset
 * is treated as a miss. A cache that cannot be opened is simply disabled.
 */
export class SummaryCache {
  private constructor(
    private readonly dir: string | null,
    private readonly warn: (message: string) => void,
  ) {}

  static async open(
    dir: string | null,
    warn: (message: string) => void = (message) => console.warn(message),
  ): Promise<SummaryCache> {
    if (dir === null) return new SummaryCache(null, warn);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const cache = new SummaryCache(dir, warn);
      await cache.sweepTemporaryFiles();
      return cache;
    } catch {
      warn(
        `[zarr-recordings] cache directory ${dir} is not usable; every index will be downloaded in full`,
      );
      return new SummaryCache(null, warn);
    }
  }

  get enabled(): boolean {
    return this.dir !== null;
  }

  private pathFor(id: string): string | null {
    return this.dir !== null && isDatasetId(id) ? join(this.dir, `${id}.json`) : null;
  }

  async read(id: string): Promise<CacheEntry | null> {
    const path = this.pathFor(id);
    if (path === null) return null;
    try {
      if ((await stat(path)).size > MAX_CACHE_FILE_BYTES) return null;
      const entry: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof entry !== "object" || entry === null) return null;
      const { v, dataset_id, etag, cached_at, summary } = entry as Record<string, unknown>;
      if (v !== SUMMARY_VERSION || dataset_id !== id) return null;
      if (typeof etag !== "string" || etag.length === 0) return null;
      const parsed = parseDatasetSummary(summary);
      if (parsed === null) return null;
      return {
        v,
        dataset_id: id,
        etag,
        cached_at: typeof cached_at === "string" ? cached_at : "",
        summary: parsed,
      };
    } catch {
      return null;
    }
  }

  /** Best effort: returns false (after one warning) when the entry could not be stored. */
  async write(id: string, etag: string, summary: DatasetSummary): Promise<boolean> {
    const path = this.pathFor(id);
    if (path === null || this.dir === null) return false;
    const temporary = join(this.dir, `.${id}.${pid}.${randomUUID()}.tmp`);
    const entry: CacheEntry = {
      v: SUMMARY_VERSION,
      dataset_id: id,
      etag,
      cached_at: new Date().toISOString(),
      summary,
    };
    try {
      await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
      await rename(temporary, path);
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      this.warn(`[zarr-recordings] could not store the cache entry for ${id}`);
      return false;
    }
  }

  /** Number of entry files, readable or not; used to sanity-check the catalog against it. */
  async count(): Promise<number> {
    if (this.dir === null) return 0;
    try {
      return (await readdir(this.dir)).filter((name) => name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** Delete entries for datasets that are no longer public. */
  async prune(keep: Set<string>): Promise<number> {
    if (this.dir === null) return 0;
    let removed = 0;
    try {
      for (const name of await readdir(this.dir)) {
        if (!name.endsWith(".json") || keep.has(name.slice(0, -".json".length))) continue;
        await rm(join(this.dir, name), { force: true });
        removed += 1;
      }
    } catch {
      // pruning is housekeeping only
    }
    return removed;
  }

  /** Remove temporary files an interrupted run left behind (never a live run's, which is minutes old at most). */
  private async sweepTemporaryFiles(): Promise<void> {
    if (this.dir === null) return;
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".tmp")) continue;
      const path = join(this.dir, name);
      try {
        if (Date.now() - (await stat(path)).mtimeMs > STALE_TEMP_MS)
          await rm(path, { force: true });
      } catch {
        // another run removed it first
      }
    }
  }
}

export type ReadOptions = {
  indexBase: string;
  cache: SummaryCache;
  /** Tries per dataset for a transient failure; default 3. */
  attempts?: number;
  /** Pause before the second try, doubled before each later one; default 2 s. */
  retryDelayMs?: number;
  /** Time to receive response headers; default 30 s. */
  headerTimeoutMs?: number;
  /** Longest silence while the body streams; default 60 s. */
  idleTimeoutMs?: number;
  /**
   * Longest one try may take in total, however steadily bytes trickle in (the
   * idle timer alone re-arms on every chunk); default 15 minutes, which is 308 MB
   * at about 350 KB/s. Hitting it is final for the run, not retried.
   */
  deadlineMs?: number;
  /** Most bytes one try may download; default 1 GiB, over three times the largest real index. */
  maxBytes?: number;
};

export type Attempt =
  | { kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "retry"; reason: string };

export type IndexRead =
  | { kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  | { kind: "absent" }
  /** `lastKnownSeconds`: what the cache held for this dataset before this run, if anything. */
  | { kind: "unavailable"; reason: string; lastKnownSeconds?: number };

/** A try that broke its own time or size limit; asking again would only repeat it. */
class ReadLimitError extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * What a failed try means. Only the network's own failures are retried (a failed
 * fetch, a timeout abort, a stream that broke, a download that ended early):
 * asking again can fix those. A limit this try broke, a document that is not a
 * usable index, and anything else (a bug in this code, or data it did not
 * expect) would only repeat, and a repeat re-downloads up to 300 MB, so those
 * are final for the run. The last kind is returned as `bug` so the caller logs
 * its name, message and stack.
 */
export function classifyFailure(
  error: unknown,
  context: { limit: string | null; aborted: boolean; stage: "fetch" | "body" },
): { attempt: Attempt; bug?: unknown } {
  if (context.limit !== null) return { attempt: { kind: "unavailable", reason: context.limit } };
  if (error instanceof IndexFormatError) {
    return { attempt: { kind: "unavailable", reason: `unusable index: ${error.message}` } };
  }
  if (error instanceof JsonShapeError) {
    return {
      attempt: error.truncated
        ? { kind: "retry", reason: "the download ended early" }
        : { kind: "unavailable", reason: `malformed index: ${error.message}` },
    };
  }
  if (context.aborted) return { attempt: { kind: "retry", reason: "timed out" } };
  if (context.stage === "fetch" || error instanceof StreamReadError) {
    return { attempt: { kind: "retry", reason: "network error" } };
  }
  return {
    attempt: {
      kind: "unavailable",
      reason: `unexpected ${error instanceof Error ? error.name : "error"} while reading the index`,
    },
    bug: error,
  };
}

async function attemptRead(
  id: string,
  cached: CacheEntry | null,
  options: ReadOptions,
): Promise<Attempt> {
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const deadlineMs = options.deadlineMs ?? 15 * 60_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024;
  const controller = new AbortController();
  let limit: string | null = null;
  let timer: number | null = null;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  const stop = (reason: string) => {
    limit = reason;
    controller.abort();
  };
  const deadline = setTimeout(
    () => stop(`the index took longer than ${Math.round(deadlineMs / 1000)} s to read`),
    deadlineMs,
  );
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (cached) headers["if-none-match"] = cached.etag;
  const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

  let stage: "fetch" | "body" = "fetch";
  arm(headerTimeoutMs);
  try {
    const url = `${options.indexBase.replace(/\/$/, "")}/${id}/zarr/index.json`;
    const response = await fetch(url, { headers, signal: controller.signal });
    stage = "body";
    arm(idleTimeoutMs);

    if (response.status === 304) {
      await discard(response);
      return cached
        ? { kind: "summary", summary: cached.summary, from: "cache" }
        : { kind: "unavailable", reason: "the server answered 304 to an unconditional request" };
    }
    // S3 answers 403, not 404, for a key that does not exist in a bucket whose
    // listing is not public, so both mean "no readable index at this key".
    if (response.status === 404 || response.status === 403) {
      await discard(response);
      // An index that was readable before is a regression, not "no Zarr copy".
      return cached
        ? {
            kind: "unavailable",
            reason: "the index was readable on an earlier run and is missing now",
          }
        : { kind: "absent" };
    }
    if (response.status !== 200 || response.body === null) {
      await discard(response);
      return isTransientStatus(response.status)
        ? { kind: "retry", reason: `HTTP ${response.status}` }
        : { kind: "unavailable", reason: `HTTP ${response.status}` };
    }

    const etag = response.headers.get("etag");
    if (cached && etag !== null && etag === cached.etag) {
      await discard(response); // the server ignored If-None-Match, but the ETag matches
      return { kind: "summary", summary: cached.summary, from: "cache" };
    }
    let received = 0;
    const summary = await summarizeIndexStream(response.body, id, (bytes) => {
      received += bytes;
      if (received > maxBytes) {
        stop(`the index is larger than ${maxBytes} bytes`);
        throw new ReadLimitError("byte cap");
      }
      arm(idleTimeoutMs);
    });
    if (etag !== null && etag.length > 0) await options.cache.write(id, etag, summary);
    return { kind: "summary", summary, from: "network" };
  } catch (error) {
    const verdict = classifyFailure(error, {
      limit,
      aborted: controller.signal.aborted,
      stage,
    });
    if (verdict.bug !== undefined) {
      console.error(`[zarr-recordings] ${id}: unexpected ${describe(verdict.bug)}`);
      if (verdict.bug instanceof Error && verdict.bug.stack) console.error(verdict.bug.stack);
    }
    return verdict.attempt;
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
  }
}

/**
 * Read one dataset's Zarr index. Returns its summary (from the cache when the
 * ETag still matches), "absent" when the key has no object and none was cached,
 * or "unavailable" with a reason. Transient failures (5xx, 429, timeouts,
 * dropped connections, a download that ends early) are retried; a document that
 * is complete but not a usable index, a client error, a broken limit, and a bug
 * are not, since asking again cannot fix them.
 */
export async function readDatasetIndex(id: string, options: ReadOptions): Promise<IndexRead> {
  const cached = await options.cache.read(id);
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let reason = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
    const result = await attemptRead(id, cached, options);
    if (result.kind === "unavailable") {
      return cached ? { ...result, lastKnownSeconds: cached.summary.storeSeconds } : result;
    }
    if (result.kind !== "retry") return result;
    reason = result.reason;
  }
  return cached
    ? { kind: "unavailable", reason, lastKnownSeconds: cached.summary.storeSeconds }
    : { kind: "unavailable", reason };
}

/** Map `items` through `fn` with at most `concurrency` calls in flight, keeping order. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}

export type ScanOptions = ReadOptions & {
  /** Indexes read at once; default 4 (each may buffer one store entry of up to 16 MiB). */
  concurrency?: number;
  /** Called once per dataset that could not be read, for the journal. */
  onUnavailable?: (id: string, reason: string) => void;
  /** Called for a note worth the journal that is not a failure (a corrupt value skipped). */
  onNote?: (id: string, message: string) => void;
};

/**
 * Read the index of every public dataset. A dataset the catalog marks "ready"
 * whose index is missing is unavailable (its Zarr copy should exist), and so is
 * one whose index was readable on an earlier run; any other dataset without an
 * index simply has no Zarr copy yet and is not scanned.
 */
export async function scanDatasets(
  datasets: PublicDataset[],
  options: ScanOptions,
): Promise<DatasetOutcome[]> {
  return mapPool(datasets, options.concurrency ?? 4, async (dataset): Promise<DatasetOutcome> => {
    const { id } = dataset;
    const unavailable = (reason: string, lastKnownSeconds?: number): DatasetOutcome => {
      options.onUnavailable?.(id, reason);
      return lastKnownSeconds === undefined
        ? { id, kind: "unavailable", reason }
        : { id, kind: "unavailable", reason, lastKnownSeconds };
    };
    if (!dataset.valid) return unavailable("the catalog gave an unusable dataset id");
    const read = await readDatasetIndex(id, options);
    if (read.kind === "unavailable") return unavailable(read.reason, read.lastKnownSeconds);
    if (read.kind === "absent") {
      return dataset.expectIndex
        ? unavailable("the Zarr index is missing for a dataset marked ready")
        : { id, kind: "absent" };
    }
    if (read.from === "network" && read.summary.implausible > 0) {
      options.onNote?.(
        id,
        `${read.summary.implausible} recordings with a duration over ${MAX_DURATION_HOURS} hours were treated as unmeasured`,
      );
    }
    return { id, kind: "summary", summary: read.summary, from: read.from };
  });
}
