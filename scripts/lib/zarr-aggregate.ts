// The collective half of the Zarr recordings collector: combine the per-dataset
// summaries (zarr-recordings.ts) into the `channel_hours` payload and headline
// metrics of section `recordings`, and check the payload against the section
// contract. Pure: no network, no filesystem. Dependency-free at runtime (the
// schema import below is type-only), so the collector runs from a bare checkout
// without `bun install`.

import type {
  ChannelHours,
  ChannelHoursModality,
  SectionIngest,
  Severity,
} from "../../src/lib/schema";
import { codeStaleMetrics, fail, utcDate } from "./s3-cloudwatch";
import { type DatasetSummary, MAX_CHANNELS, MODALITY_NAME } from "./zarr-recordings";

export const SECTION_KEY = "recordings";
export const SECTION_LABEL = "Recorded data";
export const SECTION_SOURCE = "nemar-zarr-index";

/** The contract's array bounds (src/lib/schema.ts). */
const MAX_MODALITIES = 32;
const MAX_BINS = 1024;
/**
 * The ingest endpoint rejects bodies over 1,000,000 bytes (MAX_SECTION_BODY_BYTES
 * in src/routes/api.ts); stay well below it. test/zarr-aggregate.test.ts pushes
 * bodies of this size and of the Worker's limit through the real Worker.
 */
export const MAX_PAYLOAD_BYTES = 900_000;

