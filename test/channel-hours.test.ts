// The recorded-hours explorer's arithmetic and wording, run as the page runs
// it (the client modules evaluated in page order). Expected values are summed
// here straight from the real fixture, independently of the code under test.

import { describe, expect, test } from "bun:test";
import sample from "./fixtures/channel-hours.sample.json";
import snapshotFixture from "./fixtures/snapshot-2026-09-28.json";
import { clientLogic } from "./helpers/client-logic";

const {
  partShare,
  thresholdText,
  measureFigure,
  hoursClaim,
  hoursShareLine,
  hoursFacts,
  channelHoursText,
  tableHours,
  hoursTableRows,
  findChannelHours,
  prepareModalities,
  atLeast,
  channelSeries,
  axisMaxFor,
  axisPowers,
  channelStops,
  stepStop,
  stepPower,
  nearestStop,
  parseHoursHash,
  hoursHash,
} = clientLogic([
  "partShare",
  "thresholdText",
  "measureFigure",
  "hoursClaim",
  "hoursShareLine",
  "hoursFacts",
  "channelHoursText",
  "tableHours",
  "hoursTableRows",
  "findChannelHours",
  "prepareModalities",
  "atLeast",
  "channelSeries",
  "axisMaxFor",
  "axisPowers",
  "channelStops",
  "stepStop",
  "stepPower",
  "nearestStop",
  "parseHoursHash",
  "hoursHash",
]);

type RawModality = (typeof sample.modalities)[number];
const raw = (name: string): RawModality => {
  const m = sample.modalities.find((x) => x.modality === name);
  if (!m) throw new Error(`fixture has no ${name}`);
  return m;
};
// The reference answer, summed directly from the fixture's JSON.
function reference(m: RawModality, min: number) {
  const bins = m.bins.filter((b) => b.channels >= min);
  return {
    hours: bins.reduce((s, b) => s + b.hours, 0),
    recordings: bins.reduce((s, b) => s + b.recordings, 0),
    datasets: m.dataset_peaks.filter((p) => p.channels >= min).reduce((s, p) => s + p.datasets, 0),
    channelHours: bins.reduce((s, b) => s + b.hours * b.channels, 0),
  };
}
const modalities = prepareModalities(sample);
const byKey = (key: string) => modalities.find((m: { key: string }) => m.key === key);

describe("shares", () => {
  test("shares never show 0% for a sliver or 100% short of the whole", () => {
    expect(partShare(5, 0)).toBe("");
    // 3.6 of 4,646 EEG hours is 0.08%.
    expect(partShare(reference(raw("EEG"), 256).hours, raw("EEG").hours)).toBe("<0.1%");
    expect(partShare(raw("EEG").hours - 0.01, raw("EEG").hours)).toBe(">99.9%");
    // Floating-point noise from summing is still the whole.
    expect(partShare(raw("EEG").hours * (1 - 1e-12), raw("EEG").hours)).toBe("100%");
    expect(partShare(reference(raw("EEG"), 16).hours, raw("EEG").hours)).toBe("52.6%");
  });
});

describe("finding the payload", () => {
  const base = snapshotFixture.response;
  const recordings = {
    key: "recordings",
    label: "Recorded hours",
    source: "nemar-zarr-index",
    updated_at: base.generated_at,
    metrics: [{ key: "recordings.hours", label: "Recorded hours", value: 1, unit: "hours" }],
  };

  test("a snapshot from before the collector says it is missing", () => {
    expect(findChannelHours(base).state).toBe("missing");
    expect(findChannelHours(null).state).toBe("missing");
  });

  test("a section without hours this run is told apart from a missing one", () => {
    const snap = { ...base, sections: [...base.sections, recordings] };
    expect(findChannelHours(snap).state).toBe("no-payload");
  });

  test("a well-formed payload is found, preferring the recordings section", () => {
    const other = { ...recordings, key: "qa", channel_hours: { ...sample, datasets_scanned: 1 } };
    const snap = {
      ...base,
      sections: [...base.sections, other, { ...recordings, channel_hours: sample }],
    };
    const found = findChannelHours(snap);
    expect(found.state).toBe("ok");
    expect(found.section.key).toBe("recordings");
    expect(found.payload.datasets_scanned).toBe(sample.datasets_scanned);
  });

  test("a payload this page cannot read is reported, not drawn", () => {
    const broken = structuredClone(sample) as unknown as { modalities: { bins: unknown }[] };
    broken.modalities[0].bins = "not a list";
    const snap = { ...base, sections: [{ ...recordings, channel_hours: broken }] };
    expect(findChannelHours(snap).state).toBe("invalid");
  });
});

