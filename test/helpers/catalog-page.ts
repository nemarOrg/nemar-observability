// A snapshot for the page tests that draw the catalog beside the recorded-hours
// explorer: the captured production snapshot (datasets and sizes sections), the
// per-type size histograms the Worker now adds to the sizes section, and a
// pushed recordings section with the figures the catalog strip shows. Pass it
// to openPage as snapshotBody.

import type { Metric } from "../../src/lib/schema";
import { SIZE_MODALITIES, buildSizeHistogram } from "../../src/lib/sizes";
import snapshotFixture from "../fixtures/snapshot-2026-09-28.json";
import { type Payload, recordingsSection } from "./hours-page";

const GB = 1_000_000_000;
const MB = 1_000_000;

/** Dataset sizes per type, in bytes: enough spread to fill several bins, including the 100 GB cutoff bin. */
export const SIZES_BY_TYPE: Record<string, number[]> = {
  eeg: [3 * MB, 40 * MB, 800 * MB, 2 * GB, 2 * GB, 6 * GB, 15 * GB, 30 * GB, 60 * GB, 150 * GB],
  meg: [5 * GB, 20 * GB, 20 * GB, 250 * GB],
  ieeg: [1 * GB, 4 * GB, 9 * GB],
  emg: [700 * MB, 3 * GB],
};

/** What the catalog strip reads from the recordings section. */
export const RECORDED = { recordings: 233_194, total: 236_660, hours: 144_700.4858 };

const recordedMetrics = (zero: boolean): Metric[] => [
  {
    key: "recordings.hours",
    label: "Hours of recorded data",
    value: zero ? 0 : RECORDED.hours,
    unit: "hours",
    severity: "info",
    hint: "Summed recording time of converted raw recordings in public datasets.",
  },
  {
    key: "recordings.recordings",
    label: "Recordings measured",
    value: zero ? 0 : RECORDED.recordings,
    total: RECORDED.total,
    unit: "count",
    severity: "info",
    hint: "Converted raw recordings with a duration and channel count.",
  },
  {
    key: "recordings.datasets",
    label: "Datasets with recorded data",
    value: 695,
    total: 769,
    unit: "datasets",
    severity: "info",
  },
];

type Section = { key: string; metrics: Metric[] } & Record<string, unknown>;

export function catalogSnapshot(
  options: {
    /** "none": no recordings section; "failed": the error-only status a failed run pushes. */
    recordings?: "ok" | "none" | "failed";
    payload?: Payload;
    /** Report zero recordings and zero hours (a collector that found nothing). */
    zeroRecorded?: boolean;
    /** Leave out the per-type size histograms, as a snapshot from before they existed. */
    withoutSizeTypes?: boolean;
  } = {},
) {
  const snap = structuredClone(snapshotFixture.response) as { sections: Section[] };
  const sizes = snap.sections.find((s) => s.key === "sizes");
  if (!sizes) throw new Error("the fixture has no sizes section");
  if (!options.withoutSizeTypes) {
    for (const { code, label } of SIZE_MODALITIES) {
      const list = SIZES_BY_TYPE[code];
      sizes.metrics.push({
        key: `sizes.histogram.${code}`,
        label: `Size distribution, ${label}`,
        value: list.length,
        unit: "datasets",
        severity: "info",
        breakdown: buildSizeHistogram(list),
        hint: `The same size bins as the whole catalog, for the ${list.length} public datasets that include ${label} recordings.`,
      });
    }
  }
  const mode = options.recordings ?? "ok";
  if (mode === "ok") {
    const section = recordingsSection(true, { payload: options.payload });
    snap.sections.push({
      ...section,
      metrics: [...recordedMetrics(options.zeroRecorded === true), ...section.metrics],
    } as Section);
  } else if (mode === "failed") {
    snap.sections.push({
      key: "recordings",
      label: "Recorded hours",
      source: "nemar-zarr-index",
      updated_at: new Date().toISOString(),
      metrics: [
        {
          key: "recordings.collector.errors",
          label: "Latest collector run errors",
          value: 1,
          unit: "errors",
          severity: "error",
        },
      ],
    });
  }
  return snap;
}
