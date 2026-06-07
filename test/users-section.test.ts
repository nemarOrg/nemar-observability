// Exercises the real usersSection() metric builder against a real SQLite engine
// (bun:sqlite behind a D1 shim, no mocks). Proves tombstones are excluded from
// every count, the "Awaiting approval" (verified) warn tile is present, pending
// is relabeled to info, and users.approved carries a drilldown.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { usersSection } from "../src/lib/metrics";
import type { Metric } from "../src/lib/schema";
import { asD1 } from "./helpers/d1";

function seededDb(): D1Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT, email TEXT, status TEXT NOT NULL, deleted_at TEXT
  );`);
  d.exec("CREATE TABLE tokens (user_id INTEGER, revoked_at TEXT);");
  const u = d.prepare(
    "INSERT INTO users (id, username, email, status, deleted_at) VALUES (?, ?, ?, ?, ?)",
  );
  u.run(1, "alice", "a@x.org", "verified", null);
  u.run(2, "bob", "b@x.org", "pending", null);
  u.run(3, "carol", "c@x.org", "approved", null);
  // tombstones across every status bucket — must be excluded everywhere:
  u.run(4, null, "deleted+4@deleted.invalid", "verified", "2026-02-01T00:00:00Z");
  u.run(5, null, "deleted+5@deleted.invalid", "pending", "2026-02-01T00:00:00Z");
  u.run(6, null, "deleted+6@deleted.invalid", "approved", "2026-02-01T00:00:00Z");
  // id=-1 nemar-system sentinel (status='revoked'):
  u.run(-1, "nemar-system", "sys@x.org", "revoked", null);
  const t = d.prepare("INSERT INTO tokens (user_id, revoked_at) VALUES (?, ?)");
  t.run(1, null);
  t.run(3, null);
  t.run(3, "2026-02-01T00:00:00Z"); // revoked, must not count
  return asD1(d);
}

function byKey(metrics: Metric[], key: string): Metric {
  const m = metrics.find((x) => x.key === key);
  if (!m) throw new Error(`missing metric ${key}`);
  return m;
}

describe("usersSection", () => {
  test("counts exclude tombstones and the sentinel", async () => {
    const s = await usersSection(seededDb(), "2026-06-07T00:00:00Z");
    expect(byKey(s.metrics, "users.verified").value).toBe(1); // alice only
    expect(byKey(s.metrics, "users.pending").value).toBe(1); // bob only
    expect(byKey(s.metrics, "users.approved").value).toBe(1); // carol only
    expect(byKey(s.metrics, "users.active_tokens").value).toBe(2); // two non-revoked
  });

  test("verified tile is the warn-severity Awaiting approval queue", async () => {
    const s = await usersSection(seededDb(), "now");
    const v = byKey(s.metrics, "users.verified");
    expect(v.label).toBe("Awaiting approval");
    expect(v.severity).toBe("warn"); // 1 verified -> warn
    expect(v.drilldown).toBe("users.verified");
  });

  test("pending tile is relabeled to info, with a drilldown", async () => {
    const s = await usersSection(seededDb(), "now");
    const p = byKey(s.metrics, "users.pending");
    expect(p.label).toBe("Pending verification");
    expect(p.severity).toBe("info");
    expect(p.drilldown).toBe("users.pending");
  });

  test("approved tile gains a drilldown", async () => {
    const s = await usersSection(seededDb(), "now");
    expect(byKey(s.metrics, "users.approved").drilldown).toBe("users.approved");
  });

  test("verified tile is ok severity when the queue is empty", async () => {
    const d = new Database(":memory:");
    d.exec(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, status TEXT NOT NULL, deleted_at TEXT);",
    );
    d.exec("CREATE TABLE tokens (user_id INTEGER, revoked_at TEXT);");
    d.prepare("INSERT INTO users (id, username, email, status, deleted_at) VALUES (?,?,?,?,?)").run(
      1,
      "carol",
      "c@x.org",
      "approved",
      null,
    );
    const s = await usersSection(asD1(d), "now");
    expect(byKey(s.metrics, "users.verified").severity).toBe("ok");
  });
});
