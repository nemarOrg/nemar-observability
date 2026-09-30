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

  test("names a daily series that is missing a closed day", () => {
    const v = verdictFor(503, {
      ok: false,
      stale: false,
      section_errors: [],
      series_behind: [{ key: "s3_bytes_downloaded", latest: "2026-09-28", expected: "2026-09-29" }],
      umami: "ok",
    });
    expect(v.ok).toBe(false);
    expect(v.summary).toContain("s3_bytes_downloaded (newest 2026-09-28, expected 2026-09-29)");
  });

  test("names an unreachable, silent, or misconfigured Umami, with the reason", () => {
    const rotated = verdictFor(503, { ok: false, umami: "unreachable", umami_reason: "http_401" });
    expect(rotated.summary).toContain("unreachable (http_401)");
    expect(verdictFor(503, { ok: false, umami: "silent" }).summary).toContain("no events");
    expect(verdictFor(503, { ok: false, umami: "misconfigured" }).summary).toContain(
      "not fully configured",
    );
  });

  test("names collector sections that are missing, stale, or reporting an error", () => {
    const v = verdictFor(503, {
      ok: false,
      pushed_problems: [
        { section: "egress", problem: "stale", detail: "last received 4h ago" },
        { section: "storage", problem: "reported_error", detail: "storage.collector.errors" },
      ],
    });
    expect(v.summary).toContain("egress stale (last received 4h ago)");
    expect(v.summary).toContain("storage reported_error (storage.collector.errors)");
  });

  test("says when a health check itself could not run", () => {
    const v = verdictFor(503, { ok: false, checks_failed: ["series", "pushed_sections"] });
    expect(v.summary).toContain("health checks could not run: series, pushed_sections");
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
