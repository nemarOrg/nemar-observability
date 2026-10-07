// The per-dataset half of the Zarr recordings collector (push-zarr-recordings.ts):
// turn the `nemar-zarr-index` document of one public dataset into a small
// summary, either from a parsed object or from a byte stream. zarr-aggregate.ts
// combines the summaries into the section payload; zarr-index-source.ts owns the
// network and the cache. No network and no filesystem here. Dependency-free at
// runtime, so the collector runs from a bare checkout without `bun install`.

import { JsonShapeError, scanRootObject } from "./json-stream";

/** Bump when the summary rules below change, so cached summaries are rebuilt. */
export const SUMMARY_VERSION = 1;

const INDEX_FORMAT = "nemar-zarr-index";

/** The contract's bounds (src/lib/schema.ts ChannelHoursSchema). */
export const MAX_CHANNELS = 100_000;
const MODALITY_MAX_LENGTH = 32;

/** The index is readable JSON but not a usable `nemar-zarr-index` for this dataset. */
export class IndexFormatError extends Error {}

export type BinSummary = { channels: number; seconds: number; recordings: number };
export type ModalitySummary = { modality: string; bins: BinSummary[] };

/**
 * What one dataset's index contributes. A "recording" here is a (store,
 * modality) pair: a store is one converted recording, and the real catalog has
 * exactly one group, hence one modality, per store.
 */
export type DatasetSummary = {
  /** Measured recordings by modality and exact channel count, bins ascending by channels. */
  modalities: ModalitySummary[];
  /** Every entry of `stores[]`, raw or not. */
  stores: number;
  /** Stores skipped because they are derived or from a non-raw source tree. */
  excluded: number;
  /** Raw stores measured in at least one modality; each counts once, whatever its modalities. */
  measuredStores: number;
  /** Total seconds of those stores, each taken as its longest measured modality (nemar-cli's rule). */
  storeSeconds: number;
  /** Raw stores with no measured modality at all. */
  unmeasuredStores: number;
  /** (store, modality) recordings that converted but lack a usable duration or channel count. */
  unmeasured: number;
  /** Recordings listed in `failures[]`. */
  failed: number;
  /** Recordings listed in `pending[]`. */
  pending: number;
  /** Stores with more than one group (only a diagnostic; the rules below handle them). */
  multiGroupStores: number;
  /** Stores whose groups span more than one modality. */
  multiModalityStores: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The display key of a group's modality, or null when it cannot be one.
 * "IEEG" is shown as "iEEG" (any case of "ieeg" maps there); every other value
 * is kept as given, trimmed. Values that are empty, over 32 characters, or hold
 * control characters are not modality names and cannot be attributed.
 */
export function normalizeModality(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MODALITY_MAX_LENGTH) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value.toLowerCase() === "ieeg" ? "iEEG" : value;
}

/**
 * BIDS datatype folders a "MISC" group may be relabeled with. The converter
 * names a group "MISC" when the file's channels have no modality of their own
 * (an ECG recording in an `ecg/` folder), so the folder is the better label.
 * Only signal datatypes qualify: a MISC group in an unrecognized folder (such
 * as `mov/`) stays "MISC", and so does one in a folder like `func/`.
 */
const MISC_DATATYPE_FOLDERS = new Set([
  "ecg",
  "eeg",
  "emg",
  "eog",
  "ieeg",
  "meg",
  "nirs",
  "motion",
]);

/**
 * The modality a group is attributed to: its own normalized `modality`, except
 * that "MISC" is replaced by the uppercased BIDS datatype folder of the store's
 * `path` (the directory just before the file name) when that folder is a
 * recognized datatype.
 */
export function groupModality(group: Record<string, unknown>, path: unknown): string | null {
  const modality = normalizeModality(group.modality);
  if (modality === null || modality.toLowerCase() !== "misc") return modality;
  if (typeof path !== "string") return modality;
  const segments = path.split("/");
  const folder = segments.length >= 2 ? segments[segments.length - 2].toLowerCase() : "";
  if (!MISC_DATATYPE_FOLDERS.has(folder)) return modality;
  return normalizeModality(folder.toUpperCase()) ?? modality;
}

/** A recording counts as raw when it is not derived and comes from the raw tree. */
function isRawStore(store: Record<string, unknown>): boolean {
  const derived = store.derived;
  if (derived !== undefined && derived !== null && derived !== false) return false;
  const tree = store.source_tree;
  return tree === undefined || tree === null || tree === "raw";
}

/** `duration_s`: a finite, non-negative number of seconds, or null (never clamped). */
function validDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `n_channels`: a whole number the contract can bin, or null. */
function validChannels(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHANNELS
    ? value
    : null;
}

function declaredCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const maxOf = (current: number | null, next: number | null): number | null =>
  next === null ? current : current === null ? next : Math.max(current, next);

