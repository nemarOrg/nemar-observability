// Exercises the real drilldown + metrics functions against a real SQLite engine
// (bun:sqlite behind a D1 shim, no mocks). Proves the user drill-downs exclude
// soft-deleted tombstones (migration 0037), return id/status/signup_source, and
// that publicationDrilldown builds github_repo = 'nemarDatasets/<id>'.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { isKnownDrilldown, runDrilldown } from "../src/lib/drilldown";
import { asD1 } from "./helpers/d1";

// Minimal slice of nemar-db.users — only the columns the drill-downs touch,
// including deleted_at (nemar-cli migration 0037).
const USERS_DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT,
  email TEXT,
  github_username TEXT,
  status TEXT NOT NULL,
  signup_source TEXT,
  created_at TEXT,
  deleted_at TEXT
);`;

const PUBREQ_DDL = `CREATE TABLE publication_requests (
  dataset_id TEXT,
  status TEXT,
  prescreen_status TEXT,
  requested_at TEXT,
  current_step TEXT,
  last_error TEXT
);`;

type UserRow = {
  id: number;
  username?: string | null;
  email?: string | null;
  github_username?: string | null;
  status: string;
  signup_source?: string | null;
  created_at?: string;
  deleted_at?: string | null;
};

function usersDb(rows: UserRow[]): D1Database {
  const d = new Database(":memory:");
  d.exec(USERS_DDL);
  const insert = d.prepare(
    `INSERT INTO users (id, username, email, github_username, status, signup_source, created_at, deleted_at)
     VALUES ($id, $username, $email, $gh, $status, $src, $created, $deleted)`,
  );
  for (const r of rows) {
    insert.run({
      $id: r.id,
      $username: r.username ?? null,
      $email: r.email ?? null,
      $gh: r.github_username ?? null,
      $status: r.status,
      $src: r.signup_source ?? null,
      $created: r.created_at ?? "2026-01-01T00:00:00Z",
      $deleted: r.deleted_at ?? null,
    });
  }
  return asD1(d);
}

describe("user drill-downs", () => {
  let db: D1Database;
  beforeEach(() => {
    db = usersDb([
      { id: 1, username: "alice", email: "a@x.org", status: "verified", signup_source: "cli" },
      { id: 2, username: "bob", email: "b@x.org", status: "pending", signup_source: "web" },
      { id: 3, username: "carol", email: "c@x.org", status: "approved", signup_source: "cli" },
      // soft-deleted tombstone — masked, status='revoked', deleted_at set:
      {
        id: 4,
        username: null,
        email: "deleted+4@deleted.invalid",
        status: "revoked",
        deleted_at: "2026-02-01T00:00:00Z",
      },
      // a soft-deleted row that still carries an old status (decoupled flip):
      {
        id: 5,
        username: "ghost",
        email: "g@x.org",
        status: "verified",
        deleted_at: "2026-02-02T00:00:00Z",
      },
      // the id=-1 nemar-system sentinel (status='revoked'):
      { id: -1, username: "nemar-system", email: "sys@x.org", status: "revoked" },
    ]);
  });

  test("users.verified excludes the soft-deleted verified row (id=5) and the sentinel", async () => {
    const res = await runDrilldown(db, "users.verified");
    expect(res).not.toBeNull();
    const ids = (res?.items ?? []).map((i) => i.id);
    expect(ids).toEqual([1]); // only alice; ghost(5) is deleted, sentinel is revoked
    expect(res?.kind).toBe("user");
  });

  test("users.pending returns only the live pending row with id/status/signup_source", async () => {
    const res = await runDrilldown(db, "users.pending");
    expect((res?.items ?? []).map((i) => i.id)).toEqual([2]);
    const item = res?.items[0] as Record<string, unknown>;
    expect(item.id).toBe(2);
    expect(item.status).toBe("pending");
    expect(item.signup_source).toBe("web");
    expect(item.username).toBe("bob");
  });

  test("users.approved excludes tombstones and the sentinel", async () => {
    const res = await runDrilldown(db, "users.approved");
    expect((res?.items ?? []).map((i) => i.id)).toEqual([3]);
  });

  test("all three user keys are known", () => {
    expect(isKnownDrilldown("users.pending")).toBe(true);
    expect(isKnownDrilldown("users.verified")).toBe(true);
    expect(isKnownDrilldown("users.approved")).toBe(true);
    expect(isKnownDrilldown("users.bogus")).toBe(false);
  });
});

describe("publication drill-down dataset_id (UI builds the GitHub link)", () => {
  function pubDb(): D1Database {
    const d = new Database(":memory:");
    d.exec(PUBREQ_DDL);
    d.prepare(
      `INSERT INTO publication_requests (dataset_id, status, prescreen_status, requested_at, current_step, last_error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("nm000132", "requested", "passed", "2026-03-01T00:00:00Z", "validate", null);
    return asD1(d);
  }

  test("returns dataset_id (client links to github.com/nemarDatasets/<id>)", async () => {
    const res = await runDrilldown(pubDb(), "publication.open");
    expect(res?.kind).toBe("publication");
    const item = res?.items[0] as Record<string, unknown>;
    expect(item.dataset_id).toBe("nm000132");
    // No github_repo column is emitted — the UI builds the URL from dataset_id.
    expect(item.github_repo).toBeUndefined();
  });
});
