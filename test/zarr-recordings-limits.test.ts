// The rules that keep a corrupt, hostile, or merely unusual index from changing
// what is published: the contract's modality names, the channel and duration
// bounds, the format and count checks, and the size and depth limits on one
// store entry. Indexes are untrusted input, so each case here is built by
// editing a copy of a real fixture (the catalog contains none of them) and says
// what it changes.

import { describe, expect, test } from "bun:test";
import { JsonShapeError } from "../scripts/lib/json-stream";
import { aggregateOutcomes, recordingsSection } from "../scripts/lib/zarr-aggregate";
import {
  type DatasetSummary,
  IndexFormatError,
  MAX_CHANNELS,
  MAX_CHANNEL_COUNTS_PER_MODALITY,
  MAX_DURATION_HOURS,
  MAX_MODALITIES_PER_STORE,
  MAX_STORE_ENTRY_BYTES,
  MAX_STORE_ENTRY_DEPTH,
  MISC_DATATYPE_FOLDERS,
  groupModality,
  parseDatasetSummary,
  summarizeIndex,
  summarizeIndexStream,
} from "../scripts/lib/zarr-recordings";
import { SectionIngestSchema } from "../src/lib/schema";
import { fixtureObject } from "./helpers/zarr-fixtures";

type Store = Record<string, unknown> & { groups: Record<string, unknown>[] };
type Index = Record<string, unknown> & { stores: Store[] };

/** A deep copy of nm000118 (nine real EEG stores, 8 channels, 853.592 s each). */
const copy = (): Index => structuredClone(fixtureObject("nm000118")) as Index;
const summarize = (index: Index) => summarizeIndex(index, "nm000118");

const streamOfText = (text: string, size = 64 * 1024): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
};

/** The root of a version-3 index around a hand-written `stores` array. */
const indexText = (storesJson: string, extra = ""): string =>
  `{"format":"nemar-zarr-index","format_version":3,"dataset_id":"nm000118",${extra}"stores":[${storesJson}]}`;

describe("modality attribution under the contract's names", () => {
  test("a MISC group takes each of the eight datatype folders, and no other folder", () => {
    const expected: Record<string, string> = {
      ecg: "ECG",
      eeg: "EEG",
      emg: "EMG",
      eog: "EOG",
      ieeg: "iEEG",
      meg: "MEG",
      nirs: "NIRS",
      motion: "MOTION",
    };
    expect([...MISC_DATATYPE_FOLDERS].sort()).toEqual(Object.keys(expected).sort());
    for (const [folder, modality] of Object.entries(expected)) {
      expect(groupModality({ modality: "MISC" }, `sub-01/${folder}/sub-01_x.edf`)).toBe(modality);
      expect(groupModality({ modality: "MISC" }, `sub-01/${folder.toUpperCase()}/x.edf`)).toBe(
        modality,
      );
    }
    for (const folder of ["func", "anat", "beh", "mov", "eye_tracker", "physio", ""]) {
      expect(groupModality({ modality: "MISC" }, `sub-01/${folder}/x.edf`)).toBe("MISC");
    }
  });

  test("names outside the contract's rule are unmeasured, never an error for the run", () => {
    // Changes nm000118: seven stores get a modality the contract would reject
    // (names a future converter could plausibly emit among them).
    const index = copy();
    const bad = ["EEG EMG", "<b>EEG</b>", "3T", "x".repeat(33), "EEG.1", "EEG/EMG", "Force Plate"];
    bad.forEach((name, i) => {
      index.stores[i].groups[0].modality = name;
    });
    const summary = summarize(index);
    expect(summary.unmeasured).toBe(7);
    expect(summary.unmeasuredStores).toBe(7);
    expect(summary.measuredStores).toBe(2);
    // And the section built from it is still valid for the Worker.
    const aggregate = aggregateOutcomes(1, [
      { id: "nm000118", kind: "summary", summary, from: "network" },
    ]);
    expect(SectionIngestSchema.safeParse(recordingsSection(aggregate)).success).toBe(true);
    expect(aggregate.unmeasuredRecordings).toBe(7);
  });

  test("a store naming more than 32 distinct modalities is one unmeasured recording", () => {
    // Changes nm000118: store 0 gets 33 groups with distinct plain names, store 1 gets exactly 32.
    const index = copy();
    const groupsNamed = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...index.stores[0].groups[0],
        modality: `M${String(i).padStart(2, "0")}`,
      }));
    index.stores[0].groups = groupsNamed(MAX_MODALITIES_PER_STORE + 1);
    index.stores[1].groups = groupsNamed(MAX_MODALITIES_PER_STORE);
    const summary = summarize(index);
    expect(summary.unmeasuredStores).toBe(1);
    expect(summary.unmeasured).toBe(1);
    expect(summary.measuredStores).toBe(8);
    expect(summary.modalities).toHaveLength(MAX_MODALITIES_PER_STORE + 1); // 32 from store 1 plus EEG
  });

  test("more than 32 modalities across a section keep the largest 32 and count the rest as unmeasured", () => {
    // Datasets whose summaries name 40 distinct modalities, with hours rising by name.
    const summaries = Array.from({ length: 40 }, (_, i): DatasetSummary => {
      const modality = `M${String(i).padStart(2, "0")}`;
      return {
        modalities: [{ modality, bins: [{ channels: 4, seconds: 3600 * (i + 1), recordings: 2 }] }],
        stores: 2,
        excluded: 0,
        measuredStores: 2,
        storeSeconds: 3600 * (i + 1),
        unmeasuredStores: 0,
        unmeasured: 0,
        implausible: 0,
        unusableModalities: [],
        failed: 0,
        pending: 0,
        multiGroupStores: 0,
        multiModalityStores: 0,
      };
    });
    const aggregate = aggregateOutcomes(
      40,
      summaries.map((summary, i) => ({
        id: `nm${String(i).padStart(6, "0")}`,
        kind: "summary" as const,
        summary,
        from: "network" as const,
      })),
    );
    expect(aggregate.modalities).toHaveLength(32);
    expect(aggregate.modalities[0].modality).toBe("M39");
    expect(aggregate.droppedModalities).toBe(8);
    expect(aggregate.unmeasuredRecordings).toBe(16);
    expect(aggregate.modalityRecordings).toBe(64);
    expect(SectionIngestSchema.safeParse(recordingsSection(aggregate)).success).toBe(true);
  });

  test("groups whose names differ only in case are one stream in a store", () => {
    // Changes nm000118: store 0 gets an "eeg" group beside its "EEG" group, with more channels and a longer duration.
    const index = copy();
    index.stores[0].groups.push({
      ...index.stores[0].groups[0],
      modality: "eeg",
      n_channels: 16,
      duration_s: 1000,
    });
    const summary = summarize(index);
    expect(summary.modalities.map((m) => m.modality)).toEqual(["EEG"]);
    expect(summary.modalities[0].bins.map((b) => [b.channels, b.recordings])).toEqual([
      [8, 8],
      [16, 1],
    ]);
    expect(summary.measuredStores).toBe(9);
    expect(summary.multiModalityStores).toBe(0);
  });
});

