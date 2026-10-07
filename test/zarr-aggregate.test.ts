// Combining per-dataset summaries into the `recordings` section. The expected
// aggregate (test/fixtures/zarr-recordings-expected.json) was computed by an
// independent Python implementation over the same real fixtures; every payload
// is also checked against the real SectionIngestSchema, which is what the Worker
// runs at ingest.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CollectionError } from "../scripts/lib/s3-cloudwatch";
import {
  type DatasetOutcome,
  aggregateOutcomes,
  assertChannelHours,
  assertPublishable,
  recordingsFailureStatus,
  recordingsSection,
  round4,
  topContributors,
} from "../scripts/lib/zarr-aggregate";
import { type DatasetSummary, summarizeIndex } from "../scripts/lib/zarr-recordings";
import { ChannelHoursSchema, SectionIngestSchema } from "../src/lib/schema";
import { FIXTURES, datasetIdOf, fixtureObject } from "./helpers/zarr-fixtures";

const expected = JSON.parse(
  readFileSync(new URL("./fixtures/zarr-recordings-expected.json", import.meta.url), "utf8"),
) as {
  dedup_hours: number;
  measured: number;
  unconverted: number;
  modalities: Record<
    string,
    {
      hours: number;
      recordings: number;
      datasets: number;
      bins: { channels: number; hours: number; recordings: number }[];
      dataset_peaks: { channels: number; datasets: number }[];
    }
  >;
};

const outcomes: DatasetOutcome[] = FIXTURES.map((name) => ({
  id: datasetIdOf(name),
  kind: "summary" as const,
  summary: summarizeIndex(fixtureObject(name), datasetIdOf(name)),
  from: "network" as const,
}));

/** A summary with the given bins, for rules the fixtures do not exercise. */
function summaryOf(
  modalities: Record<string, [channels: number, seconds: number, recordings: number][]>,
  extra: Partial<DatasetSummary> = {},
): DatasetSummary {
  const entries = Object.entries(modalities).map(([modality, bins]) => ({
    modality,
    bins: bins.map(([channels, seconds, recordings]) => ({ channels, seconds, recordings })),
  }));
  const recordings = entries
    .flatMap((entry) => entry.bins)
    .reduce((n, bin) => n + bin.recordings, 0);
  const seconds = entries.flatMap((entry) => entry.bins).reduce((n, bin) => n + bin.seconds, 0);
  return {
    modalities: entries,
    stores: recordings,
    excluded: 0,
    measuredStores: recordings,
    storeSeconds: seconds,
    unmeasuredStores: 0,
    unmeasured: 0,
    implausible: 0,
    unusableModalities: [],
    failed: 0,
    pending: 0,
    multiGroupStores: 0,
    multiModalityStores: 0,
    ...extra,
  };
}

const summaryOutcome = (id: string, summary: DatasetSummary): DatasetOutcome => ({
  id,
  kind: "summary",
  summary,
  from: "network",
});

describe("aggregateOutcomes over the real fixtures", () => {
  const aggregate = aggregateOutcomes(9, [
    ...outcomes,
    { id: "nm000999", kind: "absent" },
    { id: "on009999", kind: "unavailable", reason: "HTTP 500" },
  ]);

  test("every modality, bin, and dataset peak matches the independent computation", () => {
    expect(aggregate.modalities.map((m) => m.modality)).toEqual([
      "EMG",
      "EEG",
      "ECG",
      "MEG",
      "iEEG",
    ]);
    for (const modality of aggregate.modalities) {
      const want = expected.modalities[modality.modality];
      expect(modality).toEqual({ modality: modality.modality, ...want });
    }
  });

  test("counts datasets, recordings, and what was left out", () => {
    expect(aggregate).toMatchObject({
      publicDatasets: 9,
      scanned: 7,
      fromNetwork: 7,
      fromCache: 0,
      unavailable: 1,
      withoutIndex: 1,
      contributingDatasets: 6,
      measuredRecordings: expected.measured,
      unmeasuredStores: 0,
      unmeasuredRecordings: 0,
      failedRecordings: 6,
      pendingRecordings: 2,
      excludedStores: 4,
      multiGroupStores: 3,
      multiModalityStores: 3,
    });
    expect(aggregate.failedRecordings + aggregate.pendingRecordings).toBe(expected.unconverted);
  });

  test("the headline counts each recording once; the modality totals double count a two-signal store", () => {
    expect(round4(aggregate.recordedSeconds / 3600)).toBe(expected.dedup_hours);
    const modalityHours = round4(aggregate.modalities.reduce((n, m) => n + m.hours, 0));
    expect(modalityHours).toBeGreaterThan(expected.dedup_hours);
    expect(aggregate.modalityRecordings).toBe(
      aggregate.modalities.reduce((n, m) => n + m.recordings, 0),
    );
    // Three real stores of on005873 carry an EEG and an EMG group.
    expect(aggregate.modalityRecordings - aggregate.measuredRecordings).toBe(3);
  });

  test("does not depend on the order the datasets finished in", () => {
    const shuffled = [...outcomes].reverse();
    expect(aggregateOutcomes(9, shuffled)).toEqual(aggregateOutcomes(9, outcomes));
  });
});

