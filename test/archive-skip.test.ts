// Archive accounting must distinguish "we chose not to build this" from
// "it is missing" (#21).
//
// NEMAR does not archive datasets over 100 GB. nemar-cli #752 records that in
// `archive_skip_reason` and leaves `archive_status` NULL, so a predicate keyed
// on archive_status alone counts every skip as a missing archive. Production
// reported 133 missing when 32 were real -- a permanently-amber tile
// overstating by 4x, which trains people to ignore the colour.
//
// Real SQL against a real SQLite engine via the D1 adapter; no mocks.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { archiveSection } from "../src/lib/metrics";
import { asD1 } from "./helpers/d1";

const NOW = "2026-07-29T14:00:00.000Z";

const DDL = `CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  is_sandbox INTEGER DEFAULT 0,
  status TEXT,
  visibility TEXT,
  concept_doi TEXT,
  archive_status TEXT,
  archive_skip_reason TEXT
);`;

let engine: Database;

/** Insert a published (public + DOI) dataset. */
function published(id: string, archive: string | null, skip: string | null = null): void {
  engine
    .query(
      `INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, concept_doi, archive_status, archive_skip_reason)
       VALUES (?, 1, 0, 'active', 'public', '10.18112/x', ?, ?)`,
    )
    .run(id, archive, skip);
}

const metricsOf = async () => {
  const s = await archiveSection(asD1(engine), NOW);
  return Object.fromEntries(s.metrics.map((m) => [m.key, m]));
};

beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(DDL);
});
afterEach(() => engine.close());

describe("archiveSection", () => {
  // The exact production shape as measured 2026-07-29.
  test("reproduces the production split: 754 published = 621 ready + 101 skipped + 32 missing", async () => {
    for (let i = 0; i < 621; i++) published(`ready${i}`, "ready");
    for (let i = 0; i < 101; i++)
      published(`big${i}`, null, "dataset 500.0 GB exceeds 100.0 GB archive");
    for (let i = 0; i < 32; i++) published(`gap${i}`, null);

    const m = await metricsOf();
    expect(m["archive.ready"].value).toBe(621);
    // The whole point: 32, not 133.
    expect(m["archive.missing"].value).toBe(32);
    expect(m["archive.skipped"].value).toBe(101);

    // Coverage is measured against ELIGIBLE datasets (754 - 101 = 653), so the
    // percentage answers "of those that should have an archive" instead of
    // being permanently capped below 100% by datasets that never can.
    expect(m["archive.ready"].total).toBe(653);
    expect(m["archive.missing"].total).toBe(653);
    // Skipped is a share of everything published, not of the eligible subset.
    expect(m["archive.skipped"].total).toBe(754);
  });

  // A skip has archive_status NULL, which is precisely what the old predicate
  // treated as missing. This is the regression in one dataset.
  test("a skipped dataset counts as skipped, never as missing", async () => {
    published("huge", null, "dataset 8925.2 GB exceeds 100.0 GB archive");
    const m = await metricsOf();
    expect(m["archive.skipped"].value).toBe(1);
    expect(m["archive.missing"].value).toBe(0);
    expect(m["archive.missing"].severity).toBe("ok");
  });

  test("a dataset with neither an archive nor a skip reason is genuinely missing", async () => {
    published("gap", null);
    const m = await metricsOf();
    expect(m["archive.missing"].value).toBe(1);
    expect(m["archive.missing"].severity).toBe("warn");
    expect(m["archive.skipped"].value).toBe(0);
  });

  test("skipped is informational, never a warning", async () => {
    for (let i = 0; i < 50; i++) published(`big${i}`, null, "size policy");
    const m = await metricsOf();
    // 50 datasets that will never have an archive must not colour the dashboard.
    expect(m["archive.skipped"].severity).toBe("info");
  });

  test("pending and failed are still reported independently of the skip split", async () => {
    published("p", "pending");
    published("f", "failed");
    published("s", null, "size policy");
    const m = await metricsOf();
    expect(m["archive.pending"].value).toBe(1);
    expect(m["archive.failed"].value).toBe(1);
    expect(m["archive.failed"].severity).toBe("error");
    // pending/failed have a real archive_status, so they are eligible+missing.
    expect(m["archive.missing"].value).toBe(2);
  });

  // Defends the Math.max(0, ...) guard: a skipped dataset that somehow also has
  // a ready archive must not produce a negative denominator, which the UI would
  // render as a nonsense percentage.
  test("a contradictory row cannot produce a negative denominator", async () => {
    published("weird", "ready", "size policy");
    const m = await metricsOf();
    expect(m["archive.ready"].total).toBeGreaterThanOrEqual(0);
  });

  test("an empty catalog reports zeros, not NaN", async () => {
    const m = await metricsOf();
    expect(m["archive.ready"].value).toBe(0);
    expect(m["archive.missing"].value).toBe(0);
    expect(m["archive.skipped"].value).toBe(0);
    expect(m["archive.ready"].total).toBe(0);
  });
});
