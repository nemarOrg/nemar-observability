// The recorded-hours explorer's arithmetic and wording, run as the page runs
// it (the client modules evaluated in page order). Expected values are summed
// here straight from the real fixture, independently of the code under test.

import { describe, expect, test } from "bun:test";
import { ChannelHoursSchema } from "../src/lib/schema";
import sample from "./fixtures/channel-hours.sample.json";
import snapshotFixture from "./fixtures/snapshot-2026-09-28.json";
import { clientLogic } from "./helpers/client-logic";

const {
  partShare,
  hoursDataNotices,
  thresholdText,
  measureFigure,
  hoursClaim,
  hoursShareLine,
  hoursAnnouncement,
  hoursFacts,
  channelHoursText,
  tableHours,
  hoursTableRows,
  findChannelHours,
  validChannelHours,
  prepareModalities,
  atLeast,
  channelSeries,
  axisMaxFor,
  axisPowers,
  channelStops,
  stepStop,
  stepPower,
  largestCount,
  countScale,
  nearestStop,
  parseHoursHash,
  hoursHash,
} = clientLogic([
  "validChannelHours",
  "partShare",
  "hoursDataNotices",
  "thresholdText",
  "measureFigure",
  "hoursClaim",
  "hoursShareLine",
  "hoursAnnouncement",
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
  "largestCount",
  "countScale",
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

describe("notices about the data", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const section = (hoursAgo: number) => ({
    updated_at: new Date(now - hoursAgo * 3_600_000).toISOString(),
  });

  test("data older than 72 hours says when it was last updated", () => {
    expect(hoursDataNotices(section(72), sample, now)).toEqual([]);
    expect(hoursDataNotices(section(73), sample, now)).toEqual([
      "This was last updated 3 days ago.",
    ]);
    expect(hoursDataNotices(section(240), sample, now)).toEqual([
      "This was last updated 10 days ago.",
    ]);
    // No time, no judgment.
    expect(hoursDataNotices({ updated_at: "" }, sample, now)).toEqual([]);
  });

  test("unread datasets make the totals incomplete", () => {
    expect(hoursDataNotices(section(1), { ...sample, datasets_unavailable: 1 }, now)).toEqual([
      "1 dataset could not be read in the last run, so these totals are incomplete.",
    ]);
    expect(hoursDataNotices(section(100), { ...sample, datasets_unavailable: 40 }, now)).toEqual([
      "This was last updated 4 days ago.",
      "40 datasets could not be read in the last run, so these totals are incomplete.",
    ]);
  });
});

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

  test("only the recordings section feeds the explorer", () => {
    const other = { ...recordings, key: "qa", channel_hours: sample };
    const snap = {
      ...base,
      sections: [...base.sections, other, { ...recordings, channel_hours: sample }],
    };
    const found = findChannelHours(snap);
    expect(found.state).toBe("ok");
    expect(found.section.key).toBe("recordings");
    expect(found.payload.datasets_scanned).toBe(sample.datasets_scanned);
    // Another section carrying the same payload is not drawn under the
    // explorer's source line.
    expect(findChannelHours({ ...base, sections: [...base.sections, other] }).state).toBe(
      "missing",
    );
  });

  test("a payload this page cannot read is reported, not drawn", () => {
    type Loose = Record<string, unknown> & { modalities: Record<string, unknown>[] };
    const broken = (mutate: (v: Loose) => void) => {
      const v = structuredClone(sample) as unknown as Loose;
      mutate(v);
      return findChannelHours({ ...base, sections: [{ ...recordings, channel_hours: v }] }).state;
    };
    expect(
      broken((v) => {
        v.modalities[0].bins = "not a list";
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        v.modalities[0].bins = [];
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        v.modalities = [];
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        v.modalities[0].hours = -1;
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        (v.modalities[0].bins as { recordings: number }[])[0].recordings = 1.5;
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        (v.modalities[0].bins as { channels: number }[])[0].channels = 0;
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        v.modalities[0].dataset_peaks = undefined;
      }),
    ).toBe("invalid");
    expect(
      broken((v) => {
        v.datasets_scanned = "64";
      }),
    ).toBe("invalid");
  });
});

