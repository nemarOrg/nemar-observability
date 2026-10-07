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
import { buildSnapshot, partialHint, pendingHint, zarrSection } from "../src/lib/metrics";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";
import { JARGON } from "./helpers/public-copy";

const NOW = "2026-10-07T04:00:00.000Z";
// Seven days before NOW, in the `datetime('now')` text form nemar-cli writes.
const CUTOFF = "2026-09-30 04:00:00";

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
  zarr_data_failures TEXT,
  recording_count INTEGER
);`;

type Row = {
  id: string;
  zarr: string | null;
  stores?: number | null;
  errors?: number | null;
  converted?: string | null;
  recordings?: number | null;
  summary?: string | null;
  owner?: number;
  sandbox?: number;
  status?: string;
  visibility?: string;
};

let engine: Database;

function insert(r: Row): void {
  engine
    .query(
      `INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, zarr_status, zarr_store_count, zarr_errors, zarr_converted_at, zarr_data_failures, recording_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      r.summary ?? null,
      r.recordings ?? null,
    );
}

const summary = (pending: number, discovered: number) =>
  JSON.stringify({ count: 0, detail_ref: "zarr/index.json", pending, discovered });

const metricsOf = async (now = NOW) => {
  const s = await zarrSection(asD1(engine), now);
  return Object.fromEntries(s.metrics.map((m) => [m.key, m]));
};

/** Every figure the section reports, for comparing two states of the table. */
const figures = async () => {
  const m = await metricsOf();
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { value: v.value, total: v.total, hint: v.hint }]),
  );
};

beforeEach(() => {
  engine = new Database(":memory:");
  engine.run(DDL);
});
afterEach(() => engine.close());

