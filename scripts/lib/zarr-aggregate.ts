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
import { type DatasetSummary, MAX_CHANNELS } from "./zarr-recordings";

export const SECTION_KEY = "recordings";
export const SECTION_LABEL = "Recorded data";
export const SECTION_SOURCE = "nemar-zarr-index";

const MAX_MODALITIES = 32;
const MAX_BINS = 1024;
/** The ingest endpoint rejects bodies over 1 MB; stay well below it. */
export const MAX_PAYLOAD_BYTES = 900_000;

/** What happened to one public dataset this run. */
export type DatasetOutcome =
  | { id: string; kind: "summary"; summary: DatasetSummary; from: "cache" | "network" }
  /** No Zarr index exists for the dataset, and none was expected. */
  | { id: string; kind: "absent" }
  /** A Zarr index should exist or exists, but could not be read this run. */
  | { id: string; kind: "unavailable"; reason: string };

export type RecordingsAggregate = {
  /** Every public dataset in the catalog, scanned or not. */
  publicDatasets: number;
  /** Datasets whose index was read this run (downloaded or revalidated from cache). */
  scanned: number;
  fromCache: number;
  fromNetwork: number;
  unavailable: number;
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
    modalities: [],
  };

  for (const outcome of sorted) {
    if (outcome.kind === "absent") {
      aggregate.withoutIndex += 1;
      continue;
    }
    if (outcome.kind === "unavailable") {
      aggregate.unavailable += 1;
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

/**
 * The cross-field rules of the `channel_hours` contract, enforced here in plain
 * TypeScript because the collector cannot load zod on a bare checkout. The
 * test suite checks the same payloads against the real SectionIngestSchema.
 */
export function assertChannelHours(value: ChannelHours): void {
  if (value.modalities.length < 1 || value.modalities.length > MAX_MODALITIES) {
    fail("channel_hours must carry between 1 and 32 modalities; no section was published");
  }
  const names = new Set<string>();
  for (const modality of value.modalities) {
    const name = modality.modality.toLowerCase();
    if (names.has(name) || modality.modality.length < 1) {
      fail(`channel_hours has a duplicate or empty modality "${modality.modality}"`);
    }
    names.add(name);
    if (modality.bins.length < 1 || modality.bins.length > MAX_BINS) {
      fail(`channel_hours modality ${modality.modality} has an unusable number of bins`);
    }
    if (modality.dataset_peaks.length > MAX_BINS) {
      fail(`channel_hours modality ${modality.modality} has too many dataset peaks`);
    }
    const channels = new Set<number>();
    let hours = 0;
    let recordings = 0;
    for (const bin of modality.bins) {
      if (channels.has(bin.channels) || !Number.isInteger(bin.channels) || bin.channels < 1) {
        fail(`channel_hours modality ${modality.modality} has an invalid channel count`);
      }
      if (bin.channels > MAX_CHANNELS || !Number.isFinite(bin.hours) || bin.hours < 0) {
        fail(`channel_hours modality ${modality.modality} has an invalid bin`);
      }
      channels.add(bin.channels);
      hours += bin.hours;
      recordings += bin.recordings;
    }
    const peakChannels = new Set<number>();
    let datasets = 0;
    for (const peak of modality.dataset_peaks) {
      if (peakChannels.has(peak.channels) || peak.datasets < 1) {
        fail(`channel_hours modality ${modality.modality} has an invalid dataset peak`);
      }
      peakChannels.add(peak.channels);
      datasets += peak.datasets;
    }
    if (recordings !== modality.recordings || datasets !== modality.datasets) {
      fail(`channel_hours modality ${modality.modality} totals do not match its bins`);
    }
    if (Math.abs(hours - modality.hours) > Math.max(1e-6, modality.hours * 1e-9)) {
      fail(`channel_hours modality ${modality.modality} hours do not match its bins`);
    }
  }
}

const HOURS_HINT =
  "Summed recording time of converted raw recordings in public datasets. A recording with two signal types counts once here and once under each type below, so the types can add up to more than this total. Derived recordings, and recordings that did not convert or lack a duration or channel count, are left out.";

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
  const datasetsSeverity: Severity = complete ? "info" : "warn";

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
        severity: "info",
        breakdown: aggregate.modalities.map((modality) => ({
          label: modality.modality,
          value: modality.hours,
        })),
        breakdown_unit: "hours",
        breakdown_style: "bars",
        hint: HOURS_HINT,
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
        severity: datasetsSeverity,
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

/** Fail a run whose payload is too large or whose coverage is too thin to trust. */
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
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    fail(`the section payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`);
  }
}