describe("hours at N or more channels", () => {
  test("modalities are ordered by hours, most first, with bins in channel order", () => {
    expect(modalities.map((m: { name: string }) => m.name)).toEqual(["EEG", "EMG", "iEEG", "MEG"]);
    expect(modalities.map((m: { key: string }) => m.key)).toEqual(["eeg", "emg", "ieeg", "meg"]);
    for (const m of modalities) {
      const channels = m.bins.map((b: { channels: number }) => b.channels);
      expect(channels).toEqual([...channels].sort((a, b) => a - b));
    }
  });

  test("every modality at every stop matches the sums taken from the fixture", () => {
    for (const m of modalities) {
      const source = raw(m.name);
      const stops = [...channelStops(m, 512), 512, 1000];
      for (const min of stops) {
        const got = atLeast(m, min);
        const want = reference(source, min);
        expect(got.hours).toBeCloseTo(want.hours, 6);
        expect(got.recordings).toBe(want.recordings);
        expect(got.datasets).toBe(want.datasets);
        expect(got.channelHours).toBeCloseTo(want.channelHours, 4);
      }
      // Any number of channels is the modality's own declared total.
      const all = atLeast(m, 1);
      expect(all.hours).toBeCloseTo(source.hours, 6);
      expect(all.recordings).toBe(source.recordings);
      expect(all.datasets).toBe(source.datasets);
    }
  });

  test("the owner's example and a few edges, pinned", () => {
    // 16 or more channels of EEG.
    const eeg16 = atLeast(byKey("eeg"), 16);
    expect(eeg16.hours).toBeCloseTo(2444.867, 3);
    expect(eeg16.recordings).toBe(13_368);
    expect(eeg16.datasets).toBe(47);
    // EMG has only 16 and 32 channels: 17 or more is the 32-channel part.
    const emg17 = atLeast(byKey("emg"), 17);
    expect(emg17.hours).toBeCloseTo(344.6203, 4);
    expect(emg17).toMatchObject({ recordings: 1131, datasets: 1 });
    expect(atLeast(byKey("emg"), 33)).toEqual({
      hours: 0,
      recordings: 0,
      datasets: 0,
      channelHours: 0,
    });
    // One iEEG dataset reaches 256 channels.
    const ieeg256 = atLeast(byKey("ieeg"), 256);
    expect(ieeg256.hours).toBeCloseTo(0.5584, 4);
    expect(ieeg256).toMatchObject({ recordings: 4, datasets: 1 });
  });

  test("the chart's marks are the exact bins, or the dataset peaks", () => {
    const eeg = byKey("eeg");
    expect(channelSeries(eeg, "hours")).toHaveLength(raw("EEG").bins.length);
    expect(
      channelSeries(eeg, "recordings").reduce((s: number, p: { value: number }) => s + p.value, 0),
    ).toBe(raw("EEG").recordings);
    expect(channelSeries(eeg, "datasets")).toEqual(
      [...raw("EEG").dataset_peaks]
        .sort((a, b) => a.channels - b.channels)
        .map((p) => ({ channels: p.channels, value: p.datasets })),
    );
  });
});

describe("the channel axis and the slider's stops", () => {
  test("one doubling axis for every modality, reaching past the largest count", () => {
    // MEG reaches 415 channels in the sample.
    expect(axisMaxFor(modalities)).toBe(512);
    expect(axisPowers(512)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
    // A count of exactly 512 needs the next doubling to sit inside the axis.
    const wider = structuredClone(sample);
    wider.modalities[0].bins[0].channels = 512;
    expect(axisMaxFor(prepareModalities(wider))).toBe(1024);
  });

  test("stops are the powers of two plus every count that occurs", () => {
    expect(channelStops(byKey("emg"), 512)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256]);
    const eegStops = channelStops(byKey("eeg"), 512);
    for (const b of raw("EEG").bins) expect(eegStops).toContain(b.channels);
    for (const p of [1, 2, 4, 8, 16, 32, 64, 128, 256]) expect(eegStops).toContain(p);
    expect(eegStops).toEqual([...new Set(eegStops)].sort((a, b) => a - b));
    expect(eegStops.at(-1)).toBe(257);
    expect(channelStops(byKey("meg"), 512).at(-1)).toBe(415);
  });

  test("arrow keys step to the neighboring stop, Page keys to the neighboring power of two", () => {
    const stops = channelStops(byKey("eeg"), 512);
    expect(stepStop(stops, 16, 1)).toBe(19);
    expect(stepStop(stops, 16, -1)).toBe(8);
    expect(stepStop(stops, 20, 1)).toBe(22);
    expect(stepStop(stops, 257, 1)).toBe(257);
    expect(stepStop(stops, 1, -1)).toBe(1);
    expect(stepPower(stops, 16, 1)).toBe(32);
    expect(stepPower(stops, 19, -1)).toBe(16);
    expect(stepPower(stops, 256, 1)).toBe(256);
  });

  test("a drag lands on the nearest stop on the log axis", () => {
    const stops = channelStops(byKey("emg"), 512);
    expect(nearestStop(stops, 22)).toBe(16);
    expect(nearestStop(stops, 23)).toBe(32);
    expect(nearestStop(stops, 0.5)).toBe(1);
    expect(nearestStop(channelStops(byKey("eeg"), 512), 62)).toBe(63);
  });
});