describe("a modality with too many distinct channel counts", () => {
  /** nm000118 with `count` stores, store i having i + 1 channels (an edited copy of a real index). */
  const withChannelCounts = (count: number): Index => {
    const index = copy();
    const [store] = index.stores;
    index.stores = Array.from({ length: count }, (_, i) => ({
      ...structuredClone(store),
      groups: [{ ...structuredClone(store.groups[0]), n_channels: i + 1 }],
    }));
    index.store_count = count;
    return index;
  };

  test("512 distinct counts in one dataset are kept and 513 leave the modality out of that dataset", () => {
    expect(MAX_CHANNEL_COUNTS_PER_MODALITY).toBe(512);
    const kept = summarize(withChannelCounts(512));
    expect(kept.modalities[0].bins).toHaveLength(512);
    expect(kept.unusableModalities).toEqual([]);
    expect(kept.unmeasured).toBe(0);

    const left = summarize(withChannelCounts(513));
    expect(left.modalities).toEqual([]);
    expect(left.unusableModalities).toEqual(["EEG"]);
    // Its 513 recordings are unmeasured for the breakdown; the stores still have durations.
    expect(left.unmeasured).toBe(513);
    expect(left.measuredStores).toBe(513);
    expect(left.storeSeconds).toBeCloseTo(513 * 853.592, 6);
  });

  test("only the over-wide modality is left out; another in the same dataset stays", () => {
    const index = withChannelCounts(513);
    // Edit a copy: ten stores also carry an EMG group at one channel count.
    for (const store of index.stores.slice(0, 10)) {
      store.groups.push({ ...store.groups[0], modality: "EMG", n_channels: 4 });
    }
    const summary = summarize(index);
    expect(summary.modalities.map((m) => m.modality)).toEqual(["EMG"]);
    expect(summary.unusableModalities).toEqual(["EEG"]);
    expect(summary.unmeasured).toBe(513);
  });

  test("a dataset like that cannot fail the run: the section is still valid and says what happened", () => {
    const wide = summarize(withChannelCounts(513));
    const fine = summarizeIndex(fixtureObject("nm000105"), "nm000105");
    const aggregate = aggregateOutcomes(2, [
      { id: "nm000118", kind: "summary", summary: wide, from: "network" },
      { id: "nm000105", kind: "summary", summary: fine, from: "network" },
    ]);
    const section = recordingsSection(aggregate);
    expect(SectionIngestSchema.safeParse(section).success).toBe(true);
    expect(section.channel_hours?.modalities.map((m) => m.modality)).toEqual(["EMG"]);
    expect(section.channel_hours?.recordings_unmeasured).toBe(513);
  });

  test("many datasets whose counts add up past 1024 bins leave that modality out of the section", () => {
    // Three datasets of 400 distinct counts each, none overlapping: 1200 bins in all.
    const summaryWith = (from: number): DatasetSummary => ({
      modalities: [
        {
          modality: "EEG",
          bins: Array.from({ length: 400 }, (_, i) => ({
            channels: from + i,
            seconds: 3600,
            recordings: 1,
          })),
        },
      ],
      stores: 400,
      excluded: 0,
      measuredStores: 400,
      storeSeconds: 3600 * 400,
      unmeasuredStores: 0,
      unmeasured: 0,
      implausible: 0,
      unusableModalities: [],
      failed: 0,
      pending: 0,
      multiGroupStores: 0,
      multiModalityStores: 0,
    });
    const fine = summarizeIndex(fixtureObject("nm000105"), "nm000105");
    const aggregate = aggregateOutcomes(4, [
      { id: "nm000001", kind: "summary", summary: summaryWith(1), from: "network" },
      { id: "nm000002", kind: "summary", summary: summaryWith(401), from: "network" },
      { id: "nm000003", kind: "summary", summary: summaryWith(801), from: "network" },
      { id: "nm000105", kind: "summary", summary: fine, from: "network" },
    ]);
    expect(aggregate.modalities.map((m) => m.modality)).toEqual(["EMG"]);
    expect(aggregate.droppedModalities).toBe(1);
    expect(aggregate.unmeasuredRecordings).toBe(1200);
    expect(SectionIngestSchema.safeParse(recordingsSection(aggregate)).success).toBe(true);
    // 1024 bins in total is still fine.
    const exactly = aggregateOutcomes(3, [
      { id: "nm000001", kind: "summary", summary: summaryWith(1), from: "network" },
      { id: "nm000002", kind: "summary", summary: summaryWith(401), from: "network" },
      { id: "nm000105", kind: "summary", summary: fine, from: "network" },
    ]);
    expect(exactly.modalities.map((m) => m.modality)).toContain("EEG");
  });

  test("the cached form of a summary carries the list, and a malformed list is refused", () => {
    const left = summarize(withChannelCounts(513));
    expect(parseDatasetSummary(JSON.parse(JSON.stringify(left)))).toEqual(left);
    const bad = JSON.parse(JSON.stringify(left));
    bad.unusableModalities = ["not a name"];
    expect(parseDatasetSummary(bad)).toBeNull();
    Reflect.deleteProperty(bad, "unusableModalities");
    expect(parseDatasetSummary(bad)).toBeNull();
  });
});