describe("dataset peaks", () => {
  test("a dataset counts once, at its largest channel count in the modality", () => {
    const aggregate = aggregateOutcomes(3, [
      summaryOutcome(
        "nm000001",
        summaryOf({
          EEG: [
            [16, 3600, 2],
            [32, 7200, 1],
          ],
        }),
      ),
      summaryOutcome("nm000002", summaryOf({ EEG: [[32, 3600, 1]] })),
      summaryOutcome("nm000003", summaryOf({ EEG: [[8, 3600, 1]] })),
    ]);
    const [eeg] = aggregate.modalities;
    expect(eeg.dataset_peaks).toEqual([
      { channels: 8, datasets: 1 },
      { channels: 32, datasets: 2 },
    ]);
    expect(eeg.datasets).toBe(3);
    // Bins keep every recording; peaks give the exact "32 channels or more" count: 2 datasets.
    expect(eeg.bins.map((bin) => [bin.channels, bin.recordings])).toEqual([
      [8, 1],
      [16, 2],
      [32, 2],
    ]);
  });

  test("modality names that differ only in case are one modality, with one peak per dataset", () => {
    const aggregate = aggregateOutcomes(2, [
      // One dataset spells it both ways: it is still one dataset with a peak of 64.
      summaryOutcome("nm000001", summaryOf({ EEG: [[32, 3600, 1]], eeg: [[64, 3600, 1]] })),
      summaryOutcome("nm000002", summaryOf({ eeg: [[64, 7200, 1]] })),
    ]);
    expect(aggregate.modalities).toHaveLength(1);
    const [eeg] = aggregate.modalities;
    expect(eeg.modality).toBe("EEG");
    expect(eeg.dataset_peaks).toEqual([{ channels: 64, datasets: 2 }]);
    expect(eeg.hours).toBe(4);
    expect(eeg.recordings).toBe(3);
    expect(
      ChannelHoursSchema.safeParse({
        datasets_scanned: 2,
        datasets_unavailable: 0,
        recordings_unmeasured: 0,
        modalities: aggregate.modalities,
      }).success,
    ).toBe(true);
  });
});

