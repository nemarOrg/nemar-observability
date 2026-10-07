// Zarr coverage must keep moving while conversion work continues.
//
// Production on 2026-10-07: 734 of 766 public datasets were "ready", a number
// that had flatlined, while 100 of those datasets had recordings that did not
// convert and 5 more were mid-rebuild. Dataset-level readiness cannot show
// recording-level progress, so the section also reports recordings converted
// against recordings found, and a strict "fully converted" dataset count.
//
// Real SQL against a real SQLite engine via the D1 adapter; no mocks.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { zarrSection } from "../src/lib/metrics";
import { asD1 } from "./helpers/d1";

const NOW = "2026-10-07T04:00:00.000Z";

const DDL = `CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  is_sandbox INTEGER DEFAULT 0,
  status TEXT,
  visibility TEXT,
  zarr_status TEXT,
  zarr_store_count INTEGER,
  zarr_errors INTEGER,
  zarr_converted_at TEXT,
  recording_count INTEGER
);`;

type Row = {
  id: string;
  zarr: string | null;
  stores?: number | null;
  errors?: number | null;
  converted?: string | null;
  recordings?: number | null;
  owner?: number;
  sandbox?: number;
  status?: string;
  visibility?: string;
};

let engine: Database;

function insert(r: Row): void {
  engine
    .query(
      `INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, zarr_status, zarr_store_count, zarr_errors, zarr_converted_at, recording_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.owner ?? 1,
      r.sandbox ?? 0,
      r.status ?? "active",
      r.visibility ?? "public",
      r.zarr,
      r.stores ?? null,
      r.errors ?? null,
      r.converted ?? null,
      r.recordings ?? null,
    );
}

const metricsOf = async () => {
  const s = await zarrSection(asD1(engine), NOW);
  return Object.fromEntries(s.metrics.map((m) => [m.key, m]));
};

beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(DDL);
});
afterEach(() => engine.close());

describe("zarrSection", () => {
  beforeEach(() => {
    // Ready, every recording converted.
    insert({ id: "nm1", zarr: "ready", stores: 100, errors: 0, recordings: 100 });
    // Ready, but 10 recordings failed: the case dataset-level readiness hides.
    insert({ id: "nm2", zarr: "ready", stores: 50, errors: 10, recordings: 60 });
    // Ready, never swept (no recording_count) and no error column value.
    insert({ id: "nm3", zarr: "ready", stores: 5 });
    // Ready, but the sweep count lags a rebuild that converted more.
    insert({ id: "nm4", zarr: "ready", stores: 12, errors: 0, recordings: 10 });
    // Mid-rebuild with no confirmation for 40 days.
    insert({
      id: "p1",
      zarr: "pending",
      stores: 240,
      recordings: 240,
      converted: "2026-08-28 10:00:00",
    });
    // Mid-rebuild, confirmed yesterday (the nm000276 shape: 12 of 40).
    insert({
      id: "p2",
      zarr: "pending",
      stores: 12,
      recordings: 40,
      converted: "2026-10-06 03:00:00",
    });
    // Dispatched, never converted.
    insert({ id: "p3", zarr: "pending" });
    // Failed outright: no stores, 90 recordings failed, never swept.
    insert({ id: "f1", zarr: "failed", stores: 0, errors: 90 });
    // None of these may influence any number.
    insert({ id: "priv", zarr: "ready", stores: 999, visibility: "private" });
    insert({ id: "sbx", zarr: "ready", stores: 999, sandbox: 1 });
    insert({ id: "cat", zarr: "ready", stores: 999, owner: -1 });
    insert({ id: "gone", zarr: "ready", stores: 999, status: "deleted" });
  });

  test("keeps the dataset-level counts", async () => {
    const m = await metricsOf();
    expect(m["zarr.ready"].value).toBe(4);
    expect(m["zarr.ready"].total).toBe(8);
    expect(m["zarr.pending"].value).toBe(3);
    expect(m["zarr.failed"].value).toBe(1);
    // Ready datasets only: a dataset mid-rebuild is left out until it finishes.
    expect(m["zarr.stores"].value).toBe(167);
  });

  test("fully converted excludes ready datasets with failed recordings", async () => {
    const m = await metricsOf();
    // nm1, nm3 (no error recorded) and nm4; nm2 has 10 failures.
    expect(m["zarr.complete"].value).toBe(3);
    expect(m["zarr.complete"].total).toBe(8);
    expect(m["zarr.partial"].value).toBe(1);
    expect(m["zarr.partial"].severity).toBe("warn");
    expect(m["zarr.partial"].hint).toContain("10 recordings");
  });

  test("recordings converted counts stores of every dataset against all recordings found", async () => {
    const m = await metricsOf();
    // Converted: 100 + 50 + 5 + 12 + 240 + 12 = 419 (pending datasets keep their
    // last confirmed stores; the failed dataset has none).
    expect(m["zarr.recordings"].value).toBe(419);
    // Found: 100 + 60 + 5 + max(10, 12) + 240 + 40 + 0 + 90 = 547.
    expect(m["zarr.recordings"].total).toBe(547);
    expect(m["zarr.recordings"].unit).toBe("count");
  });

  test("flags pending datasets with no confirmed conversion in a week", async () => {
    const m = await metricsOf();
    // p1 (40 days) and p3 (never); p2 was confirmed yesterday.
    expect(m["zarr.pending"].hint).toContain("2 of these");
  });

  test("an empty catalog reports zeros, not an error", async () => {
    engine.run("DELETE FROM datasets");
    const m = await metricsOf();
    expect(m["zarr.recordings"].value).toBe(0);
    expect(m["zarr.recordings"].total).toBe(0);
    expect(m["zarr.complete"].value).toBe(0);
    expect(m["zarr.pending"].hint).not.toContain("of these");
  });
});
