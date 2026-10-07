// Metrics in hours, as the page formats them wherever a metric appears: tile
// values, totals beside a percent, and bar lists. The collector that indexes
// the Zarr copies reports recorded time with unit "hours".

import { describe, expect, test } from "bun:test";
import sample from "./fixtures/channel-hours.sample.json";
import { clientLogic } from "./helpers/client-logic";

const { humanHours, exactHours, unitFormatter, fmt } = clientLogic([
  "humanHours",
  "exactHours",
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

  test("hours in words keep whole hours exact and never read a small amount as zero", () => {
    expect(exactHours(0)).toBe("0 hours");
    expect(exactHours(0.01)).toBe("less than 0.1 hours");
    expect(exactHours(1)).toBe("1 hour");
    expect(exactHours(3.6142)).toBe("3.6 hours");
    expect(exactHours(143_212.4)).toBe("143,212 hours");
  });

  test("a metric in hours formats as hours on tiles, totals, and bar lists", () => {
    const total = sample.modalities.reduce((s, m) => s + m.hours, 0);
    const eeg = sample.modalities.find((m) => m.modality === "EEG");
    expect(fmt({ unit: "hours", value: total })).toBe("5,640 h");
    expect(unitFormatter("hours")(eeg?.hours)).toBe("4,646 h");
    // Other units read as before.
    expect(fmt({ unit: "bytes", value: 1_500_000 })).toBe("1.5 MB");
    expect(unitFormatter("bytes")(1_500_000)).toBe("1.5 MB");
    expect(fmt({ unit: "percent", value: 42 })).toBe("42%");
    expect(fmt({ unit: "datasets", value: 1234 })).toBe("1,234");
    expect(unitFormatter("count")(1234)).toBe("1,234");
  });

  test("a unit the page does not know keeps its name instead of passing as a count", () => {
    expect(fmt({ unit: "minutes", value: 12 })).toBe("12 minutes");
    expect(unitFormatter("wall_clock_seconds")(3)).toBe("3 wall clock seconds");
    // The units the page already shows as plain numbers stay plain.
    for (const unit of ["count", "datasets", "errors", "requests", "users"]) {
      expect(fmt({ unit, value: 1234 })).toBe("1,234");
    }
    expect(fmt({ value: 7 })).toBe("7");
  });
});