describe("the recordings section", () => {
  const aggregate = aggregateOutcomes(9, [...outcomes, { id: "nm000999", kind: "absent" }]);
  const section = recordingsSection(aggregate);
  const metric = (key: string) => section.metrics.find((m) => m.key === key);

  test("passes the Worker's own ingest validation", () => {
    const parsed = SectionIngestSchema.safeParse(section);
    expect(parsed.success).toBe(true);
    expect(section).toMatchObject({
      key: "recordings",
      label: "Recorded data",
      source: "nemar-zarr-index",
    });
    expect(section.daily_series).toBeUndefined();
  });

  test("the hours headline counts each recording once and breaks down per modality", () => {
    const hours = metric("recordings.hours");
    expect(hours).toMatchObject({
      value: expected.dedup_hours,
      unit: "hours",
      breakdown_unit: "hours",
      breakdown_style: "bars",
    });
    expect(hours?.breakdown).toEqual(
      aggregate.modalities.map((modality) => ({ label: modality.modality, value: modality.hours })),
    );
    expect(hours?.hint).toContain("counts once here and once under each type below");
  });

  test("recordings and datasets carry honest totals", () => {
    expect(metric("recordings.recordings")).toMatchObject({
      value: 230,
      total: 238,
      unit: "count",
      severity: "info",
    });
    expect(metric("recordings.datasets")).toMatchObject({
      value: 6,
      total: 9,
      unit: "datasets",
      severity: "info",
    });
    expect(metric("recordings.collector.errors")).toMatchObject({ value: 0, severity: "ok" });
    expect(section.channel_hours).toMatchObject({
      datasets_scanned: 7,
      datasets_unavailable: 0,
      recordings_unmeasured: 0,
    });
  });

  test("a dataset that could not be read removes the recordings total and warns", () => {
    const partial = recordingsSection(
      aggregateOutcomes(9, [
        ...outcomes,
        { id: "on009999", kind: "unavailable", reason: "HTTP 500" },
      ]),
    );
    const recordings = partial.metrics.find((m) => m.key === "recordings.recordings");
    expect(recordings?.total).toBeUndefined();
    expect(recordings?.hint).toContain("some public datasets (1) could not be read");
    expect(partial.metrics.find((m) => m.key === "recordings.datasets")?.severity).toBe("warn");
    expect(partial.channel_hours?.datasets_unavailable).toBe(1);
    expect(SectionIngestSchema.safeParse(partial).success).toBe(true);
  });

  test("a stale collector checkout adds the code_stale error metric, and only then", () => {
    expect(section.metrics.map((m) => m.key)).not.toContain("recordings.collector.code_stale");
    const stale = recordingsSection(aggregate, "2026-10-01T00:00:00.000Z");
    expect(stale.metrics.find((m) => m.key === "recordings.collector.code_stale")).toMatchObject({
      value: 1,
      severity: "error",
    });
    expect(SectionIngestSchema.safeParse(stale).success).toBe(true);
  });

  test("the payload is small", () => {
    expect(JSON.stringify(section).length).toBeLessThan(20_000);
  });

  test("refuses to publish zero hours", () => {
    const empty = aggregateOutcomes(1, [
      summaryOutcome("nm000001", summaryOf({}, { stores: 3, excluded: 3 })),
    ]);
    expect(() => recordingsSection(empty)).toThrow(CollectionError);
    expect(() => recordingsSection(empty)).toThrow("zero hours");
  });

  test("the failure status replaces the section with one red metric and no payload", () => {
    const status = recordingsFailureStatus(new Date("2026-10-06T12:00:00Z"));
    expect(SectionIngestSchema.safeParse(status).success).toBe(true);
    expect(status.channel_hours).toBeUndefined();
    expect(status.metrics).toHaveLength(1);
    expect(status.metrics[0]).toMatchObject({
      key: "recordings.collector.errors",
      value: 1,
      severity: "error",
    });
    expect(status.metrics[0].hint).toContain("2026-10-06 UTC");
  });
});

