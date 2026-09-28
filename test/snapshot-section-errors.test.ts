import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../src/lib/metrics";
import type { Bindings } from "../src/types";

describe("snapshot section errors", () => {
  test("each failed built-in section is reported under its own key", async () => {
    // With no database bound, every database-backed builder fails for real;
    // the access and edge sections report themselves as not configured.
    const snap = await buildSnapshot({} as Bindings);
    const failed = (snap.section_errors ?? []).map((e) => e.key);
    expect(failed).toEqual([
      "datasets",
      "sizes",
      "archive",
      "zarr",
      "imports",
      "publication",
      "users",
      // Pushed sections live in OBS_DB, also unbound here.
      "pushed",
    ]);
    const built = snap.sections.map((s) => s.key);
    for (const key of failed) expect(built).not.toContain(key);
    expect(failed.some((key) => key.startsWith("section_"))).toBe(false);
  });
});
