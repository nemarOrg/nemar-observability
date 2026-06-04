// Admin-only drill-downs: given a tile's `drilldown` key, return the list of
// items behind the number (computed on demand from nemar-db so private ids
// never enter the public snapshot). Each key maps to one predicate.

import { PUBLIC_MANAGED, PUBLISHED } from "./sql";

export interface DrilldownResult {
  key: string;
  label: string;
  kind: "dataset" | "publication" | "user";
  count: number;
  items: Record<string, unknown>[];
}

const LIMIT = 500;

/** Dataset-shaped drill-downs: a WHERE predicate over `datasets`. */
const DATASET_DRILLDOWNS: Record<string, { label: string; where: string }> = {
  "archive.missing": {
    label: "Published datasets missing an archive",
    where: `${PUBLISHED} AND (archive_status IS NULL OR archive_status != 'ready')`,
  },
  "archive.pending": {
    label: "Datasets with a pending archive",
    where: `${PUBLIC_MANAGED} AND archive_status = 'pending'`,
  },
  "archive.failed": {
    label: "Datasets with a failed archive",
    where: `${PUBLIC_MANAGED} AND archive_status = 'failed'`,
  },
  "zarr.pending": {
    label: "Datasets being converted to Zarr",
    where: `${PUBLIC_MANAGED} AND zarr_status = 'pending'`,
  },
  "zarr.failed": {
    label: "Datasets with a failed Zarr conversion",
    where: `${PUBLIC_MANAGED} AND zarr_status = 'failed'`,
  },
  "sync.pending": {
    label: "Datasets pending nemar.org sync",
    where: `${PUBLIC_MANAGED} AND nemar_sync_status = 'pending'`,
  },
  "sync.failed": {
    label: "Datasets with a failed nemar.org sync",
    where: `${PUBLIC_MANAGED} AND nemar_sync_status = 'failed'`,
  },
};

/** publication_requests-shaped drill-downs. */
const PUBLICATION_DRILLDOWNS: Record<string, { label: string; where: string }> = {
  "publication.open": {
    label: "Open publication requests",
    where: "status IN ('requested', 'approving')",
  },
  "publication.prescreen_failed": {
    label: "Requests that failed pre-screen",
    where: "prescreen_status = 'failed'",
  },
  "publication.blocked": { label: "Blocked publication requests", where: "status = 'blocked'" },
};

async function datasetDrilldown(
  db: D1Database,
  key: string,
  label: string,
  where: string,
): Promise<DrilldownResult> {
  const rows = await db
    .prepare(
      `SELECT dataset_id, name, github_repo, visibility, archive_status, zarr_status, nemar_sync_status, last_activity_at
       FROM datasets WHERE ${where} ORDER BY dataset_id LIMIT ${LIMIT}`,
    )
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return { key, label, kind: "dataset", count: items.length, items };
}

async function publicationDrilldown(
  db: D1Database,
  key: string,
  label: string,
  where: string,
): Promise<DrilldownResult> {
  const rows = await db
    .prepare(
      `SELECT dataset_id, status, prescreen_status, requested_at, current_step, last_error
       FROM publication_requests WHERE ${where} ORDER BY requested_at DESC LIMIT ${LIMIT}`,
    )
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return { key, label, kind: "publication", count: items.length, items };
}

async function usersPendingDrilldown(db: D1Database): Promise<DrilldownResult> {
  const rows = await db
    .prepare(
      `SELECT username, email, github_username, created_at FROM users WHERE status = 'pending' ORDER BY created_at DESC LIMIT ${LIMIT}`,
    )
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return {
    key: "users.pending",
    label: "Users awaiting approval",
    kind: "user",
    count: items.length,
    items,
  };
}

/** Resolve a drill-down key to its list, or null if the key is unknown. */
export async function runDrilldown(db: D1Database, key: string): Promise<DrilldownResult | null> {
  const ds = DATASET_DRILLDOWNS[key];
  if (ds) return datasetDrilldown(db, key, ds.label, ds.where);
  const pub = PUBLICATION_DRILLDOWNS[key];
  if (pub) return publicationDrilldown(db, key, pub.label, pub.where);
  if (key === "users.pending") return usersPendingDrilldown(db);
  return null;
}

/** Whether a drill-down key is known (used to 404 cleanly). */
export function isKnownDrilldown(key: string): boolean {
  return key in DATASET_DRILLDOWNS || key in PUBLICATION_DRILLDOWNS || key === "users.pending";
}
