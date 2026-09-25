// Validates the metric/drill-down SQL predicates against a real in-memory
// SQLite (bun:sqlite, no mocks). We run the EXACT predicate strings the worker
// uses (imported from src/lib/sql) against a representative `datasets` table,
// so the counts the dashboard reports are proven to match the intended rows.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { MANAGED, PRIVATE_MANAGED, PUBLIC_MANAGED, PUBLISHED } from "../src/lib/sql";

// Minimal slice of nemar-db.datasets — only the columns the predicates touch.
const DDL = `CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'private',
  concept_doi TEXT,
  archive_status TEXT,
  -- Set when the >100 GB policy declines to build an archive (nemar-cli #752).
  -- archive_status stays NULL in that case, which is exactly why a predicate
  -- keyed on archive_status alone miscounts skips as missing.
  archive_skip_reason TEXT,
  zarr_status TEXT,
  file_size INTEGER,
  license_tier TEXT DEFAULT 'unknown',
  modalities TEXT
);`;

type Row = {
  dataset_id: string;
  owner_user_id?: number;
  is_sandbox?: number;
  status?: string;
  visibility?: string;
  concept_doi?: string | null;
  archive_status?: string | null;
  archive_skip_reason?: string | null;
  zarr_status?: string | null;
};

function db(rows: Row[]): Database {
  const d = new Database(":memory:");
  d.exec(DDL);
  const insert = d.prepare(
    `INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, concept_doi, archive_status, archive_skip_reason, zarr_status)
     VALUES ($id, $owner, $sandbox, $status, $vis, $doi, $arch, $skip, $zarr)`,
  );
  for (const r of rows) {
    insert.run({
      $id: r.dataset_id,
      $owner: r.owner_user_id ?? 1,
      $sandbox: r.is_sandbox ?? 0,
      $status: r.status ?? "active",
      $vis: r.visibility ?? "public",
      $doi: r.concept_doi ?? null,
      $arch: r.archive_status ?? null,
      $skip: r.archive_skip_reason ?? null,
      $zarr: r.zarr_status ?? null,
    });
  }
  return d;
}

function count(d: Database, where: string): number {
  return (d.query(`SELECT COUNT(*) AS n FROM datasets WHERE ${where}`).get() as { n: number }).n;
}

describe("dataset predicates", () => {
  let d: Database;
  beforeEach(() => {
    d = db([
      {
        dataset_id: "nm1",
        visibility: "public",
        concept_doi: "10.x/1",
        archive_status: "ready",
        zarr_status: "ready",
        nemar_sync_status: "synced",
      },
      {
        dataset_id: "nm2",
        visibility: "public",
        concept_doi: "10.x/2",
        archive_status: null,
        zarr_status: "failed",
        nemar_sync_status: "failed",
      },
      {
        dataset_id: "nm3",
        visibility: "public",
        concept_doi: null,
        archive_status: null,
        zarr_status: "pending",
        nemar_sync_status: "pending",
      },
      { dataset_id: "nm4", visibility: "private" },
      { dataset_id: "xx1", visibility: "public", is_sandbox: 1 },
      { dataset_id: "cat1", visibility: "public", owner_user_id: -1 },
      { dataset_id: "nm5", visibility: "public", status: "deleted" },
    ]);
  });

  test("PUBLIC_MANAGED excludes private, sandbox, catalog, and non-active", () => {
    // public+active+managed: nm1, nm2, nm3
    expect(count(d, PUBLIC_MANAGED)).toBe(3);
  });

  test("PRIVATE_MANAGED counts only nm4", () => {
    expect(count(d, PRIVATE_MANAGED)).toBe(1);
  });

  test("MANAGED excludes only the catalog sentinel + sandbox", () => {
    // owner != -1 AND not sandbox: nm1..nm5 + nm4 (private) = 5 (xx1 sandbox, cat1 catalog excluded)
    expect(count(d, MANAGED)).toBe(5);
  });

  test("PUBLISHED = public managed with a concept DOI (nm1, nm2)", () => {
    expect(count(d, PUBLISHED)).toBe(2);
  });
});

describe("status drill-down predicates", () => {
  let d: Database;
  beforeEach(() => {
    d = db([
      { dataset_id: "nm1", concept_doi: "10.x/1", archive_status: "ready" },
      { dataset_id: "nm2", concept_doi: "10.x/2", archive_status: "failed" },
      { dataset_id: "nm3", concept_doi: "10.x/3", archive_status: null },
      { dataset_id: "nm4", concept_doi: null, archive_status: null },
    ]);
  });

  test("archive.missing = published AND not ready (nm2, nm3)", () => {
    const where = `${PUBLISHED} AND (archive_status IS NULL OR archive_status != 'ready')`;
    const ids = (
      d.query(`SELECT dataset_id FROM datasets WHERE ${where} ORDER BY dataset_id`).all() as {
        dataset_id: string;
      }[]
    ).map((r) => r.dataset_id);
    expect(ids).toEqual(["nm2", "nm3"]);
  });

  test("archive.failed (nm2 only)", () => {
    expect(count(d, `${PUBLIC_MANAGED} AND archive_status = 'failed'`)).toBe(1);
  });
});

describe("access top-list public filter (privacy)", () => {
  test("keeps only currently public+managed ids from a candidate list", () => {
    // Mirrors filterPublic() in access.ts: an id that was public when accessed
    // but is now private/sandbox/catalog must be dropped from the public list.
    const d = db([
      { dataset_id: "nm1", visibility: "public" },
      { dataset_id: "nm2", visibility: "private" },
      { dataset_id: "xx1", visibility: "public", is_sandbox: 1 },
      { dataset_id: "cat1", visibility: "public", owner_user_id: -1 },
    ]);
    const ids = ["nm1", "nm2", "xx1", "cat1"];
    const placeholders = ids.map(() => "?").join(",");
    const rows = d
      .query(
        `SELECT dataset_id FROM datasets WHERE dataset_id IN (${placeholders}) AND ${PUBLIC_MANAGED}`,
      )
      .all(...ids) as { dataset_id: string }[];
    expect(rows.map((r) => r.dataset_id)).toEqual(["nm1"]);
  });
});
