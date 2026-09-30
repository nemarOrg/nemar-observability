// /health must go red by itself when a source stops delivering: the S3 egress
// and website page-view series missing a closed UTC day (or never arriving), a
// collector section that is missing, stale, or reporting an error, and Umami
// unreachable, silent, or not fully configured. Real SQLite with this repo's
// migrations and a real local HTTP server for Umami; no mocks.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import {
  expectedLatestDay,
  loadPushedProblems,
  loadSeriesBehind,
  umamiHealth,
} from "../src/lib/freshness";
import { fetchUmamiLiveness, resetUmamiLivenessCache } from "../src/lib/umami";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-30T08:30:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

let engine: Database;

const EGRESS_SERIES = { source: "aws-s3-cloudwatch", label: "S3 bytes downloaded", unit: "bytes" };
const WEBSITE_SERIES = { source: "umami", label: "Umami pageviews", unit: "count" };

function seedSeries(
  latestDate: string | null,
  key = "s3_bytes_downloaded",
  section = "egress",
  meta = EGRESS_SERIES,
) {
  engine
    .query(
      `INSERT INTO daily_series (section_key, series_key, source, label, unit, aggregation, timezone,
         coverage_start, coverage_end, freshness_after_hours, updated_at)
       VALUES (?, ?, ?, ?, ?, 'sum', 'UTC', '2026-08-01', '2026-09-28', 36, '2026-09-29T08:19:00.000Z')`,
    )
    .run(section, key, meta.source, meta.label, meta.unit);
  if (latestDate) {
    engine
      .query(
        `INSERT INTO daily_series_points (section_key, series_key, date, value, updated_at)
         VALUES (?, ?, ?, 1, '2026-09-30T08:30:00.000Z')`,
      )
      .run(section, key, latestDate);
  }
}

/**
 * A stored collector section. `failedRun` is a collector that reported its own
 * failure (the error-only status); `lastOk` is when its last successful run
 * was (default: this delivery, unless the run failed).
 */
function seedSection(
  key: string,
  receivedAt: string,
  opts: {
    failedRun?: boolean;
    lastOk?: string | null;
    raw?: string;
    extraMetric?: object;
    source?: string;
  } = {},
): void {
  const failed = opts.failedRun === true;
  const json =
    opts.raw ??
    JSON.stringify({
      key,
      label: key,
      source: "aws-s3-cloudwatch",
      updated_at: receivedAt,
      metrics: [
        {
          key: `${key}.collector.errors`,
          label: "Errors",
          value: failed ? 1 : 0,
          unit: "errors",
          severity: failed ? "error" : "ok",
        },
        ...(opts.extraMetric ? [opts.extraMetric] : []),
      ],
    });
  const lastOk = opts.lastOk === undefined ? (failed ? null : receivedAt) : opts.lastOk;
  engine
    .query(
      "INSERT INTO ingested_sections (key, section_json, source, received_at, last_ok_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(key, json, opts.source ?? "aws-s3-cloudwatch", receivedAt, lastOk);
}

/**
 * The Umami pusher's section. Its only metric is `collector_health`, a display
 * level ("warn" when a week had no page views or the tracker asset is down), not
 * a `*.collector.errors` failure flag, so a delivery always counts as a success.
 * `lastOk` overrides when that success was (default: this delivery).
 */
function seedWebsite(
  receivedAt: string,
  opts: { severity?: "ok" | "warn"; lastOk?: string } = {},
): void {
  seedSection("website", receivedAt, {
    source: "umami",
    lastOk: opts.lastOk,
    raw: JSON.stringify({
      key: "website",
      label: "Website",
      source: "umami",
      updated_at: receivedAt,
      metrics: [
        {
          key: "collector_health",
          label: "Collector health",
          value: 1,
          unit: "status",
          severity: opts.severity ?? "ok",
        },
      ],
    }),
  });
}

/** Both expected daily series, egress at `egress` and page views at `views`. */
function seedExpectedSeries(egress: string | null, views: string | null = egress): void {
  seedSeries(egress);
  seedSeries(views, "pageviews", "website", WEBSITE_SERIES);
}

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
  resetUmamiLivenessCache();
});
afterEach(() => engine.close());