describe("channel and duration bounds", () => {
  const withGroup = (change: Record<string, unknown>) => {
    const index = copy();
    Object.assign(index.stores[0].groups[0], change);
    return summarize(index);
  };

  test("100000 channels is measured and 100001 is not; so are 0, 1.5, text, and absent", () => {
    expect(MAX_CHANNELS).toBe(100_000);
    expect(withGroup({ n_channels: 100_000 }).measuredStores).toBe(9);
    expect(withGroup({ n_channels: 100_000 }).modalities[0].bins.at(-1)?.channels).toBe(100_000);
    expect(withGroup({ n_channels: 1 }).measuredStores).toBe(9);
    for (const value of [100_001, 0, -1, 1.5, "64", null, Number.NaN]) {
      const summary = withGroup({ n_channels: value });
      expect({ value, unmeasured: summary.unmeasured }).toEqual({ value, unmeasured: 1 });
      expect(summary.measuredStores).toBe(8);
    }
  });

  test("a duration of exactly 10000 hours is measured; one second more is a corrupt value", () => {
    expect(MAX_DURATION_HOURS).toBe(10_000);
    const ok = withGroup({ duration_s: 10_000 * 3600 });
    expect(ok.measuredStores).toBe(9);
    expect(ok.implausible).toBe(0);
    const corrupt = withGroup({ duration_s: 10_000 * 3600 + 1 });
    expect(corrupt.measuredStores).toBe(8);
    expect(corrupt.unmeasured).toBe(1);
    expect(corrupt.implausible).toBe(1);
    // It does not add years to the total either.
    expect(corrupt.storeSeconds).toBeCloseTo(8 * 853.592, 6);
    const infinite = withGroup({ duration_s: 1e308 });
    expect(infinite.implausible).toBe(1);
  });
});