/** What happened to one public dataset this run. */
export type DatasetOutcome =
  | { id: string; kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  /** No Zarr index exists for the dataset, and none was expected. */
  | { id: string; kind: "absent" }
  /**
   * A Zarr index should exist or exists, but could not be read this run.
   * `lastKnownSeconds` is what the cache held for it before this run (never
   * shown as a result), so the size of the gap is known.
   */
  | { id: string; kind: "unavailable"; reason: string; lastKnownSeconds?: number };

export type RecordingsAggregate = {
  /** Every public dataset in the catalog, scanned or not. */
  publicDatasets: number;
  /** Datasets whose index was read this run (downloaded or revalidated from cache). */
  scanned: number;
  fromCache: number;
  fromNetwork: number;
  unavailable: number;
  /** Seconds the cache last knew for the unavailable datasets (datasets never cached count nothing). */
  unavailableLastKnownSeconds: number;
  withoutIndex: number;
  /** Datasets with at least one measured recording. */
  contributingDatasets: number;
  /** Raw stores measured in at least one modality; a store with two modalities counts once. */
  measuredRecordings: number;
  /** Raw stores with no measured modality. */
  unmeasuredStores: number;
  /** Total seconds of the measured stores, each counted once (its longest measured modality). */
  recordedSeconds: number;
  /** (store, modality) measured recordings: the sum over every channel bin of every modality. */
  modalityRecordings: number;
  /** (store, modality) recordings left out of every bin; what the contract calls unmeasured. */
  unmeasuredRecordings: number;
  failedRecordings: number;
  pendingRecordings: number;
  excludedStores: number;
  multiGroupStores: number;
  multiModalityStores: number;
  /** Modalities beyond the contract's 32 whose recordings were counted as unmeasured instead. */
  droppedModalities: number;
  /** Contract-shaped, largest modality first; empty when nothing was measured. */
  modalities: ChannelHoursModality[];
};

/** Hours are kept to 4 decimals (0.36 s), like the contract's real-data sample. */
export const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Combine the per-dataset summaries. Deterministic: datasets are folded in id
 * order, so the same inputs always give the same floating-point sums.
 *
 * For each modality, a dataset's "peak" is the largest channel count among its
 * measured recordings in that modality; `dataset_peaks` counts datasets per
 * peak, which is what makes "datasets with N or more channels" exact.
 * Modality names that differ only in case are one modality; the spelling that
 * sorts first (an uppercase letter before a lowercase one) is displayed.
 */
export function aggregateOutcomes(
  publicDatasets: number,
  outcomes: DatasetOutcome[],
): RecordingsAggregate {
  const sorted = [...outcomes].sort((left, right) => left.id.localeCompare(right.id));
  type ModalityState = {
    display: string;
    bins: Map<number, { seconds: number; recordings: number }>;
    peaks: Map<number, number>;
  };
  const byKey = new Map<string, ModalityState>();
  const aggregate: RecordingsAggregate = {
    publicDatasets,
    scanned: 0,
    fromCache: 0,
    fromNetwork: 0,
    unavailable: 0,
    unavailableLastKnownSeconds: 0,
    withoutIndex: 0,
    contributingDatasets: 0,
    measuredRecordings: 0,
    unmeasuredStores: 0,
    recordedSeconds: 0,
    modalityRecordings: 0,
    unmeasuredRecordings: 0,
    failedRecordings: 0,
    pendingRecordings: 0,
    excludedStores: 0,
    multiGroupStores: 0,
    multiModalityStores: 0,
    droppedModalities: 0,
    modalities: [],
  };

  for (const outcome of sorted) {
    if (outcome.kind === "absent") {
      aggregate.withoutIndex += 1;
      continue;
    }
    if (outcome.kind === "unavailable") {
      aggregate.unavailable += 1;
      aggregate.unavailableLastKnownSeconds += outcome.lastKnownSeconds ?? 0;
      continue;
    }
    const { summary } = outcome;
    aggregate.scanned += 1;
    if (outcome.from === "cache") aggregate.fromCache += 1;
    else aggregate.fromNetwork += 1;
    aggregate.measuredRecordings += summary.measuredStores;
    aggregate.unmeasuredStores += summary.unmeasuredStores;
    aggregate.recordedSeconds += summary.storeSeconds;
    aggregate.unmeasuredRecordings += summary.unmeasured;
    aggregate.failedRecordings += summary.failed;
    aggregate.pendingRecordings += summary.pending;
    aggregate.excludedStores += summary.excluded;
    aggregate.multiGroupStores += summary.multiGroupStores;
    aggregate.multiModalityStores += summary.multiModalityStores;
    if (summary.modalities.length > 0) aggregate.contributingDatasets += 1;

    // Names that differ only in case are one modality, so a dataset's peak is
    // taken over all of its spellings before it is counted once.
    const datasetPeak = new Map<ModalityState, number>();
    for (const { modality, bins } of summary.modalities) {
      const key = modality.toLowerCase();
      let state = byKey.get(key);
      if (!state) {
        state = { display: modality, bins: new Map(), peaks: new Map() };
        byKey.set(key, state);
      } else if (modality < state.display) {
        state.display = modality;
      }
      let peak = datasetPeak.get(state) ?? 0;
      for (const bin of bins) {
        const total = state.bins.get(bin.channels) ?? { seconds: 0, recordings: 0 };
        total.seconds += bin.seconds;
        total.recordings += bin.recordings;
        state.bins.set(bin.channels, total);
        aggregate.modalityRecordings += bin.recordings;
        peak = Math.max(peak, bin.channels);
      }
      datasetPeak.set(state, peak);
    }
    for (const [state, peak] of datasetPeak) {
      state.peaks.set(peak, (state.peaks.get(peak) ?? 0) + 1);
    }
  }

  for (const state of byKey.values()) {
    const bins = [...state.bins.entries()]
      .sort(([left], [right]) => left - right)
      .map(([channels, { seconds, recordings }]) => ({
        channels,
        hours: round4(seconds / 3600),
        recordings,
      }));
    const dataset_peaks = [...state.peaks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([channels, datasets]) => ({ channels, datasets }));
    aggregate.modalities.push({
      modality: state.display,
      hours: round4(bins.reduce((total, bin) => total + bin.hours, 0)),
      recordings: bins.reduce((total, bin) => total + bin.recordings, 0),
      datasets: dataset_peaks.reduce((total, peak) => total + peak.datasets, 0),
      bins,
      dataset_peaks,
    });
  }
  aggregate.modalities.sort(
    (left, right) => right.hours - left.hours || left.modality.localeCompare(right.modality),
  );
  // The contract carries at most 1024 channel-count bins per modality. Datasets
  // are individually held to 512, but many datasets with different counts could
  // still add up past 1024; such a modality is not shown and its recordings
  // count as unmeasured (the same treatment as too many modalities, below).
  const tooWide = aggregate.modalities.filter((modality) => modality.bins.length > MAX_BINS);
  if (tooWide.length > 0) {
    aggregate.modalities = aggregate.modalities.filter((modality) => !tooWide.includes(modality));
    for (const wide of tooWide) {
      aggregate.droppedModalities += 1;
      aggregate.unmeasuredRecordings += wide.recordings;
      aggregate.modalityRecordings -= wide.recordings;
    }
  }
  // The contract carries at most 32 modalities. A corrupt or hostile index can
  // invent names, so the smallest beyond 32 are not shown and their recordings
  // are counted as unmeasured; that must never fail the whole run.
  for (const extra of aggregate.modalities.splice(MAX_MODALITIES)) {
    aggregate.droppedModalities += 1;
    aggregate.unmeasuredRecordings += extra.recordings;
    aggregate.modalityRecordings -= extra.recordings;
  }
  return aggregate;
}

/** One dataset's recorded hours in one modality, for the run report. */
export type Contributor = { id: string; hours: number; share: number };

/**
 * The datasets that hold the most hours in each modality (default five), so a
 * total dominated by a few datasets is visible. Report-only: the pushed payload
 * carries no dataset identifiers.
 */
export function topContributors(
  outcomes: DatasetOutcome[],
  limit = 5,
): Map<string, { hours: number; top: Contributor[] }> {
  const perModality = new Map<string, { display: string; byDataset: Map<string, number> }>();
  for (const outcome of outcomes) {
    if (outcome.kind !== "summary") continue;
    for (const { modality, bins } of outcome.summary.modalities) {
      const key = modality.toLowerCase();
      let entry = perModality.get(key);
      if (!entry) {
        entry = { display: modality, byDataset: new Map() };
        perModality.set(key, entry);
      } else if (modality < entry.display) {
        entry.display = modality;
      }
      const seconds = bins.reduce((total, bin) => total + bin.seconds, 0);
      entry.byDataset.set(outcome.id, (entry.byDataset.get(outcome.id) ?? 0) + seconds);
    }
  }
  const result = new Map<string, { hours: number; top: Contributor[] }>();
  for (const { display, byDataset } of perModality.values()) {
    const totalSeconds = [...byDataset.values()].reduce((total, seconds) => total + seconds, 0);
    const top = [...byDataset.entries()]
      .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))
      .slice(0, limit)
      .map(([id, seconds]) => ({
        id,
        hours: round4(seconds / 3600),
        share: totalSeconds > 0 ? seconds / totalSeconds : 0,
      }));
    result.set(display, { hours: round4(totalSeconds / 3600), top });
  }
  return result;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeCount = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

