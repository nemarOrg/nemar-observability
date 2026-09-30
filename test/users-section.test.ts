// Exercises the real usersSection() metric builder against a real SQLite engine
// (bun:sqlite behind a D1 shim, no mocks). The Users card is one number: users
// who proved an ORCID iD by signing in with ORCID. Proves that a DOI-discovered
// iD does not count, and that tombstones and revoked users are excluded.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { usersSection } from "../src/lib/metrics";
import { asD1 } from "./helpers/d1";

function usersDb(): { d: Database; add: (row: Row) => void } {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, email TEXT, status TEXT NOT NULL,
    orcid TEXT, orcid_verified INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
  );`);
  const insert = d.prepare(
    "INSERT INTO users (id, username, email, status, orcid, orcid_verified, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  return {
    d,
    add: (r) =>
      void insert.run(r.id, r.username ?? null, r.email, r.status, r.orcid, r.verified, r.deleted),
  };
}

interface Row {
  id: number;
  username?: string;
  email: string;
  status: string;
  orcid: string | null;
  verified: 0 | 1;
  deleted: string | null;
}

const TOMBSTONE = "2026-02-01T00:00:00Z";

describe("usersSection", () => {
  test("is a single headline: users with a verified ORCID iD", async () => {
    const { d, add } = usersDb();
    add({
      id: 1,
      username: "alice",
      email: "a@x.org",
      status: "approved",
      orcid: "0000-0001-0000-0001",
      verified: 1,
      deleted: null,
    });
    const s = await usersSection(asD1(d), "2026-09-30T00:00:00Z");
    expect(s.metrics.map((m) => m.key)).toEqual(["users.with_orcid"]);
    expect(s.metrics[0]).toMatchObject({
      label: "Users with ORCID iD",
      value: 1,
      unit: "users",
      severity: "info",
    });
    // Nothing to drill into: approvals and tokens are admin work, in the portal.
    expect(s.metrics[0].drilldown).toBeUndefined();
  });

  test("counts users in every live status who proved their iD", async () => {
    const { d, add } = usersDb();
    add({
      id: 1,
      username: "a",
      email: "a@x.org",
      status: "pending",
      orcid: "0000-0001-0000-0001",
      verified: 1,
      deleted: null,
    });
    add({
      id: 2,
      username: "b",
      email: "b@x.org",
      status: "verified",
      orcid: "0000-0001-0000-0002",
      verified: 1,
      deleted: null,
    });
    add({
      id: 3,
      username: "c",
      email: "c@x.org",
      status: "approved",
      orcid: "0000-0001-0000-0003",
      verified: 1,
      deleted: null,
    });
    const s = await usersSection(asD1(d), "now");
    expect(s.metrics[0].value).toBe(3);
  });

  test("a DOI-discovered iD that nobody proved is not counted", async () => {
    const { d, add } = usersDb();
    add({
      id: 1,
      username: "a",
      email: "a@x.org",
      status: "approved",
      orcid: "0000-0001-0000-0001",
      verified: 0,
      deleted: null,
    });
    add({
      id: 2,
      username: "b",
      email: "b@x.org",
      status: "approved",
      orcid: null,
      verified: 0,
      deleted: null,
    });
    const s = await usersSection(asD1(d), "now");
    expect(s.metrics[0].value).toBe(0);
  });

  test("excludes soft-deleted tombstones, revoked users, and the system sentinel", async () => {
    const { d, add } = usersDb();
    add({
      id: 1,
      username: "alice",
      email: "a@x.org",
      status: "approved",
      orcid: "0000-0001-0000-0001",
      verified: 1,
      deleted: null,
    });
    add({
      id: 2,
      email: "deleted+2@deleted.invalid",
      status: "approved",
      orcid: "0000-0001-0000-0002",
      verified: 1,
      deleted: TOMBSTONE,
    });
    add({
      id: 3,
      username: "banned",
      email: "b@x.org",
      status: "revoked",
      orcid: "0000-0001-0000-0003",
      verified: 1,
      deleted: null,
    });
    add({
      id: -1,
      username: "nemar-system",
      email: "sys@x.org",
      status: "revoked",
      orcid: "0000-0001-0000-0004",
      verified: 1,
      deleted: null,
    });
    const s = await usersSection(asD1(d), "now");
    expect(s.metrics[0].value).toBe(1);
  });

  test("zero is reported as zero, not as missing", async () => {
    const { d } = usersDb();
    const s = await usersSection(asD1(d), "now");
    expect(s.metrics[0].value).toBe(0);
  });
});