describe("words", () => {
  test("the threshold reads the way people ask for it", () => {
    expect(thresholdText(1)).toBe("any number of channels");
    expect(thresholdText(16)).toBe("16 or more channels");
    expect(thresholdText(1024)).toBe("1,024 or more channels");
  });

  test("the readout answers in a sentence for each measure", () => {
    const eeg = byKey("eeg");
    const part = atLeast(eeg, 16);
    expect(measureFigure("hours", part.hours)).toEqual({ number: "2,445", unit: "hours" });
    expect(measureFigure("datasets", 1)).toEqual({ number: "1", unit: "dataset" });
    expect(measureFigure("recordings", 13_368)).toEqual({ number: "13,368", unit: "recordings" });
    expect(hoursClaim("hours", "EEG", 16, part.hours)).toBe(
      "of EEG recorded with 16 or more channels",
    );
    expect(hoursClaim("recordings", "EEG", 16, part.recordings)).toBe(
      "of EEG with 16 or more channels",
    );
    expect(hoursClaim("datasets", "EEG", 16, 47)).toBe(
      "have EEG recordings with 16 or more channels",
    );
    expect(hoursClaim("datasets", "EMG", 32, 1)).toBe(
      "has EMG recordings with 32 or more channels",
    );
    expect(hoursShareLine("hours", part.hours, eeg.hours, "EEG")).toBe(
      "52.6% of the 4,646 EEG hours",
    );
    expect(hoursShareLine("datasets", 1, 4, "EMG")).toBe("25% of the 4 EMG datasets");
    expect(hoursFacts("hours", part).map((f: { label: string }) => f.label)).toEqual([
      "Recordings",
      "Datasets",
      "Channel-hours",
    ]);
    expect(hoursFacts("datasets", part)).toEqual([
      { label: "Hours", value: "2,445 h" },
      { label: "Recordings", value: "13,368" },
      { label: "Channel-hours", value: "195k" },
    ]);
    expect(channelHoursText(928.8)).toBe("929");
  });

  test("the exact-values table has one row per count with all three measures", () => {
    const rows = hoursTableRows(byKey("eeg"));
    expect(rows).toHaveLength(raw("EEG").bins.length);
    expect(rows.reduce((s: number, r: { datasets: number }) => s + r.datasets, 0)).toBe(
      raw("EEG").datasets,
    );
    expect(rows[0]).toEqual({ channels: 2, hours: 837.9071, recordings: 58, datasets: 1 });
    expect(tableHours(837.9071)).toBe("837.9");
    expect(tableHours(1155.6778)).toBe("1,155.7");
    expect(tableHours(0.01)).toBe("<0.1");
    expect(tableHours(0)).toBe("0.0");
  });
});

describe("the shareable view", () => {
  test("round-trips through the address", () => {
    const view = { modality: "ieeg", min: 64, measure: "datasets" };
    expect(hoursHash(view)).toBe("#hours=ieeg:64:datasets");
    expect(parseHoursHash(hoursHash(view))).toEqual(view);
    expect(hoursHash({ modality: "eeg", min: 16, measure: "hours" })).toBe("#hours=eeg:16");
    expect(parseHoursHash("#hours=EEG:16")).toEqual({ modality: "eeg", min: 16, measure: "hours" });
  });

  test("anything malformed is ignored as a whole", () => {
    for (const hash of [
      "",
      "#pipelines",
      "#hours=eeg",
      "#hours=eeg:0",
      "#hours=eeg:16:bytes",
      "#hours=:16",
      "#hours=eeg:-4",
      "#hours=%E0%A4%A:16",
    ]) {
      expect(parseHoursHash(hash)).toBeNull();
    }
  });
});
