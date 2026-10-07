// What the section says when part of NEMAR could not be read, and the guard that
// refuses to publish when too much is missing. The weights come from the cache's
// last-known hours, so a single unreadable dataset that holds most of the hours
// cannot slip through on a count of one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type DatasetOutcome,
  aggregateOutcomes,
  assertPublishable,
  recordingsSection,
} from "../scripts/lib/zarr-aggregate";
import { SUMMARY_VERSION, summarizeIndex } from "../scripts/lib/zarr-recordings";
import { SectionIngestSchema } from "../src/lib/schema";
import { FIXTURES, datasetIdOf, fixtureObject } from "./helpers/zarr-fixtures";

const expected = JSON.parse(
  readFileSync(new URL("./fixtures/zarr-recordings-expected.json", import.meta.url), "utf8"),
) as { summary_version: number };

const read: DatasetOutcome[] = FIXTURES.map((name) => ({
  id: datasetIdOf(name),
  kind: "summary" as const,
  summary: summarizeIndex(fixtureObject(name), datasetIdOf(name)),
  from: "network" as const,
}));

describe("the independent expectation", () => {
  test("was computed under the summary rules in force, or is re-derived on purpose", () => {
    // Changing how recordings are counted changes SUMMARY_VERSION; this fails until the
    // expected numbers in zarr-recordings-expected.json are recomputed independently
    // and their summary_version is raised with them.
    expect(expected.summary_version).toBe(SUMMARY_VERSION);
  });
});

describe("a run that could not read some datasets", () => {
  const withUnavailable = (lastKnownSeconds?: number) =>
    aggregateOutcomes(9, [
      ...read,
      {
        id: "on009999",
        kind: "unavailable",
        reason: "HTTP 500",
        ...(lastKnownSeconds === undefined ? {} : { lastKnownSeconds }),
      },
    ]);

  test("the hours tile warns in plain words, and so does the datasets tile", () => {
    const section = recordingsSection(withUnavailable());
    const hours = section.metrics.find((m) => m.key === "recordings.hours");
    expect(hours?.severity).toBe("warn");
    expect(hours?.hint).toContain("1 public dataset could not be read this run");
    expect(hours?.hint).toContain("may be lower than the true total");
    expect(section.metrics.find((m) => m.key === "recordings.datasets")?.severity).toBe("warn");
    expect(section.channel_hours?.datasets_unavailable).toBe(1);
    expect(SectionIngestSchema.safeParse(section).success).toBe(true);
  });

  test("with every index read the tiles stay informational and the hint is the plain one", () => {
    const section = recordingsSection(aggregateOutcomes(7, read));
    const hours = section.metrics.find((m) => m.key === "recordings.hours");
    expect(hours?.severity).toBe("info");
    expect(hours?.hint).not.toContain("could not be read");
    expect(
      recordingsSection(
        aggregateOutcomes(9, [...read, ...read.map((o) => ({ ...o, id: `${o.id}x` }))]),
      ).metrics.find((m) => m.key === "recordings.hours")?.severity,
    ).toBe("info");
  });

  test("two unreadable datasets are named in the plural", () => {
    const aggregate = aggregateOutcomes(9, [
      ...read,
      { id: "on009998", kind: "unavailable", reason: "HTTP 500" },
      { id: "on009999", kind: "unavailable", reason: "HTTP 500" },
    ]);
    const hours = recordingsSection(aggregate).metrics.find((m) => m.key === "recordings.hours");
    expect(hours?.hint).toContain("2 public datasets could not be read this run");
  });

  test("the count limit alone would pass one dataset in thirty; the hours limit does not", () => {
    // Thirty-one datasets, one unreadable: 3% by count. Its last-known hours are
    // twenty times everything that was read, so the run is missing about 95%.
    const summary = read[0].kind === "summary" ? read[0].summary : null;
    if (!summary) throw new Error("fixture outcome is not a summary");
    const many: DatasetOutcome[] = Array.from({ length: 30 }, (_, i) => ({
      id: `nm${String(i).padStart(6, "0")}`,
      kind: "summary" as const,
      summary,
      from: "cache" as const,
    }));
    const readSeconds = 30 * summary.storeSeconds;
    const unreadable = (lastKnownSeconds?: number): DatasetOutcome => ({
      id: "on000001",
      kind: "unavailable",
      reason: "HTTP 500",
      ...(lastKnownSeconds === undefined ? {} : { lastKnownSeconds }),
    });
    const check = (lastKnown?: number) => {
      const aggregate = aggregateOutcomes(31, [...many, unreadable(lastKnown)]);
      return () => assertPublishable(aggregate, recordingsSection(aggregate));
    };
    expect(check(undefined)).not.toThrow(); // never cached: only the count is known
    expect(check(readSeconds * 0.05)).not.toThrow(); // about 5% of the hours
    expect(check(readSeconds * 20)).toThrow("held about 95% of the hours last time");
    expect(check(readSeconds * 0.2)).toThrow("held about 17% of the hours");
  });
});
