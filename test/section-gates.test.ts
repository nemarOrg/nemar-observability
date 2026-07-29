// The config gates on externally-sourced sections. These branches return before
// any fetch, so they are fully testable with no network and no mocks --
// previously the only untested part of computeAccessSection that did not
// require a live Analytics Engine call.
//
// What they protect: a section whose credentials are missing must render as
// "unconfigured", never as zero. A dashboard that reports zero traffic when it
// actually cannot see traffic is worse than one that is visibly down.

import { describe, expect, test } from "bun:test";
import { computeAccessSection } from "../src/lib/access";
import type { Bindings } from "../src/types";

const NOW = "2026-07-29T12:00:00.000Z";

describe("access section config gate", () => {
  test("reports unconfigured (not zero) when the AE token is absent", async () => {
    const s = await computeAccessSection({ AE_DATASET: "x" } as Bindings, NOW);
    expect(s.key).toBe("access");
    expect(s.metrics).toHaveLength(1);
    expect(s.metrics[0].key).toBe("access.unconfigured");
    expect(s.metrics[0].value).toBe(0);
    expect(s.metrics[0].hint).toContain("CF_ANALYTICS_TOKEN");
  });

  test("warns when the token is present but AE_DATASET is not", async () => {
    const s = await computeAccessSection({ CF_ANALYTICS_TOKEN: "t" } as Bindings, NOW);
    expect(s.metrics[0].key).toBe("access.unconfigured");
    // warn, not info: a token with no dataset is a deploy mistake, whereas a
    // missing token is the expected pre-provisioning state.
    expect(s.metrics[0].severity).toBe("warn");
  });

  test("the gate result still satisfies the section shape", async () => {
    const s = await computeAccessSection({} as Bindings, NOW);
    expect(s.updated_at).toBe(NOW);
    expect(s.source).toBe("access");
    expect(s.metrics.length).toBeGreaterThan(0);
  });
});
