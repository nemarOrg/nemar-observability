// Per-dataset summaries of real Zarr indexes. The expected numbers below were
// computed with an independent implementation (plain Python over the same
// files), not with the code under test. Cases the catalog does not currently
// contain (a second group of the same modality, a store with no duration) are
// built by editing a copy of a real index, and each says so.

import { describe, expect, test } from "bun:test";
import { JsonShapeError } from "../scripts/lib/json-stream";
import {
  type DatasetSummary,
  IndexFormatError,
  MAX_CHANNELS,
  MAX_DURATION_HOURS,
  MAX_MODALITIES_PER_STORE,
  MAX_STORE_ENTRY_BYTES,
  MAX_STORE_ENTRY_DEPTH,
  MISC_DATATYPE_FOLDERS,
  groupModality,
  normalizeModality,
  parseDatasetSummary,
  summarizeIndex,
  summarizeIndexStream,
} from "../scripts/lib/zarr-recordings";
import { datasetIdOf, fixtureBytes, fixtureObject } from "./helpers/zarr-fixtures";

type Store = Record<string, unknown> & { groups: Record<string, unknown>[] };
type Index = Record<string, unknown> & { stores: Store[] };

const summarize = (name: string) => summarizeIndex(fixtureObject(name), datasetIdOf(name));

/** A deep copy of a real fixture, for building an edited variant. */
const copyOf = (name: string): Index => structuredClone(fixtureObject(name)) as Index;

const binsOf = (summary: DatasetSummary, modality: string) =>
  summary.modalities
    .find((entry) => entry.modality === modality)
    ?.bins.map((bin) => [bin.channels, bin.seconds, bin.recordings]) ?? [];

/** Channel counts and recordings exactly; seconds to a microsecond (floating-point sums). */
function expectBins(summary: DatasetSummary, modality: string, expected: number[][]) {
  const actual = binsOf(summary, modality);
  expect(actual.map(([channels, , recordings]) => [channels, recordings])).toEqual(
    expected.map(([channels, , recordings]) => [channels, recordings]),
  );
  actual.forEach(([, seconds], index) => {
    expect(seconds).toBeCloseTo(expected[index][1], 6);
  });
}

function streamOf(bytes: Uint8Array, size = 997): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
}

describe("normalizeModality", () => {
  test("shows IEEG as iEEG in any case and keeps everything else as given", () => {
    expect(normalizeModality("IEEG")).toBe("iEEG");
    expect(normalizeModality("ieeg")).toBe("iEEG");
    expect(normalizeModality(" iEEG ")).toBe("iEEG");
    expect(normalizeModality("EEG")).toBe("EEG");
    expect(normalizeModality("MEG")).toBe("MEG");
    expect(normalizeModality("EMG")).toBe("EMG");
    expect(normalizeModality("fNIRS")).toBe("fNIRS");
  });

  test("rejects values that cannot be a modality name", () => {
    expect(normalizeModality("")).toBeNull();
    expect(normalizeModality("   ")).toBeNull();
    expect(normalizeModality(undefined)).toBeNull();
    expect(normalizeModality(7)).toBeNull();
    expect(normalizeModality("x".repeat(33))).toBeNull();
    expect(normalizeModality("EE\nG")).toBeNull();
    expect(normalizeModality("<img src=x onerror=alert(1)>")).toBeNull();
    expect(normalizeModality("EEG</b>")).toBeNull();
    expect(normalizeModality("-EEG")).toBeNull();
    expect(normalizeModality("3T")).toBeNull();
    expect(normalizeModality("EEG EMG")).toBeNull();
    expect(normalizeModality("EEG+EMG")).toBeNull();
    expect(normalizeModality("EEG.1")).toBeNull();
    expect(normalizeModality("ECoG-SEEG")).toBe("ECoG-SEEG");
    expect(normalizeModality("fNIRS_2")).toBe("fNIRS_2");
    expect(normalizeModality("x".repeat(32))).toBe("x".repeat(32));
  });
});

