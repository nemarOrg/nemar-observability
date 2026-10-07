// Metrics in hours, as the page formats them wherever a metric appears: tile
// values, totals beside a percent, and bar lists. The collector that indexes
// the Zarr copies reports recorded time with unit "hours".

import { describe, expect, test } from "bun:test";
import sample from "./fixtures/channel-hours.sample.json";
import { clientLogic } from "./helpers/client-logic";

const { humanHours, spelledOutHours, unitFormatter, fmt } = clientLogic([
  "humanHours",
  "spelledOutHours",
  "unitFormatter",
  "fmt",
]);

describe("hours formatting", () => {
  test("short labels scale from tenths of an hour to millions", () => {
    expect(humanHours(0)).toBe("0 h");
    expect(humanHours(0.04)).toBe("<0.1 h");
    expect(humanHours(0.4973)).toBe("0.5 h");
    expect(humanHours(7.06)).toBe("7.1 h");
    expect(humanHours(1234.4)).toBe("1,234 h");
    expect(humanHours(9999.4)).toBe("9,999 h");
    expect(humanHours(31_234)).toBe("31.2k h");
    expect(humanHours(143_000)).toBe("143k h");
    expect(humanHours(999_999)).toBe("1M h");
    expect(humanHours(1_234_567)).toBe("1.23M h");
    expect(humanHours(Number.NaN)).toBe("Unknown");
    expect(humanHours(-1)).toBe("Unknown");
  });

  test("hours in words round like the readout and never read a small amount as zero", () => {
    expect(spelledOutHours(0)).toBe("0 hours");
    expect(spelledOutHours(0.01)).toBe("less than 0.1 hours");
    expect(spelledOutHours(1)).toBe("1 hour");
    expect(spelledOutHours(3.6142)).toBe("3.6 hours");
    expect(spelledOutHours(143_212.4)).toBe("143,212 hours");
  });

  test("a metric in hours formats as hours on tiles, totals, and bar lists", () => {
    const eeg = sample.modalities.find((m) => m.modality === "EEG");
    const emg = sample.modalities.find((m) => m.modality === "EMG");
    expect(fmt({ unit: "hours", value: eeg?.hours })).toBe("4,646 h");
    expect(unitFormatter("hours")(emg?.hours)).toBe("627 h");
    // Other units read as before.
    expect(fmt({ unit: "bytes", value: 1_500_000 })).toBe("1.5 MB");
    expect(unitFormatter("bytes")(1_500_000)).toBe("1.5 MB");
    expect(fmt({ unit: "percent", value: 42 })).toBe("42%");
    expect(fmt({ unit: "datasets", value: 1234 })).toBe("1,234");
    expect(unitFormatter("count")(1234)).toBe("1,234");
  });

  test("a unit the page does not know keeps its name instead of passing as a count", () => {
    expect(fmt({ unit: "minutes", value: 12 })).toBe("12 minutes");
    // Kept exactly as given: case and underscores included.
    expect(unitFormatter("GB")(3)).toBe("3 GB");
    expect(fmt({ unit: "MiB", value: 1536 })).toBe("1,536 MiB");
    expect(unitFormatter("wall_clock_seconds")(3)).toBe("3 wall_clock_seconds");
    // The units the page already shows as plain numbers stay plain.
    for (const unit of ["count", "datasets", "errors", "requests", "users"]) {
      expect(fmt({ unit, value: 1234 })).toBe("1,234");
    }
    expect(fmt({ value: 7 })).toBe("7");
  });
});
