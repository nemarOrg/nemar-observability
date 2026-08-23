// The alerting decision for the manifest monitor (#34), tested against the
// exact shapes the public surface produces. A false negative here reproduces
// the nm000225 incident one level further out: a published version serving
// "Version not published", a probe that saw it, and a monitor that shrugged.

import { describe, expect, test } from "bun:test";
import { type Problem, verdictFor, versionsOf } from "../scripts/check-manifests";

describe("versionsOf", () => {
  test("extracts version strings from a real landing payload shape", () => {
    expect(
      versionsOf({
        versions: [
          { version: "v1.0.0", doi: "10.82901/nemar.nm000225.v1.0.0" },
          { version: "v1.1.0", doi: "10.82901/nemar.nm000225.v1.1.0" },
        ],
      }),
    ).toEqual(["v1.0.0", "v1.1.0"]);
  });

  test("yields nothing for a null, malformed, or version-less landing", () => {
    expect(versionsOf(null)).toEqual([]);
    expect(versionsOf({})).toEqual([]);
    expect(versionsOf({ versions: "nope" })).toEqual([]);
    // An unpublished dataset legitimately has an empty versions array.
    expect(versionsOf({ versions: [] })).toEqual([]);
    // Entries without a usable version string are dropped, not crashed on.
    expect(versionsOf({ versions: [{ version: 3 }, {}, { version: "v1.0.0" }] })).toEqual([
      "v1.0.0",
    ]);
  });
});

describe("verdictFor", () => {
  test("a clean sweep is ok and says how much it covered", () => {
    const v = verdictFor(754, []);
    expect(v.ok).toBe(true);
    expect(v.summary).toContain("754");
    expect(v.detail).toBe("");
  });

  // The nm000225 shape: catalog advertises the version, index probe 404s.
  test("names each broken version and counts datasets, not findings", () => {
    const problems: Problem[] = [
      {
        dataset_id: "nm000225",
        version: "v1.1.0",
        kind: "index",
        http: 404,
        error: "Version not published",
      },
      { dataset_id: "nm000250", version: "v1.0.0", kind: "index", http: 404 },
      { dataset_id: "nm000250", version: "v1.0.1", kind: "index", http: 404 },
    ];
    const v = verdictFor(754, problems);
    expect(v.ok).toBe(false);
    expect(v.summary).toBe("2 of 754 public datasets have an unservable version index");
    expect(v.detail).toContain("`nm000225@v1.1.0`: HTTP 404 (Version not published)");
    expect(v.detail).toContain("`nm000250@v1.0.1`: HTTP 404");
    expect(v.detail).toContain("nemar admin doctor fix missing-manifest");
  });

  test("a failed landing is reported without a version", () => {
    const v = verdictFor(10, [{ dataset_id: "nm000103", kind: "landing", http: 500 }]);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("`nm000103 (landing)`: HTTP 500");
  });
});
