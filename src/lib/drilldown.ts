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

/**
 * import_jobs-shaped drill-downs (OpenNeuro auto-import, epic #775). A status
 * filter over `import_jobs` (source='openneuro'). `detail` picks what the shared
 * dataset row renderer shows in its muted cell: the lifecycle status
 * (preparing/copying/finalizing) for in-flight jobs, or the failure reason
 * (last_error) for failed/quarantined ones. `count` is items.length post-LIMIT,
 * consistent with the other drill-downs; at the auto-import cadence (one every
 * ~90 min) the LIMIT is never reached, so it matches the section tile.
 */
const IMPORT_DRILLDOWNS: Record<
  string,
  { label: string; statuses: string[]; detail: "status" | "error"; errorLike?: string }
> = {
  "imports.active": {
    label: "OpenNeuro imports in flight",
    statuses: ["preparing", "copying", "finalizing"],
    detail: "status",
  },
  "imports.failed": {
    label: "Failed OpenNeuro imports",
    statuses: ["failed"],
    detail: "error",
  },
  "imports.quarantined": {
    label: "Quarantined OpenNeuro imports",
    statuses: ["quarantined"],
    detail: "error",
  },
  // OpenNeuro-side problem, not a NEMAR bug (#808): objects aren't anonymously
  // readable and NEMAR has no signed OpenNeuro login, so the data can't be
  // mirrored. A subset of quarantined, surfaced distinctly so it's a listable
  // "report to OpenNeuro support" set (nemar-cli#827).
  "imports.upstream_inaccessible": {
    label: "OpenNeuro-inaccessible datasets",
    statuses: ["quarantined"],
    detail: "error",
    errorLike: "%upstream_inaccessible%",
  },
};

async function importJobDrilldown(
  db: D1Database,
  key: string,
  spec: { label: string; statuses: string[]; detail: "status" | "error"; errorLike?: string },
): Promise<DrilldownResult> {
  const placeholders = spec.statuses.map(() => "?").join(", ");
  const errorClause = spec.errorLike ? " AND last_error LIKE ?" : "";
  const binds = spec.errorLike ? [...spec.statuses, spec.errorLike] : spec.statuses;
  const rows = await db
    .prepare(
      `SELECT dataset_id, status, last_error, auto_attempts, updated_at
       FROM import_jobs
       WHERE source = 'openneuro' AND status IN (${placeholders})${errorClause}
       ORDER BY updated_at DESC LIMIT ${LIMIT}`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  // Shape each row so the existing kind:"dataset" renderer (datasetLink +
  // `item.status || item.last_error` detail cell) needs no UI change: in-flight
  // rows keep `status` (the lifecycle stage shown in the cell); failed/quarantined
  // rows drop it so the cell falls through to `last_error` (the actual reason).
  const items = (rows.results ?? []).map((r) =>
    spec.detail === "status"
      ? { dataset_id: r.dataset_id, status: r.status, auto_attempts: r.auto_attempts }
      : { dataset_id: r.dataset_id, last_error: r.last_error, auto_attempts: r.auto_attempts },
  );
  return { key, label: spec.label, kind: "dataset", count: items.length, items };
}

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
  // The UI builds the GitHub link from dataset_id directly (githubDatasetLink ->
  // github.com/nemarDatasets/<dataset_id>), so no github_repo column is needed.
  const rows = await db
    .prepare(
      `SELECT dataset_id, status, prescreen_status, requested_at, current_step, last_error
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
  const imp = IMPORT_DRILLDOWNS[key];
  if (imp) return importJobDrilldown(db, key, imp);
  return null;
}

/** Whether a drill-down key is known (used to 404 cleanly). */
export function isKnownDrilldown(key: string): boolean {
  return (
    key in DATASET_DRILLDOWNS ||
    key in PUBLICATION_DRILLDOWNS ||
    key in USER_DRILLDOWNS ||
    key in IMPORT_DRILLDOWNS
  );
}
