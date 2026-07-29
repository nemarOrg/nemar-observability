// /observability/health is the alerting contract (issue #7). It must report
// unhealthy for every fault that makes the dashboard lie to a reader, not just
// for the Worker being down. Runs the real handler against a real SQLite OBS_DB
// carrying this repo's actual migration — no mocks.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";

const MIGRATION = await Bun.file(
  new URL("../src/db/migrations/0001_init.sql", import.meta.url),
).text();

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let engine: Database;
let env: Bindings;

/** A schema-valid snapshot, optionally carrying section_errors. */
function snapshotJson(at: string, errors: { key: string; error: string }[] = []): string {
  return JSON.stringify({
    schema_version: "1.0",
    generated_at: at,
    sections: [
      {
        key: "datasets",
        label: "Datasets",
        source: "nemar-cli",
        updated_at: at,
        metrics: [
          {
            key: "datasets.public",
            label: "Public",
            value: 754,
            unit: "datasets",
            severity: "info",
          },
        ],
      },
    ],
    ...(errors.length ? { section_errors: errors } : {}),
  });
}

function seed(at: string, errors: { key: string; error: string }[] = []): void {
  engine
    .query("UPDATE cron_status SET last_success_at = ?, last_run_at = ? WHERE id = 1")
    .run(at, at);
  engine
    .query("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)")
    .run(at, snapshotJson(at, errors));
}

const health = () => worker.fetch(new Request("https://x/observability/health"), env, ctx);

beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(MIGRATION);
  env = { OBS_DB: asD1(engine) } as Bindings;
});
afterEach(() => engine.close());

describe("health", () => {
  test("200 ok when the snapshot is fresh and every section computed", async () => {
    seed(new Date().toISOString());
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      service: "nemar-observability",
      stale: false,
      section_errors: [],
    });
  });

  // The regression this issue was filed for: the `sync` section threw for weeks
  // (nemar-cli migration 0053 dropped nemar_sync_status) while health kept
  // answering {"ok":true}, because Promise.allSettled swallows per-section
  // failures into section_errors and health never read them.
  test("503 when a section failed to compute, even though the cron succeeded", async () => {
    seed(new Date().toISOString(), [{ key: "sync", error: "D1_ERROR: no such column" }]);
    const res = await health();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; stale: boolean; section_errors: string[] };
    expect(body.ok).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.section_errors).toEqual(["sync"]);
  });

  test("503 when the last successful snapshot is older than the stale window", async () => {
    seed(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    const res = await health();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, stale: true });
  });

  test("503 when the cron has never succeeded", async () => {
    const res = await health(); // migration seeds cron_status with NULLs
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, stale: true });
  });

  // "Cannot tell" must not read as healthy: a monitor that goes quiet when its
  // own store breaks is the blind spot this issue is closing.
  test("503 store_unavailable when OBS_DB is unreadable", async () => {
    env = {} as Bindings;
    const res = await health();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "store_unavailable" });
  });
});