describe("groupModality", () => {
  test("a MISC group takes its BIDS datatype folder as the modality", () => {
    const misc = { modality: "MISC" };
    expect(groupModality(misc, "sub-01/ses-1/ecg/sub-01_ses-1_ecg.edf")).toBe("ECG");
    expect(groupModality(misc, "sub-01/emg/sub-01_emg.edf")).toBe("EMG");
    expect(groupModality(misc, "sub-01/ieeg/sub-01_ieeg.edf")).toBe("iEEG");
    expect(groupModality({ modality: "misc" }, "sub-01/eeg/sub-01_eeg.set")).toBe("EEG");
  });

  test("a MISC group in an unrecognized folder stays MISC", () => {
    const misc = { modality: "MISC" };
    expect(groupModality(misc, "sub-01/eye_tracker/sub-01_eyetrack.edf")).toBe("MISC");
    expect(groupModality(misc, "sub-01/mov/sub-01_mov.edf")).toBe("MISC");
    expect(groupModality(misc, "sub-01/func/sub-01_bold.nii")).toBe("MISC");
    expect(groupModality(misc, "file.edf")).toBe("MISC");
    expect(groupModality(misc, undefined)).toBe("MISC");
  });

  test("a group that names a real modality ignores the folder", () => {
    expect(groupModality({ modality: "EEG" }, "sub-01/ecg/sub-01_ecg.edf")).toBe("EEG");
    expect(groupModality({ modality: "IEEG" }, "sub-01/eeg/sub-01_eeg.edf")).toBe("iEEG");
    expect(groupModality({}, "sub-01/ecg/sub-01_ecg.edf")).toBeNull();
  });
});

describe("summaries of real indexes", () => {
  test("nm000118: nine EEG recordings, one channel count", () => {
    const summary = summarize("nm000118");
    expectBins(summary, "EEG", [[8, 7682.328, 9]]);
    expect(summary).toMatchObject({
      stores: 9,
      measuredStores: 9,
      unmeasured: 0,
      unmeasuredStores: 0,
      excluded: 0,
      failed: 0,
      pending: 0,
      multiGroupStores: 0,
      multiModalityStores: 0,
    });
    expect(summary.storeSeconds).toBeCloseTo(7682.328, 6);
  });

  test("on004457: iEEG recordings fall into five exact channel counts", () => {
    const summary = summarize("on004457");
    expect(summary.modalities.map((entry) => entry.modality)).toEqual(["iEEG"]);
    expectBins(summary, "iEEG", [
      [135, 3263.354, 1],
      [178, 3481.41, 1],
      [192, 4962.968, 1],
      [194, 4126.909, 1],
      [206, 4418.784, 1],
    ]);
    expect(summary.storeSeconds).toBeCloseTo(20253.425, 6);
  });

  test("nm000105: one hundred EMG recordings", () => {
    const summary = summarize("nm000105");
    expectBins(summary, "EMG", [[16, 230225, 100]]);
    expect(summary.measuredStores).toBe(100);
  });

  test("on000117: MEG with three channel counts and two failed recordings", () => {
    const summary = summarize("on000117");
    expectBins(summary, "MEG", [
      [321, 450, 2],
      [325, 581, 4],
      [395, 47508, 96],
    ]);
    expect(summary.failed).toBe(2);
    expect(summary.pending).toBe(0);
    expect(summary.storeSeconds).toBe(48539);
  });

  test("on005065 (trimmed): MEG with failed and pending recordings counted separately", () => {
    const summary = summarize("on005065-trimmed");
    expectBins(summary, "MEG", [[415, 1262.84, 3]]);
    expect(summary.failed).toBe(2);
    expect(summary.pending).toBe(2);
  });

  test("on005873 (trimmed): MISC ECG becomes ECG, and a store with EEG and EMG counts once overall", () => {
    const summary = summarize("on005873-trimmed");
    expect(summary.modalities.map((entry) => entry.modality)).toEqual(["ECG", "EEG", "EMG"]);
    expectBins(summary, "ECG", [[1, 85135, 2]]);
    expectBins(summary, "EEG", [
      [2, 85135, 2],
      [6, 164727, 4],
    ]);
    expectBins(summary, "EMG", [
      [1, 85135, 2],
      [6, 166508, 4],
    ]);
    // 11 real stores; three hold two groups (EEG and EMG), so they are counted
    // in both modalities but only once in the store totals.
    expect(summary.stores).toBe(11);
    expect(summary.measuredStores).toBe(11);
    expect(summary.multiGroupStores).toBe(3);
    expect(summary.multiModalityStores).toBe(3);
    expect(summary.storeSeconds).toBe(436526);
    const modalitySeconds = summary.modalities
      .flatMap((entry) => entry.bins)
      .reduce((total, bin) => total + bin.seconds, 0);
    expect(modalitySeconds).toBeGreaterThan(summary.storeSeconds);
    const modalityRecordings = summary.modalities
      .flatMap((entry) => entry.bins)
      .reduce((total, bin) => total + bin.recordings, 0);
    expect(modalityRecordings).toBe(14);
  });

  test("on006012 (trimmed): stores flagged derived are skipped, not counted as recordings", () => {
    const summary = summarize("on006012-trimmed");
    expect(summary.modalities).toEqual([]);
    expect(summary).toMatchObject({
      stores: 4,
      excluded: 4,
      measuredStores: 0,
      unmeasuredStores: 0,
      unmeasured: 0,
      failed: 2,
    });
  });
});

