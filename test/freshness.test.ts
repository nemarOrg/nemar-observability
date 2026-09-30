// /health must go red by itself when a source stops delivering: a pushed daily
// series missing a closed UTC day (S3 egress), or Umami unreachable or silent.
// Real SQLite with this repo's migrations, and a real local HTTP server for
// Umami; no mocks.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { expectedLatestDay, loadSeriesBehind, umamiHealth } from "../src/lib/freshness";
import { fetchUmamiLiveness } from "../src/lib/umami";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";

const MIGRATIONS = await Promise.all(
  [
    "0001_init.sql",
    "0002_cf_daily_host.sql",
    "0003_daily_series.sql",
    "0004_atomic_section_ingest.sql",
  ].map((name) => Bun.file(new URL(`../src/db/migrations/${name}`, import.meta.url)).text()),
);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const at = (iso: string) => new Date(iso);

let engine: Database;

function seedSeries(latestDate: string | null): void {
  engine.run(
    `INSERT INTO daily_series (section_key, series_key, source, label, unit, aggregation, timezone,
       coverage_start, coverage_end, freshness_after_hours, updated_at)
     VALUES ('egress', 's3_bytes_downloaded', 'aws-s3-cloudwatch', 'S3 bytes downloaded', 'bytes',
       'sum', 'UTC', '2026-08-01', '2026-09-28', 36, '2026-09-29T08:19:00.000Z')`,
  );
  if (latestDate) {
    engine
      .query(
        `INSERT INTO daily_series_points (section_key, series_key, date, value, updated_at)
         VALUES ('egress', 's3_bytes_downloaded', ?, 1, '2026-09-30T08:30:00.000Z')`,
      )
      .run(latestDate);
  }
}

beforeEach(() => {
  engine = new Database(":memory:");
  for (const sql of MIGRATIONS) engine.run(sql);
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
});

describe("loadSeriesBehind", () => {
  test("nothing is behind when the newest day is the expected one", async () => {
    seedSeries("2026-09-29");
    expect(await loadSeriesBehind(asD1(engine), at("2026-09-30T08:30:00Z"))).toEqual([]);
  });

  test("a missing yesterday is reported once the grace has passed", async () => {
    seedSeries("2026-09-28");
    expect(await loadSeriesBehind(asD1(engine), at("2026-09-30T08:30:00Z"))).toEqual([
      { key: "s3_bytes_downloaded", latest: "2026-09-28", expected: "2026-09-29" },
    ]);
  });

  test("the same gap is tolerated inside the grace, so a normal night stays green", async () => {
    seedSeries("2026-09-28");
    expect(await loadSeriesBehind(asD1(engine), at("2026-09-30T03:00:00Z"))).toEqual([]);
  });

  test("a series with no observations is behind", async () => {
    seedSeries(null);
    const behind = await loadSeriesBehind(asD1(engine), at("2026-09-30T08:30:00Z"));
    expect(behind.map((s) => s.latest)).toEqual([null]);
  });

  test("no series at all is not a fault", async () => {
    expect(await loadSeriesBehind(asD1(engine), at("2026-09-30T08:30:00Z"))).toEqual([]);
  });
});

describe("umamiHealth", () => {
  const now = at("2026-09-30T08:30:00Z");
  test("recent events are ok", () => {
    const last = now.getTime() - 20 * 60_000;
    expect(umamiHealth({ state: "ok", lastEventAt: last }, now)).toBe("ok");
  });
  test("events older than six hours are silent", () => {
    const last = now.getTime() - 6 * 3_600_000 - 1;
    expect(umamiHealth({ state: "ok", lastEventAt: last }, now)).toBe("silent");
  });
  test("unreachable and unconfigured pass through", () => {
    expect(umamiHealth({ state: "unreachable" }, now)).toBe("unreachable");
    expect(umamiHealth({ state: "unconfigured" }, now)).toBe("unconfigured");
  });
});

describe("Umami liveness over HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  let lastEventAt = Date.now();
  let failing = false;
  let requestedAuth: string | null = null;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        requestedAuth = req.headers.get("authorization");
        if (failing) return new Response("nope", { status: 502 });
        if (new URL(req.url).pathname.endsWith("/daterange")) {
          return Response.json({
            startDate: "2026-09-28T00:00:00.000Z",
            endAt: lastEventAt,
            startAt: 1,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    failing = false;
    lastEventAt = Date.now();
  });

  const env = () =>
    ({
      UMAMI_BASE_URL: `http://localhost:${server.port}`,
      UMAMI_WEBSITE_ID: "site-1",
      UMAMI_API_KEY: "key-1",
    }) as Bindings;

  test("reports the newest event and authenticates with the key", async () => {
    const live = await fetchUmamiLiveness(env());
    expect(live).toEqual({ state: "ok", lastEventAt });
    expect(requestedAuth).toBe("Bearer key-1");
  });

  test("an API error is unreachable", async () => {
    failing = true;
    expect(await fetchUmamiLiveness(env())).toEqual({ state: "unreachable" });
  });

  test("missing configuration is unconfigured, not a fault", async () => {
    expect(await fetchUmamiLiveness({} as Bindings)).toEqual({ state: "unconfigured" });
  });

  test("/health is 503 when Umami has gone silent and 200 when it is live", async () => {
    const nowIso = new Date().toISOString();
    engine
      .query("UPDATE cron_status SET last_success_at = ?, last_run_at = ? WHERE id = 1")
      .run(nowIso, nowIso);
    engine.query("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)").run(
      new Date().toISOString(),
      JSON.stringify({
        schema_version: "1.0",
        generated_at: new Date().toISOString(),
        sections: [],
      }),
    );
    const call = () =>
      worker.fetch(
        new Request("https://x/observability/health"),
        { ...env(), OBS_DB: asD1(engine) } as Bindings,
        ctx,
      );

    const live = await call();
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true, umami: "ok", series_behind: [] });

    lastEventAt = Date.now() - 7 * 3_600_000;
    const silent = await call();
    expect(silent.status).toBe(503);
    expect(await silent.json()).toMatchObject({ ok: false, umami: "silent" });
  });

  test("/health is 503 when a daily series is missing a closed day", async () => {
    seedSeries("2020-01-01");
    const nowIso = new Date().toISOString();
    engine
      .query("UPDATE cron_status SET last_success_at = ?, last_run_at = ? WHERE id = 1")
      .run(nowIso, nowIso);
    engine.query("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)").run(
      new Date().toISOString(),
      JSON.stringify({
        schema_version: "1.0",
        generated_at: new Date().toISOString(),
        sections: [],
      }),
    );
    const res = await worker.fetch(
      new Request("https://x/observability/health"),
      { ...env(), OBS_DB: asD1(engine) } as Bindings,
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { series_behind: { key: string }[] };
    expect(body.series_behind.map((s) => s.key)).toEqual(["s3_bytes_downloaded"]);
  });
});
