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
    where: `${PUBLISHED} AND archive_status = 'pending'`,
  },
  "archive.failed": {
    label: "Datasets with a failed archive",
    where: `${PUBLISHED} AND archive_status = 'failed'`,
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
  // github_repo is built in SQL as `nemarDatasets/<dataset_id>`: dataset repos
  // live under the nemarDatasets org and the repo name equals the dataset_id
  // (nemar-cli github.ts ORG_NAME). The UI's githubDatasetLink() consumes it.
  const rows = await db
    .prepare(
      `SELECT dataset_id, 'nemarDatasets/' || dataset_id AS github_repo,
              status, prescreen_status, requested_at, current_step, last_error
       FROM publication_requests WHERE ${where} ORDER BY requested_at DESC LIMIT ${LIMIT}`,
    )
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return { key, label, kind: "publication", count: items.length, items };
}

/**
 * users-shaped drill-downs. Each key pins an exact status AND excludes
 * soft-deleted rows via `deleted_at IS NULL` (nemar-cli migration 0037 adds the
 * users.deleted_at tombstone column). The status pin also drops the id=-1
 * 'nemar-system' sentinel (it is status='revoked'). The SELECT includes `id`
 * (the owner-only Delete button keys on it) and `status`/`signup_source` (the
 * Approve gate + identity display).
 */
const USER_DRILLDOWNS: Record<string, { label: string; where: string }> = {
  "users.pending": {
    label: "Users pending email verification",
    where: "status = 'pending' AND deleted_at IS NULL",
  },
  "users.verified": {
    label: "Users awaiting admin approval",
    where: "status = 'verified' AND deleted_at IS NULL",
  },
  "users.approved": {
    label: "Approved users",
    where: "status = 'approved' AND deleted_at IS NULL",
  },
};

async function userDrilldown(
  db: D1Database,
  key: string,
  label: string,
  where: string,
): Promise<DrilldownResult> {
  const rows = await db
    .prepare(
      `SELECT id, username, email, github_username, status, signup_source, created_at
       FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ${LIMIT}`,
    )
    .all<Record<string, unknown>>();
  const items = rows.results ?? [];
  return { key, label, kind: "user", count: items.length, items };
}

/** Resolve a drill-down key to its list, or null if the key is unknown. */
export async function runDrilldown(db: D1Database, key: string): Promise<DrilldownResult | null> {
  const ds = DATASET_DRILLDOWNS[key];
  if (ds) return datasetDrilldown(db, key, ds.label, ds.where);
  const pub = PUBLICATION_DRILLDOWNS[key];
  if (pub) return publicationDrilldown(db, key, pub.label, pub.where);
  const usr = USER_DRILLDOWNS[key];
  if (usr) return userDrilldown(db, key, usr.label, usr.where);
  return null;
}

/** Whether a drill-down key is known (used to 404 cleanly). */
export function isKnownDrilldown(key: string): boolean {
  return key in DATASET_DRILLDOWNS || key in PUBLICATION_DRILLDOWNS || key in USER_DRILLDOWNS;
}