describe("the streaming summary", () => {
  for (const name of [
    "nm000118",
    "on004457",
    "nm000105",
    "on000117",
    "on005873-trimmed",
    "on006012-trimmed",
    "on005065-trimmed",
  ]) {
    test(`${name}: equals the plain parse for any chunking`, async () => {
      const expected = summarize(name);
      for (const size of [1, 64, 997, fixtureBytes(name).length]) {
        if (size === 1 && fixtureBytes(name).length > 20_000) continue;
        expect(
          await summarizeIndexStream(streamOf(fixtureBytes(name), size), datasetIdOf(name)),
        ).toEqual(expected);
      }
    });
  }

  test("reads the root counters wherever they sit in the document", async () => {
    // A copy of a real index with `failure_count` moved after `stores`.
    const index = copyOf("on000117");
    const { failure_count, ...rest } = index;
    const reordered = { ...rest, failure_count } as Index;
    const text = new TextEncoder().encode(JSON.stringify(reordered));
    expect((await summarizeIndexStream(streamOf(text), "on000117")).failed).toBe(2);
  });
});

describe("rules for stores the catalog does not yet contain", () => {
  test("within one store, one modality: the longest group and the most channels, counted once", () => {
    // Constructed from a copy of nm000118: store 0 gets a second EEG group
    // (a concurrent stream at another rate) with more channels and a longer
    // duration, and store 1 gets a shorter second group with fewer channels.
    const index = copyOf("nm000118");
    index.stores[0].groups.push({
      ...index.stores[0].groups[0],
      name: "eeg_500hz",
      rate: 500,
      n_channels: 16,
      duration_s: 1000,
    });
    index.stores[1].groups.push({
      ...index.stores[1].groups[0],
      name: "eeg_125hz",
      rate: 125,
      n_channels: 4,
      duration_s: 100,
    });
    const summary = summarizeIndex(index, "nm000118");
    // Store 0: max duration 1000 (not 853.592 + 1000), max channels 16.
    // Store 1: max duration 853.592 (not + 100), max channels 8.
    // Stores 2..8 are unchanged: eight stores at 8 channels in total.
    expect(summary.modalities).toHaveLength(1);
    const bins = binsOf(summary, "EEG") as number[][];
    expect(bins.map(([channels]) => channels)).toEqual([8, 16]);
    expect(bins[1]).toEqual([16, 1000, 1]);
    expect(bins[0][2]).toBe(8);
    expect(bins[0][1]).toBeCloseTo(7682.328 - 853.592, 6);
    expect(summary.measuredStores).toBe(9);
    expect(summary.storeSeconds).toBeCloseTo(7682.328 - 853.592 + 1000, 6);
    expect(summary.multiGroupStores).toBe(2);
    expect(summary.multiModalityStores).toBe(0);
  });

  test("a store with two modalities is counted once in each, and once overall by its longest", () => {
    // Constructed from a copy of nm000118: store 0 gets a concurrent EMG group.
    const index = copyOf("nm000118");
    index.stores[0].groups.push({
      ...index.stores[0].groups[0],
      name: "emg_1000hz",
      modality: "EMG",
      n_channels: 4,
      duration_s: 900,
    });
    const summary = summarizeIndex(index, "nm000118");
    expectBins(summary, "EMG", [[4, 900, 1]]);
    expect(summary.measuredStores).toBe(9);
    expect(summary.multiModalityStores).toBe(1);
    // The store's overall duration is its longest measured modality: 900 s from
    // the EMG group exceeds the EEG group's 853.592 s.
    expect(summary.storeSeconds).toBeCloseTo(7682.328 - 853.592 + 900, 6);
  });

  test("derived stores and stores from another source tree are excluded; an absent tree is raw", () => {
    // Constructed from a copy of nm000118 (all nine stores are raw there).
    const index = copyOf("nm000118");
    index.stores[0].derived = true;
    index.stores[1].source_tree = "derivatives";
    index.stores[2].source_tree = "sourcedata";
    index.stores[3].derived = "yes";
    // Absent on purpose: a store with no source tree is read as raw.
    Reflect.deleteProperty(index.stores[4], "source_tree");
    index.stores[5].derived = null;
    const summary = summarizeIndex(index, "nm000118");
    expect(summary.excluded).toBe(4);
    expect(summary.measuredStores).toBe(5);
    expect(summary.stores).toBe(9);
    expectBins(summary, "EEG", [[8, 5 * 853.592, 5]]);
  });

  test("a recording without a usable duration or channel count is unmeasured, never zero", () => {
    // Constructed from a copy of nm000118.
    const index = copyOf("nm000118");
    index.stores[0].groups[0].duration_s = null;
    index.stores[1].groups[0].n_channels = undefined;
    index.stores[2].groups[0].duration_s = -5;
    index.stores[3].groups[0].n_channels = 0;
    index.stores[4].groups[0].n_channels = 12.5;
    index.stores[5].groups[0].duration_s = "853.592";
    index.stores[6].groups = [];
    Reflect.deleteProperty(index.stores[7], "groups");
    index.stores[8].groups[0].modality = "";
    const summary = summarizeIndex(index, "nm000118");
    expect(summary.unmeasured).toBe(9);
    expect(summary.unmeasuredStores).toBe(9);
    expect(summary.measuredStores).toBe(0);
    expect(summary.storeSeconds).toBe(0);
    expect(summary.modalities).toEqual([]);
  });

  test("a zero-length recording is measured: zero is a value, not a gap", () => {
    const index = copyOf("nm000118");
    index.stores[0].groups[0].duration_s = 0;
    const summary = summarizeIndex(index, "nm000118");
    expect(summary.unmeasured).toBe(0);
    expect(summary.measuredStores).toBe(9);
    expectBins(summary, "EEG", [[8, 8 * 853.592, 9]]);
  });

  test("one unusable modality in a two-modality store leaves the other measured", () => {
    // Constructed from a copy of nm000118: store 0 gets an EMG group with no duration.
    const index = copyOf("nm000118");
    index.stores[0].groups.push({
      ...index.stores[0].groups[0],
      modality: "EMG",
      duration_s: null,
    });
    const summary = summarizeIndex(index, "nm000118");
    expect(summary.unmeasured).toBe(1);
    expect(summary.unmeasuredStores).toBe(0);
    expect(summary.measuredStores).toBe(9);
    expect(summary.modalities.map((entry) => entry.modality)).toEqual(["EEG"]);
  });

  test("a group with no modality is ignored when another group of the store names one", () => {
    const index = copyOf("nm000118");
    index.stores[0].groups.push({
      ...index.stores[0].groups[0],
      modality: undefined,
      n_channels: 99,
    });
    const summary = summarizeIndex(index, "nm000118");
    expectBins(summary, "EEG", [[8, 7682.328, 9]]);
    expect(summary.unmeasured).toBe(0);
  });

  test("the producer's failure and pending counts win over the list lengths", () => {
    // Constructed from a copy of on005065-trimmed: counters edited, lists unchanged.
    const index = copyOf("on005065-trimmed");
    index.failure_count = 40;
    index.pending_count = 7;
    expect(summarizeIndex(index, "on005065")).toMatchObject({ failed: 40, pending: 7 });
    index.failure_count = "many";
    Reflect.deleteProperty(index, "pending_count");
    expect(summarizeIndex(index, "on005065")).toMatchObject({ failed: 2, pending: 2 });
  });

  test("an index with no stores still summarizes to an empty dataset", () => {
    const index = copyOf("nm000118");
    index.stores = [];
    index.store_count = 0;
    expect(summarizeIndex(index, "nm000118")).toMatchObject({
      modalities: [],
      stores: 0,
      measuredStores: 0,
    });
  });
});