describe("the page's check matches the server's schema", () => {
  // Every case is a mutation of the real sample. Whatever ChannelHoursSchema
  // rejects, the page must reject too; the few it accepts, the page accepts.
  type Loose = Record<string, unknown> & {
    modalities: (Record<string, unknown> & {
      bins: Record<string, unknown>[];
      dataset_peaks: Record<string, unknown>[];
    })[];
  };
  const eegIndex = sample.modalities.findIndex((m) => m.modality === "EEG");
  type Path = (string | number)[];
  type Node = Record<string | number, unknown>;
  const parent = (v: Loose, path: Path) => {
    let target = v as unknown as Node;
    for (const step of path.slice(0, -1)) target = target[step] as Node;
    return target;
  };
  // Sets one field; change() derives the new value from the old one.
  const set = (path: Path, value: unknown) => (v: Loose) => {
    parent(v, path)[path[path.length - 1]] = value;
  };
  const change = (path: Path, next: (old: number) => unknown) => (v: Loose) => {
    const target = parent(v, path);
    const key = path[path.length - 1];
    target[key] = next(target[key] as number);
  };
  const lastBin = sample.modalities[0].bins.length - 1;
  const cases: [string, (v: Loose) => void][] = [
    ["channel count 0", set(["modalities", 0, "bins", 0, "channels"], 0)],
    ["channel count above 100,000", set(["modalities", 0, "bins", 0, "channels"], 100_001)],
    ["channel count 1e308", set(["modalities", 0, "bins", lastBin, "channels"], 1e308)],
    ["fractional channel count", set(["modalities", 0, "bins", 0, "channels"], 2.5)],
    ["a bin with no recordings", set(["modalities", 0, "bins", 0, "recordings"], 0)],
    // The next two keep every sum and the order intact, so only the "at least
    // one" rules can catch them: EEG has bins at 3 and 5 channels, none at 4,
    // and a bin at 3 channels but no dataset peak there.
    [
      "an empty bin that changes no sum",
      (v) => {
        v.modalities[eegIndex].bins.splice(2, 0, { channels: 4, hours: 0, recordings: 0 });
      },
    ],
    [
      "an empty peak that changes no sum",
      (v) => {
        v.modalities[eegIndex].dataset_peaks.splice(1, 0, { channels: 3, datasets: 0 });
      },
    ],
    ["fractional recordings", set(["modalities", 0, "bins", 0, "recordings"], 1.5)],
    ["negative hours", set(["modalities", 0, "bins", 0, "hours"], -1)],
    ["hours not a number", set(["modalities", 0, "bins", 0, "hours"], Number.NaN)],
    [
      "bins out of order",
      (v) => {
        v.modalities[0].bins.reverse();
      },
    ],
    [
      "a repeated bin",
      (v) => {
        v.modalities[0].bins.splice(1, 0, { ...v.modalities[0].bins[0] });
      },
    ],
    ["no dataset peaks", set(["modalities", 0, "dataset_peaks"], [])],
    [
      "peaks out of order",
      (v) => {
        v.modalities[0].dataset_peaks.reverse();
      },
    ],
    // EEG's smallest peak sits at 2 channels; at 1 channel there is no bin.
    ["a peak with no bin", set(["modalities", eegIndex, "dataset_peaks", 0, "channels"], 1)],
    [
      "more datasets at a peak than recordings in its bin",
      (v) => {
        const m = v.modalities[eegIndex];
        m.dataset_peaks[0].datasets = 59;
        m.datasets = (m.datasets as number) + 58;
      },
    ],
    [
      "the largest peak below the largest bin",
      (v) => {
        const m = v.modalities[eegIndex];
        const last = m.dataset_peaks.pop();
        m.datasets = (m.datasets as number) - (last?.datasets as number);
      },
    ],
    ["recordings off the sum", change(["modalities", 0, "recordings"], (n) => n + 1)],
    ["hours off the sum", change(["modalities", 0, "hours"], (n) => n + 1)],
    ["datasets off the sum", change(["modalities", 0, "datasets"], (n) => n + 1)],
    ["more datasets than were scanned", set(["datasets_scanned"], 10)],
    [
      "EEG and eeg",
      (v) => {
        v.modalities.push({ ...structuredClone(v.modalities[0]), modality: "eeg" });
      },
    ],
    ["a markup name", set(["modalities", 0, "modality"], "<img src=x onerror=alert(1)>")],
    ["a name with a colon", set(["modalities", 0, "modality"], "a:b%#c")],
    ["a name starting with a digit", set(["modalities", 0, "modality"], "1EEG")],
    ["an empty name", set(["modalities", 0, "modality"], "")],
    ["a 33-character name", set(["modalities", 0, "modality"], "E".repeat(33))],
    ["no modalities", set(["modalities"], [])],
    [
      "33 modalities",
      (v) => {
        const template = v.modalities.find((m) => m.modality === "EMG");
        for (let i = 0; v.modalities.length < 33; i++)
          v.modalities.push({ ...structuredClone(template), modality: `M${i}` } as never);
      },
    ],
    ["an unknown field on the payload", set(["extra"], 1)],
    ["an unknown field on a modality", set(["modalities", 0, "dataset_id"], "nm000103")],
    ["an unknown field on a bin", set(["modalities", 0, "bins", 0, "note"], "x")],
    ["an unknown field on a peak", set(["modalities", 0, "dataset_peaks", 0, "note"], "x")],
    ["a negative count", set(["datasets_scanned"], -1)],
    ["a fractional count", set(["datasets_unavailable"], 1.5)],
    ["a count as text", set(["datasets_scanned"], "64")],
    ["an unsafe count", set(["recordings_unmeasured"], 2 ** 53)],
    [
      "1,025 bins",
      (v) => {
        const m = v.modalities[0];
        m.bins = Array.from({ length: 1025 }, (_, i) => ({
          channels: i + 1,
          hours: 1,
          recordings: 1,
        }));
        m.dataset_peaks = [{ channels: 1025, datasets: 1 }];
        m.hours = 1025;
        m.recordings = 1025;
        m.datasets = 1;
      },
    ],
  ];
  const clone = () => structuredClone(sample) as unknown as Loose;

  test("the real sample passes both", () => {
    expect(ChannelHoursSchema.safeParse(sample).success).toBe(true);
    expect(validChannelHours(sample)).toBe(true);
  });

  for (const [name, mutate] of cases) {
    test(`rejected by both: ${name}`, () => {
      const v = clone();
      mutate(v);
      expect(ChannelHoursSchema.safeParse(v).success).toBe(false);
      expect(validChannelHours(v)).toBe(false);
    });
  }

  test("what the schema accepts, the page accepts", () => {
    const accepted: ((v: Loose) => void)[] = [
      set(["recordings_unmeasured"], 7),
      set(["datasets_unavailable"], 3),
      (v) => {
        // A measured recording can have no duration.
        const m = v.modalities[0];
        m.hours = (m.hours as number) - (m.bins[0].hours as number);
        m.bins[0].hours = 0;
      },
    ];
    for (const mutate of accepted) {
      const v = clone();
      mutate(v);
      expect(ChannelHoursSchema.safeParse(v).success).toBe(true);
      expect(validChannelHours(v)).toBe(true);
    }
  });

  test("the axis cannot run away", () => {
    // Even if a huge count got past every check, the axis stops at 2^20.
    expect(axisPowers(Number.POSITIVE_INFINITY)).toHaveLength(21);
    const huge = prepareModalities(sample);
    huge[0].bins.push({ channels: 1e308, hours: 1, recordings: 1 });
    expect(axisMaxFor(huge)).toBe(131_072);
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

  test("End goes to the largest count that occurs, not the last power of two", () => {
    // EMG's stops run on to 256, where nothing was recorded; End stops at 32.
    expect(largestCount(byKey("emg"))).toBe(32);
    expect(largestCount(byKey("eeg"))).toBe(257);
    expect(largestCount(byKey("meg"))).toBe(415);
    expect(largestCount(byKey("ieeg"))).toBe(Math.max(...raw("iEEG").bins.map((b) => b.channels)));
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
    // Past the last power of two, Page Up still reaches the largest count.
    expect(stepPower(stops, 256, 1)).toBe(257);
    expect(stepPower(stops, 257, 1)).toBe(257);
    expect(stepPower(stops, 257, -1)).toBe(256);
    const megStops = channelStops(byKey("meg"), 512);
    expect(stepPower(megStops, 415, 1)).toBe(415);
    expect(stepPower(megStops, 415, -1)).toBe(256);
  });

  test("a step never moves against its direction, even from beyond the last stop", () => {
    // A shared link can ask for 400 or more channels of EEG, past its last count.
    const stops = channelStops(byKey("eeg"), 512);
    expect(stepStop(stops, 400, 1)).toBe(400);
    expect(stepPower(stops, 400, 1)).toBe(400);
    expect(stepStop(stops, 400, -1)).toBe(257);
    expect(stepPower(stops, 400, -1)).toBe(256);
  });

  test("count gridlines are whole numbers", () => {
    // A tallest bar of 7 would give a 2.5 step whose labels round to 3 and 8.
    expect(countScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(countScale(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(countScale(3)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    // The EEG dataset peaks and recordings in the sample.
    const peak = Math.max(...raw("EEG").dataset_peaks.map((p) => p.datasets));
    const recordings = Math.max(...raw("EEG").bins.map((b) => b.recordings));
    for (const max of [peak, recordings, 6.5, 7.5, 13, 26, 99, 1234]) {
      const scale = countScale(max);
      expect(scale.ticks.every((t: number) => Number.isInteger(t))).toBe(true);
      expect(scale.max).toBeGreaterThanOrEqual(max);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
      expect(scale.ticks.length).toBeLessThanOrEqual(6);
    }
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
    // A total under a tenth of an hour, and recordings with no duration at all.
    expect(hoursShareLine("hours", 0.03, 0.03, "TINY")).toBe(
      "100% of all TINY hours, less than 0.1 hours in total",
    );
    expect(hoursShareLine("hours", 0, 0, "ZERO")).toBe(
      "These ZERO recordings have no recorded duration, so there are no hours to compare.",
    );
    // Read aloud: one period at the end whichever shape the share line has.
    const figure = measureFigure("hours", part.hours);
    expect(
      hoursAnnouncement(
        figure,
        "of EEG recorded with 16 or more channels",
        "52.6% of the 4,646 EEG hours",
      ),
    ).toBe("2,445 hours of EEG recorded with 16 or more channels. 52.6% of the 4,646 EEG hours.");
    expect(
      hoursAnnouncement(
        measureFigure("hours", 0),
        "of ZERO recorded with 16 or more channels",
        hoursShareLine("hours", 0, 0, "ZERO"),
      ),
    ).toBe(
      "0 hours of ZERO recorded with 16 or more channels. These ZERO recordings have no recorded duration, so there are no hours to compare.",
    );
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
    expect(parseHoursHash(hoursHash(view))).toEqual({ valid: true, ...view });
    expect(hoursHash({ modality: "eeg", min: 16, measure: "hours" })).toBe("#hours=eeg:16");
    // Modality and measure are read without regard to case.
    expect(parseHoursHash("#hours=EEG:16:Hours")).toEqual({
      valid: true,
      modality: "eeg",
      min: 16,
      measure: "hours",
    });
  });

  test("an address that is not an explorer link is left alone", () => {
    for (const hash of ["", "#pipelines", "#recorded-hours", "#hour=eeg:16"]) {
      expect(parseHoursHash(hash)).toBeNull();
    }
  });

  test("an explorer link that cannot be read is reported as such, as a whole", () => {
    for (const hash of [
      "#hours=eeg",
      "#hours=eeg:0",
      "#hours=eeg:16:bytes",
      "#hours=eeg:16:minutes",
      "#hours=:16",
      "#hours=eeg:-4",
      "#hours=%E0%A4%A:16",
    ]) {
      expect(parseHoursHash(hash)).toEqual({ valid: false });
    }
  });
});