/** One of every status shape the section distinguishes; ids are prefixed per use. */
function everyShape(prefix: string, over: Partial<Row> = {}): void {
  insert({ id: `${prefix}-ready`, zarr: "ready", stores: 40, errors: 0, recordings: 40, ...over });
  insert({ id: `${prefix}-errs`, zarr: "ready", stores: 30, errors: 7, recordings: 37, ...over });
  insert({
    id: `${prefix}-wait`,
    zarr: "ready",
    stores: 20,
    errors: 0,
    recordings: 20,
    summary: summary(6, 26),
    ...over,
  });
  insert({
    id: `${prefix}-stale`,
    zarr: "pending",
    stores: 50,
    recordings: 60,
    converted: "2026-08-01 00:00:00",
    ...over,
  });
  insert({ id: `${prefix}-never`, zarr: "pending", ...over });
  insert({ id: `${prefix}-failed`, zarr: "failed", stores: 9, errors: 11, ...over });
}

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
    // Ready with no failures but 4 recordings still waiting (a pending-only summary).
    insert({
      id: "nm5",
      zarr: "ready",
      stores: 20,
      errors: 0,
      recordings: 20,
      summary: summary(4, 24),
    });
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
    // Failed after an earlier success: keeps its last good stores, and this run's
    // 5 failures overlap them rather than adding to them.
    insert({ id: "f2", zarr: "failed", stores: 30, errors: 5 });
  });

  test("keeps the dataset-level counts", async () => {
    const m = await metricsOf();
    expect(m["zarr.ready"].value).toBe(5);
    expect(m["zarr.ready"].total).toBe(10);
    expect(m["zarr.pending"].value).toBe(3);
    expect(m["zarr.failed"].value).toBe(2);
    // Ready datasets only: a dataset mid-rebuild is left out until it finishes.
    expect(m["zarr.stores"].value).toBe(187);
  });

  test("fully converted excludes ready datasets with failed or waiting recordings", async () => {
    const m = await metricsOf();
    // nm1, nm3 (no error recorded) and nm4; nm2 has 10 failures, nm5 has 4 waiting.
    expect(m["zarr.complete"].value).toBe(3);
    expect(m["zarr.complete"].total).toBe(10);
    expect(m["zarr.partial"].value).toBe(2);
    expect(m["zarr.partial"].severity).toBe("warn");
    // 10 failed in nm2 plus 4 waiting in nm5.
    expect(m["zarr.partial"].hint).toBe(
      "Ready, but 14 recordings across these datasets did not convert yet",
    );
  });

  test("recordings converted counts stores of every dataset against all recordings found", async () => {
    const m = await metricsOf();
    // Converted: 100 + 50 + 5 + 12 + 20 + 240 + 12 + 0 + 30 = 469 (pending datasets
    // keep their last confirmed stores; a failed one keeps its last good stores).
    expect(m["zarr.recordings"].value).toBe(469);
    // Found: 100 + 60 + 5 + max(10, 12) + max(20, 20+0+4, 24) + 240 + 40 + 0
    // + max(90) + max(30, 5) = 601. A failed dataset's stores and errors overlap,
    // so they are not added.
    expect(m["zarr.recordings"].total).toBe(601);
    expect(m["zarr.recordings"].unit).toBe("count");
  });

  test("the headline tile comes first so the card's ring shows recording coverage", async () => {
    const s = await zarrSection(asD1(engine), NOW);
    expect(s.metrics[0].key).toBe("zarr.recordings");
    expect(s.metrics.map((m) => m.key).sort()).toEqual(
      [
        "zarr.complete",
        "zarr.failed",
        "zarr.partial",
        "zarr.pending",
        "zarr.ready",
        "zarr.recordings",
        "zarr.stores",
      ].sort(),
    );
  });

  test("the figures stay consistent with one another", async () => {
    const m = await metricsOf();
    expect(m["zarr.recordings"].value).toBeLessThanOrEqual(m["zarr.recordings"].total ?? 0);
    expect(m["zarr.complete"].value + m["zarr.partial"].value).toBe(m["zarr.ready"].value);
    expect(m["zarr.ready"].value).toBeLessThanOrEqual(m["zarr.ready"].total ?? 0);
    expect(
      m["zarr.ready"].value + m["zarr.pending"].value + m["zarr.failed"].value,
    ).toBeLessThanOrEqual(m["zarr.ready"].total ?? 0);
  });

  test("severities follow the counts", async () => {
    const m = await metricsOf();
    expect(m["zarr.pending"].severity).toBe("warn");
    expect(m["zarr.failed"].severity).toBe("error");
    engine.run("DELETE FROM datasets WHERE zarr_status IN ('pending', 'failed')");
    const clean = await metricsOf();
    expect(clean["zarr.pending"].severity).toBe("ok");
    expect(clean["zarr.failed"].severity).toBe("ok");
  });

  test("flags pending datasets last converted over a week ago, or never", async () => {
    const m = await metricsOf();
    // p1 (40 days) and p3 (never); p2 was confirmed yesterday.
    expect(m["zarr.pending"].hint).toBe(
      "Dispatched, conversion not yet confirmed. 2 of these were last converted more than 7 days ago, or never",
    );
  });

  test("a pending dataset that is all recent has the plain hint", async () => {
    engine.run("DELETE FROM datasets WHERE dataset_id IN ('p1', 'p3')");
    expect((await metricsOf())["zarr.pending"].hint).toBe(
      "Dispatched, conversion not yet confirmed",
    );
  });

  test("an empty catalog reports zeros, not an error", async () => {
    engine.run("DELETE FROM datasets");
    const m = await metricsOf();
    expect(m["zarr.recordings"].value).toBe(0);
    expect(m["zarr.recordings"].total).toBe(0);
    expect(m["zarr.complete"].value).toBe(0);
    expect(m["zarr.partial"].hint).toBe("Datasets that are ready but missing some recordings");
    expect(m["zarr.pending"].hint).toBe("Dispatched, conversion not yet confirmed");
  });

  test("private, sandbox, folded-catalog and deleted datasets change no figure", async () => {
    const before = await figures();
    everyShape("priv", { visibility: "private" });
    everyShape("sbx", { sandbox: 1 });
    everyShape("cat", { owner: -1 });
    everyShape("gone", { status: "deleted" });
    expect(await figures()).toEqual(before);
    // The same shapes DO count when public, so the comparison above is not vacuous.
    everyShape("pub");
    expect(await figures()).not.toEqual(before);
  });
});

describe("recordings found and converted: the awkward shapes", () => {
  test("a dataset swept but never converted adds to found, not to converted", async () => {
    insert({ id: "swept", zarr: "pending", recordings: 30 });
    const m = await metricsOf();
    expect(m["zarr.recordings"].value).toBe(0);
    expect(m["zarr.recordings"].total).toBe(30);
  });

  test("a dataset never queued still counts toward found when it was swept", async () => {
    insert({ id: "unqueued", zarr: null, recordings: 30 });
    const m = await metricsOf();
    expect(m["zarr.recordings"].total).toBe(30);
    expect(m["zarr.recordings"].value).toBe(0);
    // It is public, so it is in the dataset denominator too.
    expect(m["zarr.ready"].total).toBe(1);
  });

  test("a failed dataset keeps its last good stores and does not double count its errors", async () => {
    insert({ id: "failed", zarr: "failed", stores: 30, errors: 5 });
    const m = await metricsOf();
    expect(m["zarr.recordings"].value).toBe(30);
    expect(m["zarr.recordings"].total).toBe(30);
    expect(m["zarr.failed"].value).toBe(1);
    expect(m["zarr.stores"].value).toBe(0);
  });

  test("the converter's discovered count raises found when it exceeds everything else", async () => {
    insert({
      id: "d",
      zarr: "ready",
      stores: 10,
      errors: 0,
      recordings: 10,
      summary: summary(0, 14),
    });
    expect((await metricsOf())["zarr.recordings"].total).toBe(14);
  });

  test("an old-format failure list or a malformed summary is ignored, not an error", async () => {
    insert({ id: "old", zarr: "ready", stores: 5, errors: 0, summary: '[{"path":"a"}]' });
    insert({ id: "junk", zarr: "ready", stores: 5, errors: 0, summary: "not json" });
    insert({
      id: "text",
      zarr: "ready",
      stores: 5,
      errors: 0,
      summary: '{"pending":"many","discovered":"lots"}',
    });
    const m = await metricsOf();
    expect(m["zarr.complete"].value).toBe(3);
    expect(m["zarr.recordings"].total).toBe(15);
  });
});