describe("expectedLatestDay", () => {
  test("is the day before yesterday until six hours after midnight UTC", () => {
    expect(expectedLatestDay(at("2026-09-30T00:15:00Z"))).toBe("2026-09-28");
    expect(expectedLatestDay(at("2026-09-30T05:59:59Z"))).toBe("2026-09-28");
  });

  test("is yesterday from six hours after midnight UTC", () => {
    expect(expectedLatestDay(at("2026-09-30T06:00:00Z"))).toBe("2026-09-29");
    expect(expectedLatestDay(at("2026-09-30T23:59:00Z"))).toBe("2026-09-29");
  });

  test("rolls back across a month, a year, and a leap day", () => {
    expect(expectedLatestDay(at("2026-03-01T05:59:59Z"))).toBe("2026-02-27");
    expect(expectedLatestDay(at("2026-03-01T06:00:00Z"))).toBe("2026-02-28");
    expect(expectedLatestDay(at("2027-01-01T05:00:00Z"))).toBe("2026-12-30");
    expect(expectedLatestDay(at("2027-01-01T06:00:00Z"))).toBe("2026-12-31");
    expect(expectedLatestDay(at("2028-03-01T06:00:00Z"))).toBe("2028-02-29");
  });
});

describe("loadSeriesBehind", () => {
  test("nothing is behind when the newest day is the expected one", async () => {
    seedExpectedSeries("2026-09-29");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([]);
  });

  test("a missing yesterday is reported once the grace has passed", async () => {
    seedExpectedSeries("2026-09-28", "2026-09-29");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([
      {
        section: "egress",
        key: "s3_bytes_downloaded",
        latest: "2026-09-28",
        expected: "2026-09-29",
      },
    ]);
  });

  test("today's open point cannot hide a missing yesterday", async () => {
    seedExpectedSeries("2026-09-28", "2026-09-29");
    engine
      .query(
        `INSERT INTO daily_series_points (section_key, series_key, date, value, updated_at)
         VALUES ('egress', 's3_bytes_downloaded', '2026-09-30', 1, '2026-09-30T08:30:00.000Z')`,
      )
      .run();
    const behind = await loadSeriesBehind(asD1(engine), NOW, true);
    expect(behind.map((s) => [s.key, s.latest])).toEqual([["s3_bytes_downloaded", "2026-09-28"]]);
  });

  test("website page views are held to the same rule", async () => {
    seedExpectedSeries("2026-09-29", "2026-09-28");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([
      { section: "website", key: "pageviews", latest: "2026-09-28", expected: "2026-09-29" },
    ]);
  });

  test("the same gap is tolerated inside the grace, so a normal night stays green", async () => {
    seedExpectedSeries("2026-09-28");
    expect(await loadSeriesBehind(asD1(engine), at("2026-09-30T03:00:00Z"), true)).toEqual([]);
  });

  test("a series with no observations is behind", async () => {
    seedExpectedSeries(null, "2026-09-29");
    const behind = await loadSeriesBehind(asD1(engine), NOW, true);
    expect(behind.map((s) => [s.key, s.latest])).toEqual([["s3_bytes_downloaded", null]]);
  });

  // A first ingest that is rejected every time (wrong token, 409, 422) never
  // registers the series, so health must not read the absence as "nothing to check".
  // The Worker's own cron writes cf/requests, and it only runs after a deploy,
  // so its absence must not fail the deploy check; a stalled one must.
  test("the cron-seeded cf series is tolerated when absent but reported when stalled", async () => {
    seedExpectedSeries("2026-09-29", "2026-09-29");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([]);
    seedSeries("2026-09-27", "requests", "cf", {
      source: "cloudflare",
      label: "Network edge requests",
      unit: "count",
    });
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([
      { section: "cf", key: "requests", latest: "2026-09-27", expected: "2026-09-29" },
    ]);
  });

  test("in production, a series that never arrived is behind", async () => {
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([
      { section: "egress", key: "s3_bytes_downloaded", latest: null, expected: "2026-09-29" },
      { section: "website", key: "pageviews", latest: null, expected: "2026-09-29" },
    ]);
  });

  test("the website series alone missing is reported by its key", async () => {
    seedSeries("2026-09-29");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([
      { section: "website", key: "pageviews", latest: null, expected: "2026-09-29" },
    ]);
  });

  test("outside production, a series that never arrived is not a fault", async () => {
    expect(await loadSeriesBehind(asD1(engine), NOW, false)).toEqual([]);
  });

  test("a third-party series is not held to the first-party rule", async () => {
    seedExpectedSeries("2026-09-29");
    seedSeries("2026-09-01", "qa_checks", "qa");
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([]);
  });

  // Umami's event series (event_<name>) are pushed only once event coverage is
  // enabled, so they are not expected and cannot hold health red.
  test("a website event series that is behind is not judged", async () => {
    seedExpectedSeries("2026-09-29");
    seedSeries("2026-09-10", "event_citation_click", "website", WEBSITE_SERIES);
    expect(await loadSeriesBehind(asD1(engine), NOW, true)).toEqual([]);
  });
});

