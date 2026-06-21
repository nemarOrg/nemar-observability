// Exercises the OpenNeuro auto-import section + drill-downs (epic #775 Phase 3)
// against a real SQLite engine (bun:sqlite behind the D1 shim, no mocks). Seeds
// a faithful slice of nemar-db's `import_jobs` (migration 0044 + auto_attempts
// 0047) and `audit_log` (0001), then asserts the tile values/severities and the
// drill-down rows the dashboard renders.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { isKnownDrilldown, runDrilldown } from "../src/lib/drilldown";
import { autoImportSection } from "../src/lib/metrics";
import type { Metric } from "../src/lib/schema";
import { asD1 } from "./helpers/d1";

const IMPORT_JOBS_DDL = `CREATE TABLE import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'prepare',
  status TEXT NOT NULL DEFAULT 'preparing',
  last_error TEXT,
  auto_attempts INTEGER NOT NULL DEFAULT 0,
  workflow_run_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dataset_id)
);`;

const AUDIT_LOG_DDL = `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT
);`;

// Minimal slice of nemar-db.datasets that the `imported` count touches. The true
// "imported from OpenNeuro" total comes from here (source='openneuro'), not import_jobs.
const DATASETS_DDL = `CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY,
  source TEXT,
  source_id TEXT
);`;

type Job = {
  dataset_id: string;
  source?: string;
  source_id?: string;
  status: string;
  last_error?: string | null;
  auto_attempts?: number;
  updated_at?: string; // SQL expression evaluated at insert (e.g. datetime('now'))
};

/** Rows for the `datasets` table (the imported-from-OpenNeuro source of truth). */
type ImportedRow = { dataset_id?: string; source?: string; source_id?: string | null };

function seedDb(
  jobs: Job[],
  dispatchAges: string[] = [],
  imported: ImportedRow[] = [],
): D1Database {
  const d = new Database(":memory:");
  d.exec(IMPORT_JOBS_DDL);
  d.exec(AUDIT_LOG_DDL);
  d.exec(DATASETS_DDL);

  const insDataset = d.prepare(
    "INSERT INTO datasets (dataset_id, source, source_id) VALUES ($id, $source, $sid)",
  );
  imported.forEach((r, i) => {
    insDataset.run({
      $id: r.dataset_id ?? `nm${String(i).padStart(6, "0")}`,
      $source: r.source ?? "openneuro",
      $sid: r.source_id === undefined ? `ds${String(i).padStart(6, "0")}` : r.source_id,
    });
  });

  const insert = d.prepare(
    `INSERT INTO import_jobs (dataset_id, source, source_id, status, last_error, auto_attempts, updated_at)
     VALUES ($id, $source, $sid, $status, $err, $attempts, ${"datetime('now')"})`,
  );
  for (const j of jobs) {
    insert.run({
      $id: j.dataset_id,
      $source: j.source ?? "openneuro",
      $sid: j.source_id ?? j.dataset_id.replace(/^on/, "ds"),
      $status: j.status,
      $err: j.last_error ?? null,
      $attempts: j.auto_attempts ?? 0,
    });
  }

  // audit_log dispatch heartbeat rows; `age` is a SQLite modifier so the row's
  // timestamp is relative to now (e.g. '-2 day' is outside the 24h window).
  for (const age of dispatchAges) {
    d.query(
      `INSERT INTO audit_log (timestamp, action, resource_type, resource_id)
       VALUES (datetime('now', ?), 'auto_import_dispatch', 'dataset', 'ds000001')`,
    ).run(age);
  }
  // An unrelated recent action must NOT count toward auto_24h.
  d.query(
    `INSERT INTO audit_log (timestamp, action, resource_type, resource_id)
     VALUES (datetime('now'), 'user_login', 'user', '7')`,
  ).run();

  return asD1(d);
}

