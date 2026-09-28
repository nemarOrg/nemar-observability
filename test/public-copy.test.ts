import { describe, expect, test } from "bun:test";

// Metric hints are shown in the public dashboard's popovers, so they are
// written for readers: no vendor names, commands, issue numbers, file names,
// or query fragments. (Setup messages for an unconfigured deploy are operator
// text by design and are covered in section-gates.test.ts.)
const SOURCES = [
  "../src/lib/metrics.ts",
  "../src/lib/access.ts",
  "../src/lib/cf-section.ts",
  "../scripts/push-s3-egress.ts",
];
const JARGON =
  /Cloudflare|\bS3\b|CloudWatch|presigned|index\.json|nemar approve|archive-sweep|#\d{3}|source='|\b\d+d\b|—/;

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