const isChannels = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHANNELS;

const isHours = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function exactKeys(value: Record<string, unknown>, keys: string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (extra.length > 0 || missing.length > 0) {
    fail(`${what} must have exactly the keys ${keys.join(", ")}; no section was published`);
  }
}

/**
 * Every rule of the `channel_hours` contract (ChannelHoursSchema in
 * src/lib/schema.ts), enforced here in plain TypeScript because the collector
 * cannot load zod on a bare checkout. It is meant to be exactly as strict as the
 * schema, no more and no less: test/zarr-aggregate.test.ts runs a table of
 * payloads through both and requires the same verdict on each.
 */
export function assertChannelHours(value: unknown): asserts value is ChannelHours {
  if (!isRecord(value)) fail("channel_hours must be an object; no section was published");
  exactKeys(
    value,
    ["datasets_scanned", "datasets_unavailable", "recordings_unmeasured", "modalities"],
    "channel_hours",
  );
  const { datasets_scanned, datasets_unavailable, recordings_unmeasured, modalities } = value;
  if (
    !isSafeCount(datasets_scanned, 0) ||
    !isSafeCount(datasets_unavailable, 0) ||
    !isSafeCount(recordings_unmeasured, 0)
  ) {
    fail("channel_hours counters must be non-negative safe integers; no section was published");
  }
  if (!Array.isArray(modalities) || modalities.length < 1 || modalities.length > MAX_MODALITIES) {
    fail("channel_hours must carry between 1 and 32 modalities; no section was published");
  }
  const names = new Set<string>();
  for (const modality of modalities) {
    if (!isRecord(modality)) fail("a channel_hours modality must be an object");
    exactKeys(
      modality,
      ["modality", "hours", "recordings", "datasets", "bins", "dataset_peaks"],
      "a channel_hours modality",
    );
    const { bins, dataset_peaks: peaks } = modality;
    const name = modality.modality;
    if (typeof name !== "string" || !MODALITY_NAME.test(name)) {
      fail(
        "a channel_hours modality name must be a plain name (a letter, then letters, digits, - or _)",
      );
    }
    if (names.has(name.toLowerCase())) fail(`channel_hours repeats the modality "${name}"`);
    names.add(name.toLowerCase());
    if (!isHours(modality.hours) || !isSafeCount(modality.recordings, 0)) {
      fail(`channel_hours modality ${name} has an invalid hours or recordings total`);
    }
    if (!isSafeCount(modality.datasets, 0)) {
      fail(`channel_hours modality ${name} has an invalid datasets total`);
    }
    if (modality.datasets > datasets_scanned) {
      fail(
        `channel_hours modality ${name} has ${modality.datasets} datasets, more than the ${datasets_scanned} scanned`,
      );
    }
    if (!Array.isArray(bins) || bins.length < 1 || bins.length > MAX_BINS) {
      fail(`channel_hours modality ${name} must have between 1 and ${MAX_BINS} bins`);
    }
    if (!Array.isArray(peaks) || peaks.length < 1 || peaks.length > MAX_BINS) {
      fail(`channel_hours modality ${name} must have between 1 and ${MAX_BINS} dataset peaks`);
    }

    let hours = 0;
    let recordings = 0;
    let previous = 0;
    const binRecordings = new Map<number, number>();
    for (const bin of bins) {
      if (!isRecord(bin)) fail(`a ${name} bin must be an object`);
      exactKeys(bin, ["channels", "hours", "recordings"], `a ${name} bin`);
      if (!isChannels(bin.channels) || !isHours(bin.hours) || !isSafeCount(bin.recordings, 1)) {
        fail(`channel_hours modality ${name} has an invalid bin`);
      }
      if (bin.channels <= previous) {
        fail(`channel_hours modality ${name} bins must be strictly ascending by channels`);
      }
      previous = bin.channels;
      hours += bin.hours;
      recordings += bin.recordings;
      binRecordings.set(bin.channels, bin.recordings);
    }
    let datasets = 0;
    previous = 0;
    for (const peak of peaks) {
      if (!isRecord(peak)) fail(`a ${name} dataset peak must be an object`);
      exactKeys(peak, ["channels", "datasets"], `a ${name} dataset peak`);
      if (!isChannels(peak.channels) || !isSafeCount(peak.datasets, 1)) {
        fail(`channel_hours modality ${name} has an invalid dataset peak`);
      }
      if (peak.channels <= previous) {
        fail(`channel_hours modality ${name} dataset peaks must be strictly ascending by channels`);
      }
      previous = peak.channels;
      datasets += peak.datasets;
      const inBin = binRecordings.get(peak.channels);
      if (inBin === undefined) {
        fail(
          `channel_hours modality ${name} has a dataset peak at ${peak.channels} channels with no bin`,
        );
      }
      if (peak.datasets > inBin) {
        fail(
          `channel_hours modality ${name}: ${peak.datasets} datasets peak at ${peak.channels} channels but the bin holds only ${inBin} recordings`,
        );
      }
    }
    const topBin = bins[bins.length - 1].channels;
    const topPeak = peaks[peaks.length - 1].channels;
    if (topPeak !== topBin) {
      fail(
        `channel_hours modality ${name}: the largest peak (${topPeak} channels) must match the largest bin (${topBin})`,
      );
    }
    if (recordings !== modality.recordings) {
      fail(
        `channel_hours modality ${name} recordings must equal the sum over bins (expected ${recordings}, got ${modality.recordings})`,
      );
    }
    if (Math.abs(hours - modality.hours) > Math.max(1e-6, modality.hours * 1e-9)) {
      fail(
        `channel_hours modality ${name} hours must equal the sum over bins (expected ${hours}, got ${modality.hours})`,
      );
    }
    if (datasets !== modality.datasets) {
      fail(
        `channel_hours modality ${name} datasets must equal the sum over dataset peaks (expected ${datasets}, got ${modality.datasets})`,
      );
    }
  }
}