describe("documents that are not a usable index", () => {
  test("a different format, a different dataset, or no stores list is refused", () => {
    const wrongFormat = { ...copyOf("nm000118"), format: "something-else" };
    expect(() => summarizeIndex(wrongFormat, "nm000118")).toThrow(IndexFormatError);
    expect(() => summarizeIndex(copyOf("nm000118"), "nm000999")).toThrow("different dataset");
    const noStores = copyOf("nm000118") as Record<string, unknown>;
    Reflect.deleteProperty(noStores, "stores");
    expect(() => summarizeIndex(noStores, "nm000118")).toThrow("no stores list");
    expect(() => summarizeIndex([], "nm000118")).toThrow(IndexFormatError);
  });

  test("the same checks apply to a streamed document", async () => {
    const wrongId = fixtureBytes("nm000118");
    await expect(summarizeIndexStream(streamOf(wrongId), "nm000999")).rejects.toThrow(
      IndexFormatError,
    );
    const html = new TextEncoder().encode("<html><body>Access denied</body></html>");
    await expect(summarizeIndexStream(streamOf(html), "nm000118")).rejects.toThrow(
      "not a JSON object",
    );
    const badStore = new TextEncoder().encode('{"format":"nemar-zarr-index","stores":[{"a":}]}');
    await expect(summarizeIndexStream(streamOf(badStore), "nm000118")).rejects.toThrow(
      "not valid JSON",
    );
  });
});

describe("cached summaries", () => {
  test("a summary survives a JSON round trip unchanged", () => {
    for (const name of ["on004457", "on005873-trimmed", "on005065-trimmed"]) {
      const summary = summarize(name);
      expect(parseDatasetSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    }
  });

  test("anything with the wrong shape is refused rather than trusted", () => {
    const good = JSON.parse(JSON.stringify(summarize("on005873-trimmed")));
    const broken = (change: (summary: typeof good) => void) => {
      const copy = structuredClone(good);
      change(copy);
      return parseDatasetSummary(copy);
    };
    expect(parseDatasetSummary(null)).toBeNull();
    expect(parseDatasetSummary([])).toBeNull();
    expect(
      broken((s) => {
        Reflect.deleteProperty(s, "measuredStores");
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.stores = -1;
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.storeSeconds = "1";
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].bins[0].channels = 0;
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].bins[0].seconds = -1;
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].bins[0].recordings = 1.5;
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].bins.push({ ...s.modalities[0].bins[0] });
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities.push({ ...s.modalities[0] });
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].bins = [];
      }),
    ).toBeNull();
    expect(
      broken((s) => {
        s.modalities[0].modality = "ecg ";
      }),
    ).toBeNull();
  });
});
