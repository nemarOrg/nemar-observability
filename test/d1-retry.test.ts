// nemar-db is exported hourly by nemar-cli's backup job, and D1 rejects other
// queries while that runs. These tests pin what may be retried and what must
// fail at once, and that a locked builder recovers inside a real snapshot.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { NO_RETRY, isTransientD1Error, withD1Retry } from "../src/lib/d1-retry";
import { buildSnapshot } from "../src/lib/metrics";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";

const EXPORT_LOCK = new Error("D1_ERROR: Currently processing a long-running export.");
const noWait = { delaysMs: [1, 1, 1], sleep: async () => {} };

describe("isTransientD1Error", () => {
  test("recognizes the export lock, wrapped or plain", () => {
    expect(isTransientD1Error(EXPORT_LOCK)).toBe(true);
    expect(isTransientD1Error("Error: D1_ERROR: Currently processing a long-running export.")).toBe(
      true,
    );
    expect(isTransientD1Error(new Error("D1_ERROR: Network connection lost, busy"))).toBe(true);
  });

  test("does not treat a broken query or missing table as transient", () => {
    expect(isTransientD1Error(new Error("D1_ERROR: no such table: datasets"))).toBe(false);
    expect(isTransientD1Error(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("withD1Retry", () => {
  test("returns the first success without waiting", async () => {
    let calls = 0;
    const out = await withD1Retry(async () => ++calls, noWait);
    expect(out).toBe(1);
  });

  test("waits out a transient lock and then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await withD1Retry(
      async () => {
        if (++calls < 3) throw EXPORT_LOCK;
        return "ok";
      },
      { delaysMs: [5, 15, 45], sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(waits).toEqual([5, 15]);
  });

  test("gives up after the last delay and throws the lock error", async () => {
    let calls = 0;
    await expect(
      withD1Retry(async () => {
        calls++;
        throw EXPORT_LOCK;
      }, noWait),
    ).rejects.toBe(EXPORT_LOCK);
    expect(calls).toBe(4);
  });

  test("fails at once on a non-transient error", async () => {
    let calls = 0;
    await expect(
      withD1Retry(async () => {
        calls++;
        throw new Error("D1_ERROR: no such table: datasets");
      }, noWait),
    ).rejects.toThrow("no such table");
    expect(calls).toBe(1);
  });

  test("the default policy never retries", async () => {
    let calls = 0;
    await expect(
      withD1Retry(async () => {
        calls++;
        throw EXPORT_LOCK;
      }, NO_RETRY),
    ).rejects.toBe(EXPORT_LOCK);
    expect(calls).toBe(1);
  });
});

describe("buildSnapshot during a backup export", () => {
  // A real SQLite engine behind the D1 surface that refuses the first read the
  // way D1 does mid-export, then serves normally. No query is altered.
  function lockedFor(engine: Database, refusals: number): D1Database {
    const real = asD1(engine);
    let left = refusals;
    return {
      prepare(sql: string) {
        if (left > 0) {
          left--;
          throw EXPORT_LOCK;
        }
        return real.prepare(sql);
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;
  }

  const DATASETS = `
    CREATE TABLE datasets (
      dataset_id TEXT, owner_user_id INTEGER, is_sandbox INTEGER, status TEXT, visibility TEXT,
      concept_doi TEXT, zarr_status TEXT, archive_status TEXT, archive_skip_reason TEXT,
      license_tier TEXT, modalities TEXT, file_size INTEGER, last_activity_at TEXT
    );`;

  const lockErrors = (snap: Awaited<ReturnType<typeof buildSnapshot>>) =>
    (snap.section_errors ?? []).filter((e) => e.error.includes("long-running export"));

  test("a locked read is reported when no retry policy is given", async () => {
    const engine = new Database(":memory:");
    engine.run(DATASETS);
    const env = { NEMAR_DB: lockedFor(engine, 1) } as unknown as Bindings;
    expect(lockErrors(await buildSnapshot(env)).length).toBe(1);
    engine.close();
  });

  test("the same lock is waited out when a retry policy is given", async () => {
    const engine = new Database(":memory:");
    engine.run(DATASETS);
    const env = { NEMAR_DB: lockedFor(engine, 1) } as unknown as Bindings;
    const snap = await buildSnapshot(env, noWait);
    expect(lockErrors(snap)).toEqual([]);
    expect(snap.sections.map((s) => s.key)).toContain("datasets");
    engine.close();
  });
});
