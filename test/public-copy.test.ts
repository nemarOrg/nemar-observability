import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { egressFailureStatus, egressSection, parsePoints } from "../scripts/push-s3-egress";
import {
  STORAGE_TYPES,
  latestStorageObservation,
  storageClassLabel,
  storageFailureStatus,
  storageSection,
  storageWindow,
} from "../scripts/push-s3-storage";
import { JARGON } from "./helpers/public-copy";

// Metric hints are shown in the public dashboard's popovers, so they are
// written for readers: no vendor names, commands, issue numbers, file names,
// or query fragments. (Setup messages for an unconfigured deploy are operator
// text by design and are covered in section-gates.test.ts.)
const SOURCES = [
  "../src/lib/metrics.ts",
  "../src/lib/access.ts",
  "../src/lib/cf-section.ts",
  "../scripts/push-s3-egress.ts",
  "../scripts/push-s3-storage.ts",
];

describe("public metric hints", () => {
  test("hints use plain words", async () => {
    const hints: string[] = [];
    for (const path of SOURCES) {
      const text = await Bun.file(new URL(path, import.meta.url)).text();
      for (const m of text.matchAll(/hint:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)/g)) hints.push(m[1]);
      for (const m of text.matchAll(/spikeHint\(\s*(`[^`]*`)/g)) hints.push(m[1]);
    }
    expect(hints.length).toBeGreaterThan(20);
    expect(hints.filter((h) => JARGON.test(h))).toEqual([]);
  });
});

type PublicSection = {
  label: string;
  metrics: { label: string; hint?: string; breakdown?: { label: string }[] }[];
};

/** Every reader-facing string of a pushed section, as the collector builds it. */
function publicText(section: PublicSection): string[] {
  return [
    section.label,
    ...section.metrics.flatMap((metric) => [
      metric.label,
      metric.hint ?? "",
      ...(metric.breakdown ?? []).map((item) => item.label),
    ]),
  ];
}

// The source scan above sees template literals, not what they render to, and
// never sees labels. These build the real collector payloads from captured
// responses and check the rendered text.
describe("pushed collector sections", () => {
  test("rendered labels and hints use plain words", async () => {
    const storageCapture = await readFile(
      new URL(
        "./fixtures/cloudwatch-s3-storage-multiclass-derived-2026-09-22-to-2026-09-28.json",
        import.meta.url,
      ),
      "utf8",
    );
    const egressCapture = await readFile(
      new URL("./fixtures/cloudwatch-s3-2026-09-25.json", import.meta.url),
      "utf8",
    );
    const { startDate, endDate } = storageWindow("2026-09-28");
    const text = [
      ...publicText(storageSection(latestStorageObservation(storageCapture, startDate, endDate))),
      ...publicText(storageFailureStatus()),
      ...STORAGE_TYPES.map(storageClassLabel),
      storageClassLabel("SomeFutureStorage"),
      // The egress daily series label is immutable stored metadata, and the
      // dashboard shows its own name for that series, so only the section is
      // checked here.
      ...publicText(egressSection(parsePoints(egressCapture, "2026-09-25", "2026-09-26"))),
      ...publicText(egressFailureStatus()),
    ];
    expect(text.length).toBeGreaterThan(STORAGE_TYPES.length + 10);
    expect(text.filter((item) => JARGON.test(item))).toEqual([]);
  });
});