function byKey(metrics: Metric[], key: string): Metric {
  const m = metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} not found`);
  return m;
}

describe("autoImportSection", () => {
  test("counts each import status and the 24h dispatch heartbeat", async () => {
    const db = seedDb(
      [
        { dataset_id: "on000001", status: "preparing" },
        { dataset_id: "on000002", status: "copying" },
        { dataset_id: "on000003", status: "finalizing" },
        { dataset_id: "on000004", status: "failed", last_error: "boom" },
        { dataset_id: "on000005", status: "quarantined", last_error: "ambiguous orphan" },
        { dataset_id: "on000006", status: "complete" },
        { dataset_id: "on000007", status: "rolled_back" }, // counts in none
        // Different source: must be excluded by the source='openneuro' filter.
        { dataset_id: "on000008", source: "manual", status: "complete" },
      ],
      ["-1 hour", "-3 hour", "-2 day"], // two within 24h, one outside
      [
        // The TRUE imported count: only NEMAR-native on-numbered openneuro rows (3).
        { dataset_id: "on000132", source: "openneuro", source_id: "ds000132" },
        { dataset_id: "on000133", source: "openneuro", source_id: "ds000133" },
        { dataset_id: "on000134", source: "openneuro", source_id: "ds000134" },
        // Legacy ds-numbered openneuro rows -- excluded (retiring, nemar-cli#793).
        { dataset_id: "ds000200", source: "openneuro", source_id: "ds000200" },
        { dataset_id: "ds000201", source: "openneuro", source_id: "ds000201" },
        // Non-openneuro -- excluded by the source filter.
        { dataset_id: "on999999", source: "datalad", source_id: "x" },
      ],
    );

    const section = await autoImportSection(db, "2026-06-17T00:00:00.000Z");
    expect(section.key).toBe("imports");
    expect(section.source).toBe("nemar-cli");

    const active = byKey(section.metrics, "imports.active");
    expect(active.value).toBe(3);
    expect(active.severity).toBe("warn");
    expect(active.drilldown).toBe("imports.active");

    const failed = byKey(section.metrics, "imports.failed");
    expect(failed.value).toBe(1);
    expect(failed.severity).toBe("error");
    expect(failed.drilldown).toBe("imports.failed");

    const quarantined = byKey(section.metrics, "imports.quarantined");
    expect(quarantined.value).toBe(1);
    expect(quarantined.severity).toBe("error");

    // 'imported' = on-numbered openneuro rows only (3): NOT the import_jobs
    // 'complete' count, NOT the legacy ds-numbered rows, NOT the datalad row.
    expect(byKey(section.metrics, "imports.imported").value).toBe(3);

    const auto24h = byKey(section.metrics, "imports.auto_24h");
    expect(auto24h.value).toBe(2);
    expect(auto24h.severity).toBe("info");
  });

  test("upstream_inaccessible is a distinct subset of quarantined (#827)", async () => {
    const section = await autoImportSection(
      seedDb([
        {
          dataset_id: "on000005",
          status: "quarantined",
          last_error: "quarantined: not_found_dataset",
        },
        {
          dataset_id: "on007541",
          status: "quarantined",
          last_error: "quarantined: upstream_inaccessible",
        },
        {
          dataset_id: "on007720",
          status: "quarantined",
          last_error: "quarantined: upstream_inaccessible (published empty pre-fix)",
        },
      ]),
      "2026-06-21T00:00:00.000Z",
    );
    // quarantined counts ALL three; upstream is the 2-row OpenNeuro-side subset.
    expect(byKey(section.metrics, "imports.quarantined").value).toBe(3);
    const up = byKey(section.metrics, "imports.upstream_inaccessible");
    expect(up.value).toBe(2);
    expect(up.drilldown).toBe("imports.upstream_inaccessible");
  });

  test("all-zero when there is nothing to import", async () => {
    const section = await autoImportSection(seedDb([]), "2026-06-17T00:00:00.000Z");
    expect(byKey(section.metrics, "imports.active").value).toBe(0);
    expect(byKey(section.metrics, "imports.active").severity).toBe("ok");
    expect(byKey(section.metrics, "imports.failed").severity).toBe("ok");
    expect(byKey(section.metrics, "imports.auto_24h").value).toBe(0);
  });

  test("rolled_back status falls into no bucket", async () => {
    const section = await autoImportSection(
      seedDb([{ dataset_id: "on000010", status: "rolled_back" }]),
      "2026-06-17T00:00:00.000Z",
    );
    expect(byKey(section.metrics, "imports.active").value).toBe(0);
    expect(byKey(section.metrics, "imports.failed").value).toBe(0);
    expect(byKey(section.metrics, "imports.quarantined").value).toBe(0);
    expect(byKey(section.metrics, "imports.imported").value).toBe(0); // no datasets seeded
  });

  test("auto_24h window: a dispatch inside 24h counts, one outside does not", async () => {
    // 23h is inside the `>= datetime('now','-1 day')` window, 25h is outside.
    // (An exact-second boundary row is not deterministic here: the row's
    // datetime('now') and the query's datetime('now') are evaluated separately.)
    const section = await autoImportSection(
      seedDb([], ["-23 hours", "-25 hours"]),
      "2026-06-17T00:00:00.000Z",
    );
    expect(byKey(section.metrics, "imports.auto_24h").value).toBe(1);
  });
});

describe("importJobDrilldown", () => {
  const db = () =>
    seedDb([
      { dataset_id: "on000001", status: "preparing", auto_attempts: 0 },
      { dataset_id: "on000002", status: "copying", auto_attempts: 1 },
      { dataset_id: "on000004", status: "failed", last_error: "boom", auto_attempts: 3 },
      { dataset_id: "on000005", status: "quarantined", last_error: "ambiguous orphan" },
      { dataset_id: "on000006", status: "complete" },
      { dataset_id: "on000008", source: "manual", status: "failed", last_error: "other" },
    ]);

  test("imports.active lists in-flight jobs with their stage", async () => {
    const r = await runDrilldown(db(), "imports.active");
    expect(r?.kind).toBe("dataset");
    expect(r?.count).toBe(2);
    const ids = (r?.items ?? []).map((i) => i.dataset_id).sort();
    expect(ids).toEqual(["on000001", "on000002"]);
    // Stage rows carry `status` so the detail cell shows the stage.
    const one = (r?.items ?? []).find((i) => i.dataset_id === "on000001");
    expect(one?.status).toBe("preparing");
    expect(one).not.toHaveProperty("last_error");
  });

  test("imports.failed shows the failure reason, excludes non-openneuro", async () => {
    const r = await runDrilldown(db(), "imports.failed");
    expect(r?.count).toBe(1);
    const item = r?.items?.[0];
    expect(item?.dataset_id).toBe("on000004");
    // Failure rows drop `status` so the detail cell falls through to last_error.
    expect(item?.last_error).toBe("boom");
    expect(item).not.toHaveProperty("status");
  });

  test("imports.quarantined lists parked jobs and surfaces last_error", async () => {
    const r = await runDrilldown(db(), "imports.quarantined");
    expect(r?.count).toBe(1);
    expect(r?.items?.[0]?.dataset_id).toBe("on000005");
    expect(r?.items?.[0]?.last_error).toBe("ambiguous orphan");
    // Same detail:"error" path as failed -- status must be dropped so the
    // detail cell falls through to last_error.
    expect(r?.items?.[0]).not.toHaveProperty("status");
  });

  test("imports.failed with a null last_error still lists the job", async () => {
    const db2 = seedDb([{ dataset_id: "on000099", status: "failed", last_error: null }]);
    const r = await runDrilldown(db2, "imports.failed");
    expect(r?.count).toBe(1);
    expect(r?.items?.[0]?.dataset_id).toBe("on000099");
    expect(r?.items?.[0]?.last_error).toBeNull();
  });

  test("imports.upstream_inaccessible lists only the OpenNeuro-inaccessible subset", async () => {
    const db2 = seedDb([
      {
        dataset_id: "on000005",
        status: "quarantined",
        last_error: "quarantined: not_found_dataset",
      },
      {
        dataset_id: "on007541",
        status: "quarantined",
        last_error: "quarantined: upstream_inaccessible",
      },
      {
        dataset_id: "on007720",
        status: "quarantined",
        last_error: "quarantined: upstream_inaccessible (x)",
      },
      { dataset_id: "on000004", status: "failed", last_error: "upstream_inaccessible" }, // not quarantined -> excluded
    ]);
    const r = await runDrilldown(db2, "imports.upstream_inaccessible");
    expect(r?.count).toBe(2);
    const ids = (r?.items ?? []).map((i) => i.dataset_id).sort();
    expect(ids).toEqual(["on007541", "on007720"]);
    expect(r?.items?.[0]).not.toHaveProperty("status"); // detail:error path
  });

  test("import drill-down keys are known; an unknown key is not", () => {
    expect(isKnownDrilldown("imports.active")).toBe(true);
    expect(isKnownDrilldown("imports.failed")).toBe(true);
    expect(isKnownDrilldown("imports.quarantined")).toBe(true);
    expect(isKnownDrilldown("imports.upstream_inaccessible")).toBe(true);
    expect(isKnownDrilldown("imports.nope")).toBe(false);
  });
});