describe("assertChannelHours agrees with the contract schema", () => {
  const sample = JSON.parse(
    readFileSync(new URL("./fixtures/channel-hours.sample.json", import.meta.url), "utf8"),
  );

  test("accepts the contract's real-data sample and our own aggregate", () => {
    expect(() => assertChannelHours(sample)).not.toThrow();
    expect(ChannelHoursSchema.safeParse(sample).success).toBe(true);
    const ours = recordingsSection(aggregateOutcomes(7, outcomes)).channel_hours;
    expect(ours).toBeDefined();
    if (ours) expect(() => assertChannelHours(ours)).not.toThrow();
  });

  test("rejects every mutation the schema rejects", () => {
    const mutations: Record<string, (value: typeof sample) => void> = {
      "duplicate channel count": (v) => {
        v.modalities[0].bins.push({ ...v.modalities[0].bins[0] });
      },
      "duplicate modality": (v) => {
        v.modalities.push({ ...v.modalities[0], modality: "eeg" });
      },
      "hours total": (v) => {
        v.modalities[0].hours += 1;
      },
      "recordings total": (v) => {
        v.modalities[0].recordings += 1;
      },
      "datasets total": (v) => {
        v.modalities[0].datasets += 1;
      },
      "zero channels": (v) => {
        v.modalities[0].bins[0].channels = 0;
      },
      "negative hours": (v) => {
        v.modalities[0].bins[0].hours = -1;
      },
      "no bins": (v) => {
        v.modalities[0].bins = [];
        v.modalities[0].hours = 0;
        v.modalities[0].recordings = 0;
      },
      "no modalities": (v) => {
        v.modalities = [];
      },
      "duplicate dataset peak": (v) => {
        v.modalities[0].dataset_peaks.push({ ...v.modalities[0].dataset_peaks[0] });
        v.modalities[0].datasets += v.modalities[0].dataset_peaks[0].datasets;
      },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = structuredClone(sample);
      mutate(value);
      const schema = ChannelHoursSchema.safeParse(value).success;
      let ours = true;
      try {
        assertChannelHours(value);
      } catch (error) {
        ours = false;
        expect(error).toBeInstanceOf(CollectionError);
      }
      expect({ name, schema }).toEqual({ name, schema: false });
      expect({ name, ours }).toEqual({ name, ours: false });
    }
  });
});

describe("assertPublishable", () => {
  const publishable = (scanned: number, unavailable: number) => {
    const rows: DatasetOutcome[] = [
      ...Array.from({ length: scanned }, (_, i) =>
        summaryOutcome(`nm${String(i).padStart(6, "0")}`, summaryOf({ EEG: [[8, 3600, 1]] })),
      ),
      ...Array.from({ length: unavailable }, (_, i) => ({
        id: `on${String(i).padStart(6, "0")}`,
        kind: "unavailable" as const,
        reason: "HTTP 500",
      })),
    ];
    const aggregate = aggregateOutcomes(rows.length, rows);
    return () => assertPublishable(aggregate, recordingsSection(aggregate));
  };

  test("tolerates a few unreadable indexes but not many", () => {
    expect(publishable(90, 10)).not.toThrow();
    expect(publishable(89, 11)).toThrow("could not be read");
    expect(publishable(5, 0)).not.toThrow();
  });

  test("fails when nothing was read", () => {
    const aggregate = aggregateOutcomes(2, [
      { id: "nm000001", kind: "unavailable", reason: "timed out" },
      { id: "nm000002", kind: "absent" },
    ]);
    const payload = recordingsFailureStatus();
    expect(() => assertPublishable(aggregate, payload)).toThrow("no Zarr index could be read");
  });

  test("fails a payload over the size limit", () => {
    const aggregate = aggregateOutcomes(1, [
      summaryOutcome("nm000001", summaryOf({ EEG: [[8, 3600, 1]] })),
    ]);
    const payload = recordingsSection(aggregate);
    payload.metrics[0].hint = "x".repeat(950_000);
    expect(() => assertPublishable(aggregate, payload)).toThrow("byte limit");
  });
});

describe("topContributors", () => {
  test("ranks datasets by hours in each modality and gives their share", () => {
    const top = topContributors(outcomes, 2);
    const eeg = top.get("EEG");
    expect(eeg?.top.map((entry) => entry.id)).toEqual(["on005873", "nm000118"]);
    expect(eeg?.hours).toBe(expected.modalities.EEG.hours);
    // on005873 holds 23.6486 + 45.7575 of the 71.5401 EEG hours.
    expect(eeg?.top[0].hours).toBe(69.4061);
    expect(eeg?.top[0].share).toBeCloseTo(69.4061 / 71.5401, 4);
    const total = top.get("MEG")?.top.reduce((n, entry) => n + entry.share, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(top.get("ECG")?.top).toEqual([{ id: "on005873", hours: 23.6486, share: 1 }]);
  });

  test("skips datasets that were not read and never shows an empty modality", () => {
    const top = topContributors([
      { id: "nm000001", kind: "unavailable", reason: "HTTP 500" },
      { id: "nm000002", kind: "absent" },
    ]);
    expect(top.size).toBe(0);
  });
});