describe("what the index declares about itself", () => {
  test("only format_version 3 is read, in either reading path", async () => {
    for (const version of [1, 2, 4, 3.5, "3", null, undefined]) {
      const index = copy();
      if (version === undefined) Reflect.deleteProperty(index, "format_version");
      else index.format_version = version;
      expect(() => summarize(index)).toThrow(IndexFormatError);
      expect(() => summarize(index)).toThrow("format_version");
      await expect(
        summarizeIndexStream(streamOfText(JSON.stringify(index)), "nm000118"),
      ).rejects.toThrow(IndexFormatError);
    }
    expect(summarize(copy()).measuredStores).toBe(9);
  });

  test("a store_count that disagrees with the stores listed means the file is cut or corrupt", async () => {
    for (const declared of [8, 10, 0]) {
      const index = copy();
      index.store_count = declared;
      expect(() => summarize(index)).toThrow(`declares ${declared} stores but lists 9`);
      await expect(
        summarizeIndexStream(streamOfText(JSON.stringify(index)), "nm000118"),
      ).rejects.toThrow("may be truncated");
    }
    // A missing or non-numeric count is not a disagreement.
    const absent = copy();
    Reflect.deleteProperty(absent, "store_count");
    expect(summarize(absent).measuredStores).toBe(9);
    const textual = copy();
    textual.store_count = "nine";
    expect(summarize(textual).measuredStores).toBe(9);
  });

  test("a root key that appears twice is refused, whichever copy JSON.parse would keep", async () => {
    const stores = JSON.stringify(copy().stores);
    const twice = `{"format":"nemar-zarr-index","format_version":3,"stores":${stores},"stores":[]}`;
    await expect(summarizeIndexStream(streamOfText(twice), "nm000118")).rejects.toThrow(
      'repeats the key "stores"',
    );
    const countTwice = `{"format":"nemar-zarr-index","format_version":3,"failure_count":0,"failure_count":99,"stores":[]}`;
    await expect(summarizeIndexStream(streamOfText(countTwice), "nm000118")).rejects.toThrow(
      JsonShapeError,
    );
  });
});

describe("one hostile store entry", () => {
  test("an entry larger than the cap is refused at any chunk size", async () => {
    // One store whose events metadata is a single string just over the cap.
    const text = indexText(`{"x":"${"y".repeat(MAX_STORE_ENTRY_BYTES + 10)}"}`);
    for (const size of [64 * 1024, 1_000_003, text.length]) {
      await expect(summarizeIndexStream(streamOfText(text, size), "nm000118")).rejects.toThrow(
        "larger than",
      );
    }
  });

  test("an entry just under the cap is read", async () => {
    const filler = "y".repeat(MAX_STORE_ENTRY_BYTES - 1_000);
    const text = indexText(`{"path":"sub-1/eeg/x_eeg.set","groups":[],"x":"${filler}"}`);
    const summary = await summarizeIndexStream(streamOfText(text), "nm000118");
    expect(summary).toMatchObject({ stores: 1, unmeasuredStores: 1 });
  });

  test("an entry at the cap made of millions of tiny objects is read and dropped, four at a time", async () => {
    // The worst a corrupt index can ask of JSON.parse within the cap: about 5.6 million
    // empty objects in one array. Four such streams at once (the collector's default).
    const unit = "{},";
    const entry = `{"x":[${unit.repeat(Math.floor((MAX_STORE_ENTRY_BYTES - 200) / unit.length) - 1)}{}]}`;
    expect(entry.length).toBeLessThan(MAX_STORE_ENTRY_BYTES);
    const text = indexText(entry);
    const summaries = await Promise.all(
      [1, 2, 3, 4].map(() => summarizeIndexStream(streamOfText(text), "nm000118")),
    );
    for (const summary of summaries)
      expect(summary).toMatchObject({ stores: 1, unmeasuredStores: 1 });
  });

  test("nesting past 64 levels inside an entry is refused before it is buffered", async () => {
    const nested = (levels: number) => `{"x":${"[".repeat(levels)}${"]".repeat(levels)}}`; // the object is level 1
    const accepted = nested(MAX_STORE_ENTRY_DEPTH - 1);
    expect(await summarizeIndexStream(streamOfText(indexText(accepted)), "nm000118")).toMatchObject(
      { stores: 1 },
    );
    for (const size of [1, 64, 64 * 1024]) {
      await expect(
        summarizeIndexStream(
          streamOfText(indexText(nested(MAX_STORE_ENTRY_DEPTH)), size),
          "nm000118",
        ),
      ).rejects.toThrow("nests deeper");
    }
  });

  test("a million open brackets is refused at once, not accumulated", async () => {
    // A hostile entry that never closes: 1 MB of '['. The depth limit stops it at the 65th.
    const hostile = `{"format":"nemar-zarr-index","format_version":3,"stores":[{"x":${"[".repeat(1_000_000)}`;
    await expect(summarizeIndexStream(streamOfText(hostile), "nm000118")).rejects.toThrow(
      "nests deeper",
    );
  });
});
