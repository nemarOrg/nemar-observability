// The scheduled handler must wait out nemar-db's hourly backup export instead of
// saving a snapshot with every D1-backed tile missing. This runs the real
// handler against real SQLite stores, with the shared database refusing its
// first read the way D1 does mid-export, then serving normally.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { handleScheduled } from "../src/cron";
import type { RetryPolicy } from "../src/lib/d1-retry";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const EXPORT_LOCK = new Error("D1_ERROR: Currently processing a long-running export.");
const noWait = (retried: string[]): RetryPolicy => ({
  delaysMs: [1, 1, 1],
  sleep: async () => {},
  onRetry: (label) => retried.push(label),
});

function stores(refusals: number) {
  const obs = new Database(":memory:");
  for (const sql of MIGRATIONS) obs.run(sql);
  const nemar = new Database(":memory:");
  nemar.run(`CREATE TABLE datasets (
    dataset_id TEXT, owner_user_id INTEGER, is_sandbox INTEGER, status TEXT, visibility TEXT,
    concept_doi TEXT, zarr_status TEXT, archive_status TEXT, archive_skip_reason TEXT,
    license_tier TEXT, modalities TEXT, file_size INTEGER, last_activity_at TEXT
  );`);
  const real = asD1(nemar);
  let left = refusals;
  const locked = {
    prepare(sql: string) {
      if (left > 0) {
        left--;
        throw EXPORT_LOCK;
      }
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
  return { obs, nemar, env: { OBS_DB: asD1(obs), NEMAR_DB: locked } as unknown as Bindings };
}

const lockErrors = (obs: Database) => {
  const row = obs.query("SELECT snapshot_json FROM snapshots ORDER BY id DESC LIMIT 1").get() as {
    snapshot_json: string;
  };
  const snap = JSON.parse(row.snapshot_json) as {
    sections: { key: string }[];
    section_errors?: { key: string; error: string }[];
  };
  return {
    sections: snap.sections.map((s) => s.key),
    locked: (snap.section_errors ?? []).filter((e) => e.error.includes("long-running export")),
  };
};

describe("scheduled snapshot during the nemar-db backup export", () => {
  test("waits out a locked read and saves a complete snapshot", async () => {
    const { obs, nemar, env } = stores(2);
    const retried: string[] = [];
    await handleScheduled(env, noWait(retried));

    const { sections, locked } = lockErrors(obs);
    expect(locked).toEqual([]);
    expect(sections).toContain("datasets");
    expect(retried.length).toBe(2);
    const cron = obs
      .query("SELECT last_success_at, last_error FROM cron_status WHERE id = 1")
      .get() as {
      last_success_at: string | null;
      last_error: string | null;
    };
    expect(cron.last_success_at).not.toBeNull();
    expect(cron.last_error).toBeNull();
    obs.close();
    nemar.close();
  });

  test("a lock that outlasts the retries is recorded, not hidden", async () => {
    const { obs, nemar, env } = stores(1000);
    await handleScheduled(env, noWait([]));
    const { locked } = lockErrors(obs);
    expect(locked.length).toBeGreaterThan(0);
    obs.close();
    nemar.close();
  });
});
