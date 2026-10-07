// assertChannelHours must be exactly as strict as the real SectionIngestSchema:
// the collector cannot load zod on nemaring, so it repeats the contract, and
// every rule must give the same verdict in both. Each case below changes one
// thing in a valid payload (the section built from the real fixtures, plus the
// contract's own real-data sample) and requires the schema's success to equal
// "assertChannelHours does not throw". A rule one of them has and the other
// lacks shows up as a row that disagrees.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CollectionError } from "../scripts/lib/s3-cloudwatch";
import {
  type DatasetOutcome,
  aggregateOutcomes,
  assertChannelHours,
  recordingsSection,
} from "../scripts/lib/zarr-aggregate";
import { MAX_CHANNELS, MODALITY_NAME, summarizeIndex } from "../scripts/lib/zarr-recordings";
import { SectionIngestSchema } from "../src/lib/schema";
import { FIXTURES, datasetIdOf, fixtureObject } from "./helpers/zarr-fixtures";

type Bin = { channels: number; hours: number; recordings: number };
type Peak = { channels: number; datasets: number };
type Modality = {
  modality: string;
  hours: number;
  recordings: number;
  datasets: number;
  bins: Bin[];
  dataset_peaks: Peak[];
};
type ChannelHours = {
  datasets_scanned: number;
  datasets_unavailable: number;
  recordings_unmeasured: number;
  modalities: Modality[];
};

const outcomes: DatasetOutcome[] = FIXTURES.map((name) => ({
  id: datasetIdOf(name),
  kind: "summary" as const,
  summary: summarizeIndex(fixtureObject(name), datasetIdOf(name)),
  from: "network" as const,
}));
const ours = recordingsSection(aggregateOutcomes(7, outcomes)).channel_hours as ChannelHours;
const contractSample = JSON.parse(
  readFileSync(new URL("./fixtures/channel-hours.sample.json", import.meta.url), "utf8"),
) as ChannelHours;

/** Section around a channel_hours value, valid in every other respect. */
const sectionAround = (channelHours: unknown) => ({
  key: "recordings",
  label: "Recorded data",
  source: "nemar-zarr-index",
  metrics: [{ key: "recordings.hours", label: "Hours", value: 1, unit: "hours" }],
  channel_hours: channelHours,
});

const schemaAccepts = (value: unknown) =>
  SectionIngestSchema.safeParse(sectionAround(value)).success;
const assertAccepts = (value: unknown) => {
  try {
    assertChannelHours(value);
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(CollectionError);
    return false;
  }
};

/** Recompute a modality's totals from its bins and peaks, so a case breaks only the rule it names. */
function fix(modality: Modality): Modality {
  modality.hours = modality.bins.reduce((n, bin) => n + bin.hours, 0);
  modality.recordings = modality.bins.reduce((n, bin) => n + bin.recordings, 0);
  modality.datasets = modality.dataset_peaks.reduce((n, peak) => n + peak.datasets, 0);
  return modality;
}