describe("loadPushedProblems", () => {
  test("nothing is wrong when all three collectors succeeded recently", async () => {
    seedSection("egress", hoursAgo(1));
    seedSection("storage", hoursAgo(10));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);
  });

  test("in production, a collector section that never arrived is a problem", async () => {
    const problems = await loadPushedProblems(asD1(engine), NOW, true);
    expect(problems.map((p) => `${p.section}:${p.problem}`)).toEqual([
      "egress:missing",
      "storage:missing",
      "website:missing",
    ]);
  });

  test("outside production, missing collector sections are not a fault", async () => {
    expect(await loadPushedProblems(asD1(engine), NOW, false)).toEqual([]);
  });

  test("a day and two hours without a successful run is stale, less is not", async () => {
    seedSection("egress", hoursAgo(1), { lastOk: hoursAgo(25) });
    seedSection("storage", hoursAgo(1), { lastOk: hoursAgo(27) });
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([
      { section: "storage", problem: "stale", detail: "last success 27h ago" },
    ]);
  });

  test("the website window is pinned like the others: 25 hours is fine, 27 is stale", async () => {
    seedSection("egress", hoursAgo(1));
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1), { lastOk: hoursAgo(25) });
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);

    engine.run("DELETE FROM ingested_sections WHERE key = 'website'");
    seedWebsite(hoursAgo(1), { lastOk: hoursAgo(27) });
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([
      { section: "website", problem: "stale", detail: "last success 27h ago" },
    ]);
  });

  // collector_health is the pusher's display level (no page views for a week, or
  // the tracker asset down), not a failed run; Umami's own liveness covers the
  // former, and a warning must not read as a collector that stopped.
  test("a website collector_health warning is delivered data, not a problem", async () => {
    seedSection("egress", hoursAgo(1));
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1), { severity: "warn" });
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);
  });

  test("the old once-a-day timer stays green until the hourly one is installed", async () => {
    seedSection("egress", hoursAgo(24));
    seedSection("storage", hoursAgo(19));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);
  });

  test("one failed run is not a problem while an earlier run succeeded", async () => {
    seedSection("egress", hoursAgo(0.1), { failedRun: true, lastOk: hoursAgo(1.1) });
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);
  });

  test("failures that persist past the window are stale even though each refreshed the section", async () => {
    seedSection("egress", hoursAgo(0.1), { failedRun: true, lastOk: hoursAgo(30) });
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([
      { section: "egress", problem: "stale", detail: "last success 30h ago" },
    ]);
  });

  test("a collector that has never succeeded is stale", async () => {
    seedSection("egress", hoursAgo(0.1), { failedRun: true });
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([
      { section: "egress", problem: "stale", detail: "no successful run yet" },
    ]);
  });

  test("a collector whose code has stopped updating is reported by its metric key", async () => {
    seedSection("egress", hoursAgo(1), {
      extraMetric: {
        key: "egress.collector.code_stale",
        label: "Collector code updates",
        value: 1,
        unit: "errors",
        severity: "error",
      },
    });
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([
      { section: "egress", problem: "code_stale", detail: "egress.collector.code_stale" },
    ]);
  });

  test("a stored section that is not valid JSON is unreadable", async () => {
    seedSection("egress", hoursAgo(1), { raw: "{not json" });
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    const problems = await loadPushedProblems(asD1(engine), NOW, true);
    expect(problems.map((p) => p.problem)).toEqual(["unreadable"]);
  });

  test("a third-party section is not judged: its severity is a display level", async () => {
    seedSection("egress", hoursAgo(1));
    seedSection("storage", hoursAgo(1));
    seedWebsite(hoursAgo(1));
    seedSection("qa", hoursAgo(900), { failedRun: true, lastOk: null });
    engine.query("UPDATE ingested_sections SET section_json = ? WHERE key = 'qa'").run(
      JSON.stringify({
        key: "qa",
        label: "QA",
        source: "qa-pipeline",
        updated_at: NOW.toISOString(),
        metrics: [{ key: "qa.failed_validations", label: "Failed", value: 9, severity: "error" }],
      }),
    );
    expect(await loadPushedProblems(asD1(engine), NOW, true)).toEqual([]);
  });
});