/**
 * Accumulates one dataset's summary store by store, in any order.
 *
 * The rules, per store:
 *  - Derived stores, and stores from a source tree other than "raw", are not
 *    raw recordings and are counted in `excluded` only.
 *  - Each group is attributed to its own modality (see `groupModality`). Groups of one store are
 *    concurrent streams of a single recording (nemar-cli `aggregateRecordingStats`
 *    takes the MAX duration across them, never the sum), so within one store and
 *    one modality the duration is the longest group's and the channel count is
 *    the largest group's, and the store is counted once for that modality. A
 *    store with several modalities is counted once in each, and once overall:
 *    `measuredStores` and `storeSeconds` take the store's longest measured
 *    modality, so the dataset total compares with nemar-db's, which never
 *    counts a store twice.
 *  - A (store, modality) with no usable duration or no usable channel count is
 *    unmeasured: it is counted in `unmeasured` and left out of every bin.
 *    Unknown is never zero. A store with no group that names a modality is one
 *    unmeasured recording; a group with no modality is ignored when another
 *    group of the same store names one.
 */
export class DatasetAccumulator {
  private readonly bins = new Map<string, Map<number, { seconds: number; recordings: number }>>();
  private stores = 0;
  private excluded = 0;
  private measuredStores = 0;
  private storeSeconds = 0;
  private unmeasuredStores = 0;
  private unmeasured = 0;
  private multiGroupStores = 0;
  private multiModalityStores = 0;

  add(raw: unknown): void {
    this.stores += 1;
    if (!isObject(raw)) {
      this.unmeasured += 1;
      this.unmeasuredStores += 1;
      return;
    }
    if (!isRawStore(raw)) {
      this.excluded += 1;
      return;
    }
    const groups = Array.isArray(raw.groups) ? raw.groups : [];
    if (groups.length > 1) this.multiGroupStores += 1;

    const perModality = new Map<string, { seconds: number | null; channels: number | null }>();
    for (const group of groups) {
      if (!isObject(group)) continue;
      const modality = groupModality(group, raw.path);
      if (modality === null) continue;
      const entry = perModality.get(modality) ?? { seconds: null, channels: null };
      entry.seconds = maxOf(entry.seconds, validDuration(group.duration_s));
      entry.channels = maxOf(entry.channels, validChannels(group.n_channels));
      perModality.set(modality, entry);
    }
    if (perModality.size > 1) this.multiModalityStores += 1;
    if (perModality.size === 0) {
      this.unmeasured += 1;
      this.unmeasuredStores += 1;
      return;
    }
    let storeSeconds: number | null = null;
    for (const [modality, { seconds, channels }] of perModality) {
      if (seconds === null || channels === null) {
        this.unmeasured += 1;
        continue;
      }
      storeSeconds = maxOf(storeSeconds, seconds);
      let byChannels = this.bins.get(modality);
      if (!byChannels) {
        byChannels = new Map();
        this.bins.set(modality, byChannels);
      }
      const bin = byChannels.get(channels) ?? { seconds: 0, recordings: 0 };
      bin.seconds += seconds;
      bin.recordings += 1;
      byChannels.set(channels, bin);
    }
    if (storeSeconds === null) {
      this.unmeasuredStores += 1;
    } else {
      this.measuredStores += 1;
      this.storeSeconds += storeSeconds;
    }
  }

  /**
   * Close the summary. `failed` and `pending` prefer the producer's own counts
   * (as nemar-cli does) and fall back to the number of list entries seen.
   */
  summary(counts: {
    failureCount: unknown;
    pendingCount: unknown;
    failuresSeen: number;
    pendingSeen: number;
  }): DatasetSummary {
    const modalities: ModalitySummary[] = [];
    for (const [modality, byChannels] of this.bins) {
      const bins = [...byChannels.entries()]
        .sort(([left], [right]) => left - right)
        .map(([channels, { seconds, recordings }]) => ({ channels, seconds, recordings }));
      modalities.push({ modality, bins });
    }
    modalities.sort((left, right) => left.modality.localeCompare(right.modality));
    return {
      modalities,
      stores: this.stores,
      excluded: this.excluded,
      measuredStores: this.measuredStores,
      storeSeconds: this.storeSeconds,
      unmeasuredStores: this.unmeasuredStores,
      unmeasured: this.unmeasured,
      failed: declaredCount(counts.failureCount) ?? counts.failuresSeen,
      pending: declaredCount(counts.pendingCount) ?? counts.pendingSeen,
      multiGroupStores: this.multiGroupStores,
      multiModalityStores: this.multiModalityStores,
    };
  }
}

