// The alerting decision, tested against the exact response shapes /health
// produces. This is the logic that decides whether anyone gets woken up, so a
// false negative here reproduces issue #7 one level further out: a dashboard
// that is broken, a health endpoint that says so, and a monitor that shrugs.

import { describe, expect, test } from "bun:test";
import { verdictFor } from "../scripts/check-health";

describe("verdictFor", () => {
  test("a healthy response is ok", () => {
    const v = verdictFor(200, {
      ok: true,
      stale: false,
      snapshot: "ok",
      section_errors: [],
      cron: { last_success_at: "2026-07-29T13:17:06.143Z", last_error: null },
    });
    expect(v.ok).toBe(true);
    expect(v.summary).toBe("healthy");
  });

  // The original #7 fault, now one layer out: sections failed, health says so,
  // and the monitor must not treat that as noise.
  test("names the failed sections", () => {
    const v = verdictFor(503, { ok: false, stale: false, section_errors: ["sync", "cf"] });
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("sections failed to compute: sync, cf");
  });

  test("reports staleness with the last successful cron time", () => {
    const v = verdictFor(503, {
      ok: false,
      stale: true,
      section_errors: [],
      cron: { last_success_at: "2026-07-28T02:17:00.000Z", last_error: "AE SQL 500" },
    });
    expect(v.summary).toContain("stale");
    expect(v.summary).toContain("2026-07-28T02:17:00.000Z");
    expect(v.detail).toContain("AE SQL 500");
  });

  test("reports a never-successful cron without inventing a timestamp", () => {
    const v = verdictFor(503, { ok: false, stale: true, cron: null });
    expect(v.summary).toContain("never");
  });

  test("reports an unreadable stored snapshot with its reason", () => {
    const v = verdictFor(503, {
      ok: false,
      stale: false,
      snapshot: "unreadable",
      snapshot_error: "schema_mismatch",
      section_errors: [],
    });
    expect(v.summary).toContain("unreadable");
    expect(v.summary).toContain("schema_mismatch");
  });

  test("reports an unreadable store", () => {
    const v = verdictFor(503, { ok: false, error: "store_unavailable" });
    expect(v.summary).toContain("OBS_DB is unreadable");
  });

  test("combines every simultaneous fault rather than reporting only the first", () => {
    const v = verdictFor(503, {
      ok: false,
      stale: true,
      snapshot: "unreadable",
      snapshot_error: "invalid_json",
      section_errors: ["access"],
      cron: { last_success_at: "2026-07-20T00:00:00.000Z" },
    });
    expect(v.summary).toContain("stale");
    expect(v.summary).toContain("access");
    expect(v.summary).toContain("invalid_json");
  });

  // Defaulting to "healthy" on an unrecognized body is how a monitor goes
  // quiet exactly when something unexpected is happening.
  test("an unparseable body is unhealthy, not inconclusive", () => {
    const v = verdictFor(502, null);
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("unreachable or unparseable");
  });

  test("ok:false with no recognized reason is still unhealthy", () => {
    const v = verdictFor(503, { ok: false });
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("no recognized reason");
  });

  // A truthy-but-not-true `ok` must not pass. Only an explicit boolean does.
  test("a non-boolean ok does not count as healthy", () => {
    expect(verdictFor(200, { ok: "true" }).ok).toBe(false);
    expect(verdictFor(200, { ok: 1 }).ok).toBe(false);
  });
});