describe("umamiHealth", () => {
  const recent = { state: "ok", lastEventAt: NOW.getTime() - 20 * 60_000 } as const;

  test("recent events are ok", () => {
    expect(umamiHealth(recent, NOW, true)).toBe("ok");
  });
  test("events older than six hours are silent", () => {
    const stale = { state: "ok", lastEventAt: NOW.getTime() - 6 * 3_600_000 - 1 } as const;
    expect(umamiHealth(stale, NOW, true)).toBe("silent");
  });
  test("unreachable and misconfigured pass through", () => {
    expect(umamiHealth({ state: "unreachable", reason: "timeout" }, NOW, true)).toBe("unreachable");
    expect(umamiHealth({ state: "misconfigured" }, NOW, false)).toBe("misconfigured");
  });
  test("production must be configured; only other environments may go without", () => {
    expect(umamiHealth({ state: "unconfigured" }, NOW, true)).toBe("misconfigured");
    expect(umamiHealth({ state: "unconfigured" }, NOW, false)).toBe("unconfigured");
  });
});

describe("Umami liveness over HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastEventAt = Date.now();
  let answer: () => Response = () => new Response("unset", { status: 500 });
  let requests = 0;
  let requestedAuth: string | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requests++;
        requestedAuth = req.headers.get("authorization");
        return answer();
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    requests = 0;
    lastEventAt = Date.now();
    answer = () => Response.json({ startAt: 1, endAt: lastEventAt });
  });

  const env = (extra: Partial<Bindings> = {}) =>
    ({
      UMAMI_BASE_URL: `http://localhost:${server.port}`,
      UMAMI_WEBSITE_ID: "site-1",
      UMAMI_API_KEY: "key-1",
      ...extra,
    }) as Bindings;
  const fast = { retryDelayMs: 0, cacheMs: 0 };

  test("reports the newest event and authenticates with the key", async () => {
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({ state: "ok", lastEventAt });
    expect(requestedAuth).toBe("Bearer key-1");
  });

  test("understands the ISO date-time shape a live Umami returns", async () => {
    const newest = new Date(Date.now() - 60_000);
    answer = () =>
      Response.json({
        startDate: "2026-09-28T00:00:00.000Z",
        endDate: newest.toISOString(),
      });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({
      state: "ok",
      lastEventAt: newest.getTime(),
    });
  });

  test("a newest event far in the future is an invalid response, not liveness", async () => {
    answer = () => Response.json({ startAt: 1, endAt: Date.now() + 3 * 3_600_000 });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({
      state: "unreachable",
      reason: "invalid_response",
    });
  });

  test("names why it failed: a rotated key, a wrong website, a server error", async () => {
    answer = () => new Response("no", { status: 401 });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({
      state: "unreachable",
      reason: "http_401",
    });
    answer = () => new Response("no", { status: 404 });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({
      state: "unreachable",
      reason: "http_404",
    });
    answer = () => new Response("no", { status: 502 });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({
      state: "unreachable",
      reason: "http_error",
    });
  });

  test("a server that is not there is a network failure", async () => {
    const dead = env({ UMAMI_BASE_URL: "http://localhost:1" });
    expect(await fetchUmamiLiveness(dead, fast)).toEqual({
      state: "unreachable",
      reason: "network",
    });
  });

  test("one failed attempt is retried, so a single blip does not read as an outage", async () => {
    let calls = 0;
    answer = () =>
      ++calls === 1
        ? new Response("blip", { status: 502 })
        : Response.json({ startAt: 1, endAt: lastEventAt });
    expect(await fetchUmamiLiveness(env(), fast)).toEqual({ state: "ok", lastEventAt });
    expect(calls).toBe(2);
  });

  test("the answer is kept for a minute, so a loop on /health cannot loop on Umami", async () => {
    await fetchUmamiLiveness(env(), { retryDelayMs: 0 });
    await fetchUmamiLiveness(env(), { retryDelayMs: 0 });
    await fetchUmamiLiveness(env(), { retryDelayMs: 0 });
    expect(requests).toBe(1);
  });

  test("nothing set is unconfigured; some but not all set is misconfigured", async () => {
    expect(await fetchUmamiLiveness({} as Bindings, fast)).toEqual({ state: "unconfigured" });
    expect(await fetchUmamiLiveness(env({ UMAMI_API_KEY: "  " }), fast)).toEqual({
      state: "misconfigured",
    });
    expect(await fetchUmamiLiveness(env({ UMAMI_WEBSITE_ID: undefined }), fast)).toEqual({
      state: "misconfigured",
    });
  });

  describe("/health", () => {
    function seedHealthy(): void {
      const now = new Date().toISOString();
      engine
        .query("UPDATE cron_status SET last_success_at = ?, last_run_at = ? WHERE id = 1")
        .run(now, now);
      engine
        .query("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)")
        .run(now, JSON.stringify({ schema_version: "1.0", generated_at: now, sections: [] }));
    }
    const production = (extra: Partial<Bindings> = {}) =>
      ({ ...env(), ENVIRONMENT: "production", OBS_DB: asD1(engine), ...extra }) as Bindings;
    const call = (bindings: Bindings) => {
      resetUmamiLivenessCache();
      return worker.fetch(new Request("https://x/observability/health"), bindings, ctx);
    };
    const freshDay = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const seedCollectors = () => {
      seedExpectedSeries(freshDay());
      seedSection("egress", new Date().toISOString());
      seedSection("storage", new Date().toISOString());
      seedWebsite(new Date().toISOString());
    };

    test("200 in production when every source is delivering", async () => {
      seedHealthy();
      seedCollectors();
      const res = await call(production());
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        umami: "ok",
        series_behind: [],
        pushed_problems: [],
        checks_failed: [],
      });
    });

    test("503 when Umami has gone silent", async () => {
      seedHealthy();
      seedCollectors();
      lastEventAt = Date.now() - 7 * 3_600_000;
      const res = await call(production());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, umami: "silent" });
    });

    test("503 with the reason when Umami rejects the key", async () => {
      seedHealthy();
      seedCollectors();
      answer = () => new Response("no", { status: 401 });
      const res = await call(production());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        ok: false,
        umami: "unreachable",
        umami_reason: "http_401",
      });
    });

    test("503 in production when the Umami secret is gone", async () => {
      seedHealthy();
      seedCollectors();
      const res = await call(
        production({
          UMAMI_API_KEY: undefined,
          UMAMI_BASE_URL: undefined,
          UMAMI_WEBSITE_ID: undefined,
        }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, umami: "misconfigured" });
    });

    test("200 outside production with no Umami and no collectors", async () => {
      seedHealthy();
      const res = await call({ OBS_DB: asD1(engine) } as Bindings);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, umami: "unconfigured" });
    });

    test("503 when the egress series never arrived", async () => {
      seedHealthy();
      seedSeries(freshDay(), "pageviews", "website", WEBSITE_SERIES);
      seedSection("egress", new Date().toISOString());
      seedSection("storage", new Date().toISOString());
      seedWebsite(new Date().toISOString());
      const res = await call(production());
      expect(res.status).toBe(503);
      const body = (await res.json()) as { series_behind: { key: string; latest: null }[] };
      expect(body.series_behind).toEqual([
        expect.objectContaining({ key: "s3_bytes_downloaded", latest: null }),
      ]);
    });

    test("503 when the website pusher never delivered", async () => {
      seedHealthy();
      seedSeries(freshDay());
      seedSection("egress", new Date().toISOString());
      seedSection("storage", new Date().toISOString());
      const res = await call(production());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        ok: false,
        series_behind: [{ section: "website", key: "pageviews", latest: null }],
        pushed_problems: [{ section: "website", problem: "missing" }],
      });
    });

    test("503 when a collector has not succeeded for over a day", async () => {
      seedHealthy();
      seedExpectedSeries(freshDay());
      seedSection("egress", new Date().toISOString(), { lastOk: hoursAgo(80) });
      seedSection("storage", new Date().toISOString());
      seedWebsite(new Date().toISOString());
      const res = await call(production());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        ok: false,
        pushed_problems: [{ section: "egress", problem: "stale" }],
      });
    });

    test("a freshness check that cannot run is named, and the rest of the report survives", async () => {
      seedHealthy();
      seedCollectors();
      engine.run("DROP TABLE daily_series_points");
      engine.run("DROP TABLE daily_series");
      const res = await call(production());
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        checks_failed: ["series"],
        umami: "ok",
        snapshot: "ok",
      });
      expect(body.error).toBeUndefined();
      expect(body.cron).toBeTruthy();
    });
  });
});