function checkRoot(root: Map<string, unknown>, expectedId: string, storesSeen: boolean): void {
  const format = root.get("format");
  if (format !== undefined && format !== INDEX_FORMAT) {
    throw new IndexFormatError(`the document is not a ${INDEX_FORMAT}`);
  }
  const datasetId = root.get("dataset_id");
  if (datasetId !== undefined && datasetId !== expectedId) {
    throw new IndexFormatError("the index belongs to a different dataset");
  }
  if (!storesSeen) throw new IndexFormatError("the index has no stores list");
}

/** Summarize an index that is already parsed (small documents and tests). */
export function summarizeIndex(index: unknown, expectedId: string): DatasetSummary {
  if (!isObject(index)) throw new IndexFormatError("the index is not a JSON object");
  const root = new Map<string, unknown>(Object.entries(index));
  checkRoot(root, expectedId, Array.isArray(index.stores));
  const accumulator = new DatasetAccumulator();
  for (const store of index.stores as unknown[]) accumulator.add(store);
  return accumulator.summary({
    failureCount: index.failure_count,
    pendingCount: index.pending_count,
    failuresSeen: Array.isArray(index.failures) ? index.failures.length : 0,
    pendingSeen: Array.isArray(index.pending) ? index.pending.length : 0,
  });
}

const ROOT_SCALARS = new Set(["format", "dataset_id", "failure_count", "pending_count"]);

/**
 * Summarize an index from its byte stream without holding the document in
 * memory: each `stores[]` entry is parsed on its own and dropped, so a 300 MB
 * index costs a few megabytes. Throws IndexFormatError or JsonShapeError for a
 * document that is not a usable index, and lets stream errors through.
 */
export async function summarizeIndexStream(
  stream: ReadableStream<Uint8Array>,
  expectedId: string,
  onChunk?: () => void,
): Promise<DatasetSummary> {
  const accumulator = new DatasetAccumulator();
  const root = new Map<string, unknown>();
  const decoder = new TextDecoder();
  const scan = await scanRootObject(
    stream,
    {
      wantValue: (key) => ROOT_SCALARS.has(key),
      onValue: (key, rawJson) => {
        try {
          root.set(key, JSON.parse(rawJson));
        } catch {
          throw new JsonShapeError(`the value of "${key}" is not valid JSON`);
        }
      },
      wantElements: (key) => key === "stores",
      onElement: (key, raw) => {
        if (key !== "stores" || raw === null) return;
        let store: unknown;
        try {
          store = JSON.parse(decoder.decode(raw));
        } catch {
          throw new JsonShapeError("a stores entry is not valid JSON");
        }
        accumulator.add(store);
      },
    },
    onChunk,
  );
  checkRoot(root, expectedId, scan.elementCounts.has("stores"));
  return accumulator.summary({
    failureCount: root.get("failure_count"),
    pendingCount: root.get("pending_count"),
    failuresSeen: scan.elementCounts.get("failures") ?? 0,
    pendingSeen: scan.elementCounts.get("pending") ?? 0,
  });
}

/** A summary read back from disk is only trusted if every field has the exact shape. */
export function parseDatasetSummary(value: unknown): DatasetSummary | null {
  if (!isObject(value) || !Array.isArray(value.modalities)) return null;
  const counters = [
    "stores",
    "excluded",
    "measuredStores",
    "unmeasuredStores",
    "unmeasured",
    "failed",
    "pending",
    "multiGroupStores",
    "multiModalityStores",
  ] as const;
  for (const name of counters) {
    if (declaredCount(value[name]) === null) return null;
  }
  const modalities: ModalitySummary[] = [];
  const seen = new Set<string>();
  for (const entry of value.modalities) {
    if (!isObject(entry) || !Array.isArray(entry.bins)) return null;
    const modality = normalizeModality(entry.modality);
    if (modality === null || modality !== entry.modality || seen.has(modality)) return null;
    seen.add(modality);
    const bins: BinSummary[] = [];
    const channelsSeen = new Set<number>();
    for (const bin of entry.bins) {
      if (!isObject(bin)) return null;
      const channels = validChannels(bin.channels);
      const seconds = validDuration(bin.seconds);
      const recordings = declaredCount(bin.recordings);
      if (channels === null || seconds === null || recordings === null) return null;
      if (channelsSeen.has(channels)) return null;
      channelsSeen.add(channels);
      bins.push({ channels, seconds, recordings });
    }
    if (bins.length === 0) return null;
    modalities.push({ modality, bins });
  }
  const storeSeconds = validDuration(value.storeSeconds);
  if (storeSeconds === null) return null;
  return {
    modalities,
    stores: value.stores as number,
    excluded: value.excluded as number,
    measuredStores: value.measuredStores as number,
    storeSeconds,
    unmeasuredStores: value.unmeasuredStores as number,
    unmeasured: value.unmeasured as number,
    failed: value.failed as number,
    pending: value.pending as number,
    multiGroupStores: value.multiGroupStores as number,
    multiModalityStores: value.multiModalityStores as number,
  };
}