describe("the stale-pending window", () => {
  const stale = async (converted: string, now = NOW) => {
    engine.run("DELETE FROM datasets");
    insert({ id: "p", zarr: "pending", converted });
    const hint = (await metricsOf(now))["zarr.pending"].hint;
    return hint?.includes("last converted more than 7 days ago") === true;
  };

  test("exactly seven days ago is not stale, one second earlier is", async () => {
    expect(await stale(CUTOFF)).toBe(false);
    expect(await stale("2026-09-30 04:00:01")).toBe(false);
    expect(await stale("2026-09-30 03:59:59")).toBe(true);
  });

  test("an ISO timestamp is compared as the instant it names", async () => {
    expect(await stale("2026-09-30T04:00:01Z")).toBe(false);
    expect(await stale("2026-09-30T03:59:59Z")).toBe(true);
    // Same calendar day as the cutoff: a plain string compare would call both stale.
    expect(await stale("2026-09-30T23:00:00.000Z")).toBe(false);
  });

  test("the window is seven days, measured from now", async () => {
    // Three days ago is inside a seven-day window; thirty days ago is outside it.
    expect(await stale("2026-10-04 04:00:00")).toBe(false);
    expect(await stale("2026-09-07 04:00:00")).toBe(true);
    // Moving now forward a day moves the cutoff with it.
    expect(await stale("2026-09-30 04:00:01", "2026-10-08T04:00:00.000Z")).toBe(true);
  });
});

describe("hint copy", () => {
  test("counts agree in number and use plain words", () => {
    expect(partialHint(1, 1)).toBe(
      "Ready, but 1 recording across these datasets did not convert yet",
    );
    expect(partialHint(3, 1234)).toBe(
      "Ready, but 1,234 recordings across these datasets did not convert yet",
    );
    expect(pendingHint(1)).toBe(
      "Dispatched, conversion not yet confirmed. 1 of these was last converted more than 7 days ago, or never",
    );
    expect(pendingHint(1200)).toContain("1,200 of these were");
  });

  test("no branch of any hint uses jargon", () => {
    const hints = [
      partialHint(0, 0),
      partialHint(1, 1),
      partialHint(5, 2000),
      pendingHint(0),
      pendingHint(1),
      pendingHint(9),
    ];
    for (const hint of hints) expect(hint).not.toMatch(JARGON);
  });
});

describe("the section inside a snapshot", () => {
  // The datasets table as it stood before the columns this section reads existed.
  const OLD_DDL = `CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER, is_sandbox INTEGER, status TEXT,
    visibility TEXT, concept_doi TEXT, zarr_status TEXT, archive_status TEXT,
    archive_skip_reason TEXT, license_tier TEXT, modalities TEXT, file_size INTEGER,
    last_activity_at TEXT
  );`;

  const keys = (snap: Awaited<ReturnType<typeof buildSnapshot>>) => snap.sections.map((s) => s.key);

  function envFor(nemar: Database): Bindings {
    const obs = new Database(":memory:");
    for (const sql of MIGRATIONS) obs.run(sql);
    return { OBS_DB: asD1(obs), NEMAR_DB: asD1(nemar) } as unknown as Bindings;
  }

  test("a database missing the new columns fails only the zarr section", async () => {
    const old = new Database(":memory:");
    old.run(OLD_DDL);
    old.run(
      "INSERT INTO datasets (dataset_id, owner_user_id, is_sandbox, status, visibility, zarr_status) VALUES ('nm1', 1, 0, 'active', 'public', 'ready')",
    );
    const snap = await buildSnapshot(envFor(old));
    const failed = snap.section_errors?.find((e) => e.key === "zarr");
    expect(failed?.error).toContain("no such column");
    expect(keys(snap)).not.toContain("zarr");
    expect(keys(snap)).toContain("datasets");
    old.close();
  });

  test("a current database builds the zarr section with no error", async () => {
    insert({ id: "nm1", zarr: "ready", stores: 3, errors: 0, recordings: 3 });
    const snap = await buildSnapshot(envFor(engine));
    expect(snap.section_errors?.find((e) => e.key === "zarr")).toBeUndefined();
    const zarr = snap.sections.find((s) => s.key === "zarr");
    expect(zarr?.metrics[0]).toMatchObject({ key: "zarr.recordings", value: 3, total: 3 });
  });
});
