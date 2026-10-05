// The predicate the whole privacy rule for embedded datasets rests on, run as
// real SQL against a real SQLite engine behind the D1 adapter; no mocks.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { publicDatasetIds } from "../src/lib/sql";
import { asD1 } from "./helpers/d1";

let engine: Database;
beforeEach(() => {
  engine = new Database(":memory:");
});
afterEach(() => engine.close());

// The DDL is the part of
// nemar-db's `datasets` table this code reads; rows cover every way a dataset
// is not public.
describe("publicDatasetIds", () => {
  beforeEach(() => {
    engine.run(`CREATE TABLE datasets (
      dataset_id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      is_sandbox INTEGER DEFAULT 0,
      status TEXT,
      visibility TEXT
    )`);
    const add = (id: string, owner: number, sandbox: number | null, status: string, vis: string) =>
      engine
        .query("INSERT INTO datasets VALUES (?, ?, ?, ?, ?)")
        .run(id, owner, sandbox, status, vis);
    add("on-public", 1, 0, "active", "public");
    add("on-public-null-sandbox", 1, null, "active", "public");
    add("nm-private", 1, 0, "active", "private");
    add("nm-draft", 1, 0, "draft", "public");
    add("nm-deleted", 1, 0, "deleted", "public");
    add("xx-sandbox", 1, 1, "active", "public");
    add("ds-folded", -1, 0, "active", "public");
  });

  test("only active, public, managed, non-sandbox datasets are public", async () => {
    const ids = [
      "on-public",
      "on-public-null-sandbox",
      "nm-private",
      "nm-draft",
      "nm-deleted",
      "xx-sandbox",
      "ds-folded",
      "not-in-the-catalog",
    ];
    expect(await publicDatasetIds(asD1(engine), ids)).toEqual(
      new Set(["on-public", "on-public-null-sandbox"]),
    );
  });

  test("an empty list asks nothing and names nothing", async () => {
    expect(await publicDatasetIds(asD1(engine), [])).toEqual(new Set());
  });

  test("a long list is checked in chunks without losing any id", async () => {
    for (let i = 0; i < 250; i++) {
      engine.query("INSERT INTO datasets VALUES (?, 1, 0, 'active', 'public')").run(`on${i}`);
    }
    const ids = Array.from({ length: 250 }, (_, i) => `on${i}`);
    expect((await publicDatasetIds(asD1(engine), ids)).size).toBe(250);
  });

  test("a store that cannot answer throws, never reads as none or all", async () => {
    const empty = new Database(":memory:");
    await expect(publicDatasetIds(asD1(empty), ["on-public"])).rejects.toThrow();
    empty.close();
  });
});