type Case = { name: string; accepted: boolean; change: (value: ChannelHours) => void };
const cases: Case[] = [
  { name: "unchanged", accepted: true, change: () => {} },

  // Modality names
  {
    name: "name of 32 characters",
    accepted: true,
    change: (v) => {
      v.modalities[0].modality = "a".repeat(32);
    },
  },
  {
    name: "name of one letter",
    accepted: true,
    change: (v) => {
      v.modalities[0].modality = "X";
    },
  },
  {
    name: "name with hyphen and underscore",
    accepted: true,
    change: (v) => {
      v.modalities[0].modality = "fNIRS-2_a";
    },
  },
  {
    name: "name of 33 characters",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "a".repeat(33);
    },
  },
  {
    name: "empty name",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "";
    },
  },
  {
    name: "name starting with a digit",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "3T";
    },
  },
  {
    name: "name starting with a hyphen",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "-EEG";
    },
  },
  {
    name: "name with a space",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "EEG EMG";
    },
  },
  {
    name: "name with a dot",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "EEG.1";
    },
  },
  {
    name: "name with markup",
    accepted: false,
    change: (v) => {
      v.modalities[0].modality = "<b>";
    },
  },
  {
    name: "name that is not a string",
    accepted: false,
    change: (v) => {
      (v.modalities[0] as { modality: unknown }).modality = 7;
    },
  },
  {
    name: "same name in another case",
    accepted: false,
    change: (v) => {
      v.modalities[1].modality = v.modalities[0].modality.toLowerCase();
    },
  },
  {
    name: "same name twice",
    accepted: false,
    change: (v) => {
      v.modalities[1].modality = v.modalities[0].modality;
    },
  },

  // Keys
  {
    name: "extra top-level key",
    accepted: false,
    change: (v) => {
      (v as Record<string, unknown>).dataset_ids = ["nm000118"];
    },
  },
  {
    name: "extra modality key",
    accepted: false,
    change: (v) => {
      (v.modalities[0] as Record<string, unknown>).dataset_ids = [];
    },
  },
  {
    name: "extra bin key",
    accepted: false,
    change: (v) => {
      (v.modalities[0].bins[0] as Record<string, unknown>).dataset = "nm000118";
    },
  },
  {
    name: "extra peak key",
    accepted: false,
    change: (v) => {
      (v.modalities[0].dataset_peaks[0] as Record<string, unknown>).ids = [];
    },
  },
  {
    name: "missing top-level counter",
    accepted: false,
    change: (v) => {
      Reflect.deleteProperty(v, "recordings_unmeasured");
    },
  },
  {
    name: "missing modality key",
    accepted: false,
    change: (v) => {
      Reflect.deleteProperty(v.modalities[0], "dataset_peaks");
    },
  },
  {
    name: "missing bin key",
    accepted: false,
    change: (v) => {
      Reflect.deleteProperty(v.modalities[0].bins[0], "hours");
    },
  },
  {
    name: "missing peak key",
    accepted: false,
    change: (v) => {
      Reflect.deleteProperty(v.modalities[0].dataset_peaks[0], "datasets");
    },
  },
  { name: "not an object", accepted: false, change: () => {} },

  // Top-level counters
  {
    name: "zero datasets unavailable",
    accepted: true,
    change: (v) => {
      v.datasets_unavailable = 0;
    },
  },
  {
    name: "datasets unavailable above zero",
    accepted: true,
    change: (v) => {
      v.datasets_unavailable = 12;
    },
  },
  {
    name: "negative datasets_scanned",
    accepted: false,
    change: (v) => {
      v.datasets_scanned = -1;
    },
  },
  {
    name: "fractional datasets_scanned",
    accepted: false,
    change: (v) => {
      v.datasets_scanned = 6.5;
    },
  },
  {
    name: "NaN datasets_scanned",
    accepted: false,
    change: (v) => {
      v.datasets_scanned = Number.NaN;
    },
  },
  {
    name: "unsafe datasets_unavailable",
    accepted: false,
    change: (v) => {
      v.datasets_unavailable = 2 ** 53;
    },
  },
  {
    name: "text datasets_unavailable",
    accepted: false,
    change: (v) => {
      (v as Record<string, unknown>).datasets_unavailable = "0";
    },
  },
  {
    name: "negative recordings_unmeasured",
    accepted: false,
    change: (v) => {
      v.recordings_unmeasured = -3;
    },
  },
  {
    name: "fractional recordings_unmeasured",
    accepted: false,
    change: (v) => {
      v.recordings_unmeasured = 0.5;
    },
  },
  {
    name: "unmeasured above zero",
    accepted: true,
    change: (v) => {
      v.recordings_unmeasured = 40;
    },
  },
  {
    name: "no modalities",
    accepted: false,
    change: (v) => {
      v.modalities = [];
    },
  },
  {
    name: "modalities not an array",
    accepted: false,
    change: (v) => {
      (v as Record<string, unknown>).modalities = {};
    },
  },
  {
    name: "32 modalities",
    accepted: true,
    change: (v) => {
      const base = v.modalities[0];
      v.modalities = Array.from({ length: 32 }, (_, i) => ({
        ...structuredClone(base),
        modality: `M${i}`,
      }));
      v.datasets_scanned = 100;
    },
  },
  {
    name: "33 modalities",
    accepted: false,
    change: (v) => {
      const base = v.modalities[0];
      v.modalities = Array.from({ length: 33 }, (_, i) => ({
        ...structuredClone(base),
        modality: `M${i}`,
      }));
      v.datasets_scanned = 100;
    },
  },

  // Modality totals
  {
    name: "datasets above datasets_scanned",
    accepted: false,
    change: (v) => {
      v.datasets_scanned = 1;
    },
  },
  {
    name: "NaN hours total",
    accepted: false,
    change: (v) => {
      v.modalities[0].hours = Number.NaN;
    },
  },
  {
    name: "infinite hours total",
    accepted: false,
    change: (v) => {
      v.modalities[0].hours = Number.POSITIVE_INFINITY;
    },
  },
  {
    name: "negative hours total",
    accepted: false,
    change: (v) => {
      v.modalities[0].hours = -1;
    },
  },
  {
    name: "hours total off by 1e-7",
    accepted: true,
    change: (v) => {
      v.modalities[0].hours += 1e-7;
    },
  },
  {
    name: "hours total off by 1e-5",
    accepted: false,
    change: (v) => {
      v.modalities[0].hours += 1e-5;
    },
  },
  {
    name: "recordings total too high",
    accepted: false,
    change: (v) => {
      v.modalities[0].recordings += 1;
    },
  },
  {
    name: "negative recordings total",
    accepted: false,
    change: (v) => {
      v.modalities[0].recordings = -1;
    },
  },
  {
    name: "fractional recordings total",
    accepted: false,
    change: (v) => {
      v.modalities[0].recordings += 0.5;
    },
  },
  {
    name: "datasets total too high",
    accepted: false,
    change: (v) => {
      v.modalities[0].datasets += 1;
    },
  },
  {
    name: "fractional datasets total",
    accepted: false,
    change: (v) => {
      v.modalities[0].datasets += 0.5;
    },
  },

  // Bins
  {
    name: "no bins",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins = [];
      fix(v.modalities[0]);
    },
  },
  {
    name: "1024 bins",
    accepted: true,
    change: (v) => {
      const m = v.modalities[0];
      m.bins = Array.from({ length: 1024 }, (_, i) => ({
        channels: i + 1,
        hours: 1,
        recordings: 1,
      }));
      m.dataset_peaks = [{ channels: 1024, datasets: 1 }];
      fix(m);
    },
  },
  {
    name: "1025 bins",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins = Array.from({ length: 1025 }, (_, i) => ({
        channels: i + 1,
        hours: 1,
        recordings: 1,
      }));
      m.dataset_peaks = [{ channels: 1025, datasets: 1 }];
      fix(m);
    },
  },
  {
    name: "bin with one channel",
    accepted: true,
    change: (v) => {
      v.modalities[0].bins[0].channels = 1;
    },
  },
  {
    name: "bin with 100000 channels",
    accepted: true,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[m.bins.length - 1].channels = 100_000;
      m.dataset_peaks[m.dataset_peaks.length - 1].channels = 100_000;
    },
  },
  {
    name: "bin with zero channels",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins[0].channels = 0;
    },
  },
  {
    name: "bin with 100001 channels",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[m.bins.length - 1].channels = 100_001;
      m.dataset_peaks[m.dataset_peaks.length - 1].channels = 100_001;
    },
  },
  {
    name: "bin with 1.5 channels",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins[0].channels = 1.5;
    },
  },
  {
    name: "bin with NaN channels",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins[0].channels = Number.NaN;
    },
  },
  {
    name: "bin with zero hours",
    accepted: true,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].hours = 0;
      fix(m);
    },
  },
  {
    name: "bin with NaN hours",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins[0].hours = Number.NaN;
    },
  },
  {
    name: "bin with negative hours",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].hours = -1;
      fix(m);
    },
  },
  {
    name: "bin with zero recordings",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].recordings = 0;
      fix(m);
    },
  },
  {
    name: "bin with negative recordings",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].recordings = -2;
      fix(m);
    },
  },
  {
    name: "bin with fractional recordings",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].recordings = 1.5;
      fix(m);
    },
  },
  {
    name: "bin with unsafe recordings",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[0].recordings = 2 ** 53;
      fix(m);
    },
  },
  {
    name: "bins out of order",
    accepted: false,
    change: (v) => {
      v.modalities[0].bins.reverse();
    },
  },
  {
    name: "bins with a repeated channel count",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins[1].channels = m.bins[0].channels;
      fix(m);
    },
  },
  // The "out of order" and "repeated" rows near these also trip other rules (a peak with no
  // bin, a largest peak that no longer matches), so on their own they cannot show that the
  // ordering checks exist. These four break only the ordering rule: the largest stays last, every
  // peak keeps its bin, and the totals still add up. Checked by mutation: removing the
  // `<= previous` test for bins, or for peaks, fails them (and weakening it to `<` fails the
  // two "repeated" rows).
  {
    name: "bins swapped with the largest still last",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      [m.bins[0], m.bins[1]] = [m.bins[1], m.bins[0]];
    },
  },
  {
    name: "a repeated bin channel count that has no peak on it",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins.unshift({ ...m.bins[0] }); // bins 1, 1, 6, 16; the peaks are at 6 and 16
      fix(m);
    },
  },
  {
    name: "peaks swapped with the largest still last",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      // Three peaks, each backed by a bin (1, 6 and 16 channels), then the first two swapped.
      m.dataset_peaks = [
        { channels: 1, datasets: 1 },
        { channels: 6, datasets: 1 },
        { channels: 16, datasets: 1 },
      ];
      [m.dataset_peaks[0], m.dataset_peaks[1]] = [m.dataset_peaks[1], m.dataset_peaks[0]];
      fix(m);
    },
  },
  {
    name: "a repeated peak channel count that has a bin",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks = [
        { channels: 1, datasets: 1 },
        { channels: 6, datasets: 1 },
        { channels: 6, datasets: 1 },
        { channels: 16, datasets: 1 },
      ];
      fix(m);
    },
  },
  {
    name: "three ascending peaks, each backed by a bin",
    accepted: true,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks = [
        { channels: 1, datasets: 1 },
        { channels: 6, datasets: 1 },
        { channels: 16, datasets: 1 },
      ];
      fix(m);
    },
  },

  // Dataset peaks
  {
    name: "no peaks",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks = [];
      fix(m);
    },
  },
  {
    name: "1025 peaks",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.bins = Array.from({ length: 1024 }, (_, i) => ({
        channels: i + 1,
        hours: 1,
        recordings: 2,
      }));
      m.dataset_peaks = Array.from({ length: 1025 }, (_, i) => ({ channels: i + 1, datasets: 1 }));
      fix(m);
    },
  },
  {
    name: "peak with zero channels",
    accepted: false,
    change: (v) => {
      v.modalities[0].dataset_peaks[0].channels = 0;
    },
  },
  {
    name: "peak with 100001 channels",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[m.dataset_peaks.length - 1].channels = 100_001;
    },
  },
  {
    name: "peak with 1.5 channels",
    accepted: false,
    change: (v) => {
      v.modalities[0].dataset_peaks[0].channels = 1.5;
    },
  },
  {
    name: "peak with zero datasets",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[0].datasets = 0;
      fix(m);
    },
  },
  {
    name: "peak with negative datasets",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[0].datasets = -1;
      fix(m);
    },
  },
  {
    name: "peak with fractional datasets",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[0].datasets = 1.5;
      fix(m);
    },
  },
  {
    name: "peaks out of order",
    accepted: false,
    change: (v) => {
      v.modalities[0].dataset_peaks.reverse();
    },
  },
  {
    name: "peaks with a repeated channel count",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[1].channels = m.dataset_peaks[0].channels;
      fix(m);
    },
  },
  {
    name: "peak with no bin at its channel count",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks[0].channels = m.bins[0].channels + 1;
    },
  },
  {
    name: "more datasets at a peak than recordings in its bin",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      const last = m.dataset_peaks[m.dataset_peaks.length - 1];
      const bin = m.bins.find((b) => b.channels === last.channels) as Bin;
      last.datasets = bin.recordings + 1;
      v.datasets_scanned = 10_000;
      fix(m);
    },
  },
  {
    name: "as many datasets at a peak as recordings in its bin",
    accepted: true,
    change: (v) => {
      const m = v.modalities[0];
      const first = m.dataset_peaks[0];
      const bin = m.bins.find((b) => b.channels === first.channels) as Bin;
      first.datasets = bin.recordings;
      v.datasets_scanned = 10_000;
      fix(m);
    },
  },
  {
    name: "largest peak below the largest bin",
    accepted: false,
    change: (v) => {
      const m = v.modalities[0];
      m.dataset_peaks = [m.dataset_peaks[0]];
      fix(m);
    },
  },
];