const HOURS_HINT =
  "Summed recording time of converted raw recordings in public datasets. A recording with two signal types counts once here and once under each type below, so the types can add up to more than this total. Derived recordings, and recordings that did not convert or lack a duration or channel count, are left out.";

/** Appended to the hours hint when some public datasets could not be read this run. */
const hoursShortfall = (unavailable: number) =>
  ` ${unavailable} public ${unavailable === 1 ? "dataset" : "datasets"} could not be read this run, so these hours may be lower than the true total.`;

/** The section pushed when a run succeeds. */
export function recordingsSection(
  aggregate: RecordingsAggregate,
  codeStaleSince: string | null = null,
): SectionIngest {
  if (aggregate.modalities.length === 0) {
    fail(
      "no recording with a duration and channel count was found; refusing to publish zero hours",
    );
  }
  const channelHours: ChannelHours = {
    datasets_scanned: aggregate.scanned,
    datasets_unavailable: aggregate.unavailable,
    recordings_unmeasured: aggregate.unmeasuredRecordings,
    modalities: aggregate.modalities,
  };
  assertChannelHours(channelHours);

  const unconverted = aggregate.failedRecordings + aggregate.pendingRecordings;
  const complete = aggregate.unavailable === 0;
  const recordingsTotal = aggregate.measuredRecordings + aggregate.unmeasuredStores + unconverted;
  const readSeverity: Severity = complete ? "info" : "warn";

  return {
    key: SECTION_KEY,
    label: SECTION_LABEL,
    source: SECTION_SOURCE,
    metrics: [
      {
        key: "recordings.hours",
        label: "Hours of recorded data",
        value: round4(aggregate.recordedSeconds / 3600),
        unit: "hours",
        severity: readSeverity,
        breakdown: aggregate.modalities.map((modality) => ({
          label: modality.modality,
          value: modality.hours,
        })),
        breakdown_unit: "hours",
        breakdown_style: "bars",
        hint: complete ? HOURS_HINT : `${HOURS_HINT}${hoursShortfall(aggregate.unavailable)}`,
      },
      {
        key: "recordings.recordings",
        label: "Recordings measured",
        value: aggregate.measuredRecordings,
        ...(complete ? { total: recordingsTotal } : {}),
        unit: "count",
        severity: "info",
        hint: complete
          ? `Converted raw recordings with a duration and channel count; a recording with two signal types counts once. The total adds ${aggregate.unmeasuredStores} converted recordings without a usable duration or channel count and ${unconverted} that failed or are pending, as listed by the Zarr indexes read. Public datasets with no Zarr index at all (${aggregate.withoutIndex}) are not counted.`
          : `Converted raw recordings with a duration and channel count; a recording with two signal types counts once. No total is shown because some public datasets (${aggregate.unavailable}) could not be read this run.`,
      },
      {
        key: "recordings.datasets",
        label: "Datasets with recorded data",
        value: aggregate.contributingDatasets,
        total: aggregate.publicDatasets,
        unit: "datasets",
        severity: readSeverity,
        hint: `Public datasets with at least one measured recording. ${aggregate.withoutIndex} have no Zarr index and ${aggregate.unavailable} could not be read this run.`,
      },
      {
        key: "recordings.collector.errors",
        label: "Latest collector run errors",
        value: 0,
        unit: "errors",
        severity: "ok",
        hint: "The latest scheduled collection completed.",
      },
      ...codeStaleMetrics(SECTION_KEY, codeStaleSince),
    ],
    channel_hours: channelHours,
  };
}

