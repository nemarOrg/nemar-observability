// The input side of the Zarr recordings collector: which datasets are public
// (the anonymous NEMAR catalog), how each dataset's Zarr index is read (a
// conditional GET, streamed so even a 300 MB index stays small in memory), and a
// per-dataset summary cache keyed by the index's ETag. Dependency-free, so it
// runs from a bare checkout without `bun install`.
//
// Cache semantics, deliberately strict: a cached summary is reused only when the
// ETag check itself succeeded and matched (HTTP 304, or a 200 whose ETag equals
// the cached one). If the check fails for any reason the dataset is reported
// unavailable for this run; a stale summary is never passed off as fresh. The
// cache is only an optimization: deleting it, or any file in it, costs one
// re-download and changes no result.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pid } from "node:process";
import { JsonShapeError } from "./json-stream";
import { fail } from "./s3-cloudwatch";
import type { DatasetOutcome } from "./zarr-aggregate";
import {
  type DatasetSummary,
  IndexFormatError,
  SUMMARY_VERSION,
  parseDatasetSummary,
  summarizeIndexStream,
} from "./zarr-recordings";

export const DEFAULT_API_BASE = "https://api.nemar.org";
export const DEFAULT_INDEX_BASE = "https://nemar.s3.us-east-2.amazonaws.com";
/** Cloudflare bot filtering 403s generic runtime agents; identify honestly. */
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
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getCatalogPage(
  url: string,
  attempts: number,
  retryDelayMs: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let reason = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(retryDelayMs * (attempt - 1));
    try {
      // Anonymous on purpose: no credential is ever sent to the catalog, so the
      // answer is exactly what any visitor sees (public, active datasets only).
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        reason = `HTTP ${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
      reason = "the response is not a JSON object";
    } catch {
      reason = "the request failed or timed out";
    }
  }
  return fail(`the public dataset catalog could not be read (${reason}); no section was published`);
}

/**
 * Every public dataset, from the anonymous catalog `GET /datasets`. That
 * endpoint lists only status "active" and visibility "public" datasets to an
 * anonymous caller, hides sandbox datasets, and pages with `limit` (at most
 * 200) and `offset`, reporting `total_count`. Rows are filtered again here
 * (public, active, managed) so that a change in the endpoint can never put a
 * private dataset into the totals. A catalog that cannot be read in full fails
 * the run: a partial list would publish a plausible but wrong total.
 */
export async function listPublicDatasets(
  apiBase: string,
  options: CatalogOptions = {},
): Promise<PublicDataset[]> {
  const pageSize = options.pageSize ?? 200;
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = apiBase.replace(/\/$/, "");
  const byId = new Map<string, PublicDataset>();
  let consumed = 0;
  for (let page = 0; page < 1_000; page += 1) {
    const body = await getCatalogPage(
      `${base}/datasets?limit=${pageSize}&offset=${consumed}`,
      attempts,
      retryDelayMs,
      timeoutMs,
    );
    const rows = body.datasets;
    const total = body.total_count;
    if (!Array.isArray(rows) || typeof total !== "number") {
      fail("the public dataset catalog returned an unexpected shape; no section was published");
    }
    for (const row of rows) {
      const record =
        typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
      if (record.visibility !== "public" || record.status !== "active") continue;
      if (record.source_type !== undefined && record.source_type !== "managed") continue;
      const id = typeof record.dataset_id === "string" ? record.dataset_id : "(unnamed)";
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        valid: isDatasetId(id),
        expectIndex: record.zarr_status === "ready",
      });
    }
    consumed += rows.length;
    if (consumed >= total) break;
    if (rows.length === 0) {
      fail(
        `the public dataset catalog ended after ${consumed} of ${total} datasets; no section was published`,
      );
    }
  }
  if (byId.size === 0) {
    fail("the public dataset catalog reported no public datasets; refusing to publish zero");
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export type CacheEntry = {
  v: number;
  dataset_id: string;
  etag: string;
  cached_at: string;
  summary: DatasetSummary;
};

const STALE_TEMP_MS = 60 * 60 * 1000;
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

  async remove(id: string): Promise<void> {
    const path = this.pathFor(id);
    if (path !== null) await rm(path, { force: true }).catch(() => undefined);
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
};

type Attempt =
  | { kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "retry"; reason: string };

export type IndexRead =
  | { kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

async function attemptRead(
  id: string,
  cached: CacheEntry | null,
  options: ReadOptions,
): Promise<Attempt> {
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const controller = new AbortController();
  let timer: number | null = null;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (cached) headers["if-none-match"] = cached.etag;
  const discard = (response: Response) => response.body?.cancel().catch(() => undefined);

  arm(headerTimeoutMs);
  try {
    const url = `${options.indexBase.replace(/\/$/, "")}/${id}/zarr/index.json`;
    const response = await fetch(url, { headers, signal: controller.signal });
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
      await options.cache.remove(id);
      return { kind: "absent" };
    }
    if (response.status !== 200 || response.body === null) {
      await discard(response);
      return { kind: "retry", reason: `HTTP ${response.status}` };
    }

    const etag = response.headers.get("etag");
    if (cached && etag !== null && etag === cached.etag) {
      await discard(response); // the server ignored If-None-Match, but the ETag matches
      return { kind: "summary", summary: cached.summary, from: "cache" };
    }
    const summary = await summarizeIndexStream(response.body, id, () => arm(idleTimeoutMs));
    if (etag !== null && etag.length > 0) await options.cache.write(id, etag, summary);
    return { kind: "summary", summary, from: "network" };
  } catch (error) {
    if (error instanceof IndexFormatError) {
      return { kind: "unavailable", reason: `unusable index: ${error.message}` };
    }
    if (error instanceof JsonShapeError && !error.truncated) {
      return { kind: "unavailable", reason: `malformed index: ${error.message}` };
    }
    return {
      kind: "retry",
      reason: controller.signal.aborted
        ? "timed out"
        : error instanceof JsonShapeError
          ? "the download ended early"
          : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one dataset's Zarr index. Returns its summary (from the cache when the
 * ETag still matches), "absent" when the key has no object, or "unavailable"
 * with a reason. Transient failures (HTTP errors, timeouts, dropped
 * connections, a download that ends early) are retried; a document that is
 * complete but not a usable index is not, since asking again cannot fix it.
 */
export async function readDatasetIndex(id: string, options: ReadOptions): Promise<IndexRead> {
  const cached = await options.cache.read(id);
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let reason = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
    const result = await attemptRead(id, cached, options);
    if (result.kind !== "retry") return result;
    reason = result.reason;
  }
  return { kind: "unavailable", reason };
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
  concurrency?: number;
  /** Called once per dataset that could not be read, for the journal. */
  onUnavailable?: (id: string, reason: string) => void;
};

/**
 * Read the index of every public dataset. A dataset the catalog marks "ready"
 * whose index is missing is unavailable (its Zarr copy should exist); any other
 * dataset without an index simply has no Zarr copy yet and is not scanned.
 */
export async function scanDatasets(
  datasets: PublicDataset[],
  options: ScanOptions,
): Promise<DatasetOutcome[]> {
  return mapPool(datasets, options.concurrency ?? 6, async (dataset): Promise<DatasetOutcome> => {
    const { id } = dataset;
    const unavailable = (reason: string): DatasetOutcome => {
      options.onUnavailable?.(id, reason);
      return { id, kind: "unavailable", reason };
    };
    if (!dataset.valid) return unavailable("the catalog gave an unusable dataset id");
    const read = await readDatasetIndex(id, options);
    if (read.kind === "unavailable") return unavailable(read.reason);
    if (read.kind === "absent") {
      return dataset.expectIndex
        ? unavailable("the Zarr index is missing for a dataset marked ready")
        : { id, kind: "absent" };
    }
    return { id, kind: "summary", summary: read.summary, from: read.from };
  });
}