describe("the collector's copies of the contract's constants", () => {
  // The collector cannot import the schema (it needs zod, which a bare checkout lacks), so it
  // copies a few constants. Reading the schema source here makes a drift a failing test.
  const schemaSource = readFileSync(new URL("../src/lib/schema.ts", import.meta.url), "utf8");

  test("the modality-name rule is the schema's, letter for letter", () => {
    const schemaRule = /const modalityNameSchema = z\.string\(\)\.regex\(\/(.+?)\/,/s.exec(
      schemaSource,
    );
    expect(schemaRule?.[1]).toBeDefined();
    expect(MODALITY_NAME.source).toBe(schemaRule?.[1]);
    expect(MODALITY_NAME.flags).toBe("");
  });

  test("names a future converter might emit are refused by both, so they are unmeasured not a 422", () => {
    for (const name of [
      "EEG/EMG",
      "Force Plate",
      "EEG+EMG",
      "a.b",
      "3T",
      "",
      "-x",
      "x".repeat(33),
    ]) {
      const value = structuredClone(ours);
      value.modalities[0].modality = name;
      expect({ name, regex: MODALITY_NAME.test(name), schema: schemaAccepts(value) }).toEqual({
        name,
        regex: false,
        schema: false,
      });
    }
  });

  test("the channel bound, the modality limit and the bin limit are the schema's", () => {
    expect(schemaSource).toContain(
      `z.number().int().min(1).max(${MAX_CHANNELS.toLocaleString("en-US").replaceAll(",", "_")})`,
    );
    expect(schemaSource).toMatch(
      /modalities: z\.array\(ChannelHoursModalitySchema\)\.min\(1\)\.max\(32\)/,
    );
    expect(schemaSource).toMatch(/bins: z\.array\(ChannelHoursBinSchema\)\.min\(1\)\.max\(1024\)/);
    expect(schemaSource).toMatch(
      /dataset_peaks: z\.array\(ChannelHoursDatasetPeakSchema\)\.min\(1\)\.max\(1024\)/,
    );
  });
});

describe("assertChannelHours agrees with SectionIngestSchema", () => {
  test("the unchanged payloads are accepted by both", () => {
    expect(schemaAccepts(ours)).toBe(true);
    expect(assertAccepts(ours)).toBe(true);
    expect(schemaAccepts(contractSample)).toBe(true);
    expect(assertAccepts(contractSample)).toBe(true);
  });

  test("the table is wide enough to mean something", () => {
    expect(cases.length).toBeGreaterThanOrEqual(80);
    expect(cases.filter((c) => c.accepted).length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => !c.accepted).length).toBeGreaterThanOrEqual(60);
  });

  for (const base of [{ label: "from the fixtures", value: ours }]) {
    for (const { name, accepted, change } of cases) {
      test(`${base.label}: ${name}`, () => {
        const value = structuredClone(base.value);
        if (name === "not an object") {
          expect(schemaAccepts("text")).toBe(false);
          expect(assertAccepts("text")).toBe(false);
          expect(assertAccepts(null)).toBe(false);
          expect(assertAccepts([])).toBe(false);
          return;
        }
        change(value);
        expect({ schema: schemaAccepts(value), assert: assertAccepts(value) }).toEqual({
          schema: accepted,
          assert: accepted,
        });
      });
    }
  }

  test("the contract's own real-data sample takes the same mutations the same way", () => {
    const sample = (change: (v: ChannelHours) => void) => {
      const value = structuredClone(contractSample);
      change(value);
      return { schema: schemaAccepts(value), assert: assertAccepts(value) };
    };
    expect(
      sample((v) => {
        v.modalities[0].recordings += 1;
      }),
    ).toEqual({ schema: false, assert: false });
    expect(
      sample((v) => {
        v.modalities[0].bins.reverse();
      }),
    ).toEqual({ schema: false, assert: false });
    expect(
      sample((v) => {
        v.modalities[0].dataset_peaks.pop();
        fix(v.modalities[0]);
      }),
    ).toEqual({
      schema: false,
      assert: false,
    });
  });
});