/** The public failure status; the detail stays in the collector's journal. */
export function recordingsFailureStatus(now = new Date()): SectionIngest {
  return {
    key: SECTION_KEY,
    label: SECTION_LABEL,
    source: SECTION_SOURCE,
    metrics: [
      {
        key: "recordings.collector.errors",
        label: "Latest collector run errors",
        value: 1,
        unit: "errors",
        severity: "error",
        hint: `${utcDate(now)} UTC collection failed; the recorded hours are unknown until a later run succeeds.`,
      },
    ],
  };
}

/**
 * Fail a run whose payload is too large or whose coverage is too thin to trust.
 *
 * Coverage is judged two ways, and either failing fails the run: by dataset
 * count, and by hours. One unreadable dataset can hold most of the hours (as
 * on005873 holds a fifth of them), so the share of unreadable datasets alone
 * would pass a run that is missing most of the data. The hours of an unreadable
 * dataset are what the cache last knew for it; a dataset never cached counts
 * only by number, so the very first run has only the count to go on.
 */
export function assertPublishable(
  aggregate: RecordingsAggregate,
  payload: SectionIngest,
  maxUnavailableFraction = 0.1,
): void {
  const expected = aggregate.scanned + aggregate.unavailable;
  if (aggregate.scanned === 0) {
    fail("no Zarr index could be read; refusing to publish an empty section");
  }
  if (aggregate.unavailable > expected * maxUnavailableFraction) {
    fail(
      `${aggregate.unavailable} of ${expected} Zarr indexes could not be read; refusing to publish a section built from too few datasets`,
    );
  }
  const knownSeconds = aggregate.recordedSeconds + aggregate.unavailableLastKnownSeconds;
  if (
    aggregate.unavailableLastKnownSeconds > 0 &&
    aggregate.unavailableLastKnownSeconds > knownSeconds * maxUnavailableFraction
  ) {
    const share = Math.round((aggregate.unavailableLastKnownSeconds / knownSeconds) * 100);
    fail(
      `the ${aggregate.unavailable} unreadable Zarr indexes held about ${share}% of the hours last time; refusing to publish a section that would miss them`,
    );
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    fail(`the section payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`);
  }
}
