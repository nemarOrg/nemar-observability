// Built-in metric sections, computed from nemar-cli's nemar-db (read-only) and
// Cloudflare Analytics Engine. These are the "pull" sections; pushed pipeline
// sections are merged in by buildSnapshot().

import type { Bindings } from "../types";
import { computeAccessSection } from "./access";
import {
  type Metric,
  type MetricSnapshot,
  SCHEMA_VERSION,
  type Section,
  type Severity,
  metric,
} from "./schema";
import { MANAGED, PRIVATE_MANAGED, PUBLIC_MANAGED, PUBLISHED, counts, scalar } from "./sql";
import { loadPushedSections } from "./store";

function section(
  key: string,
  label: string,
  source: string,
  metrics: Metric[],
  now: string,
): Section {
  return { key, label, source, metrics, updated_at: now };
}

/** error if >0 failures, warn if >0, else ok. */
function failSeverity(failed: number): Severity {
  return failed > 0 ? "error" : "ok";
}
function pendingSeverity(pending: number): Severity {
  return pending > 0 ? "warn" : "ok";
}

async function datasetsSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<
    "public_count" | "private_count" | "total_managed" | "with_doi" | "total_bytes"
  >(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED}) as public_count,
       (SELECT COUNT(*) FROM datasets WHERE ${PRIVATE_MANAGED}) as private_count,
       (SELECT COUNT(*) FROM datasets WHERE ${MANAGED}) as total_managed,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED}) as with_doi,
       (SELECT COALESCE(SUM(file_size), 0) FROM datasets WHERE ${PUBLIC_MANAGED}) as total_bytes`,
  );

  const licenseRows = await db
    .prepare(
      `SELECT license_tier as label, COUNT(*) as value FROM datasets WHERE ${PUBLIC_MANAGED} GROUP BY license_tier ORDER BY value DESC`,
    )
    .all<{ label: string; value: number }>();

  // Modality breakdown: split the csv `modalities` column in JS (accurate vs LIKE).
  const modRows = await db
    .prepare(
      `SELECT modalities FROM datasets WHERE ${PUBLIC_MANAGED} AND modalities IS NOT NULL AND modalities != ''`,
    )
    .all<{ modalities: string }>();
  const modCounts = new Map<string, number>();
  for (const r of modRows.results ?? []) {
    for (const m of r.modalities
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      modCounts.set(m, (modCounts.get(m) ?? 0) + 1);
    }
  }
  const modalityBreakdown = [...modCounts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const publicCount = c.public_count ?? 0;
  return section(
    "datasets",
    "Datasets",
    "nemar-cli",
    [
      metric({
        key: "datasets.public",
        label: "Public datasets",
        value: publicCount,
        total: c.total_managed ?? 0,
        severity: "info",
        hint: "Active, publicly visible managed datasets",
      }),
      metric({
        key: "datasets.private",
        label: "Private datasets",
        value: c.private_count ?? 0,
        severity: "info",
      }),
      metric({
        key: "datasets.with_doi",
        label: "With DOI",
        value: c.with_doi ?? 0,
        total: publicCount,
        severity: "info",
        hint: "Public datasets that have a concept DOI",
      }),
      metric({
        key: "datasets.bytes",
        label: "Total data",
        value: c.total_bytes ?? 0,
        unit: "bytes",
        severity: "info",
        hint: "Sum of file sizes across public datasets",
      }),
      metric({
        key: "datasets.by_license",
        label: "By license",
        value: publicCount,
        unit: "datasets",
        severity: "info",
        breakdown: (licenseRows.results ?? []).map((r) => ({
          label: r.label ?? "unknown",
          value: r.value,
        })),
      }),
      metric({
        key: "datasets.by_modality",
        label: "By modality",
        value: publicCount,
        unit: "datasets",
        severity: "info",
        breakdown: modalityBreakdown,
      }),
    ],
    now,
  );
}

async function archiveSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<"published" | "ready" | "pending" | "failed" | "missing">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED}) as published,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND archive_status = 'ready') as ready,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND archive_status = 'pending') as pending,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND archive_status = 'failed') as failed,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND (archive_status IS NULL OR archive_status != 'ready')) as missing`,
  );
  const published = c.published ?? 0;
  const missing = c.missing ?? 0;
  const failed = c.failed ?? 0;
  const pending = c.pending ?? 0;
  return section(
    "archive",
    "Archives",
    "nemar-cli",
    [
      metric({
        key: "archive.ready",
        label: "With archive",
        value: c.ready ?? 0,
        total: published,
        severity: "ok",
        hint: "Published datasets with a downloadable zip on S3",
      }),
      metric({
        key: "archive.missing",
        label: "Missing archive",
        value: missing,
        total: published,
        severity: missing > 0 ? "warn" : "ok",
        drilldown: "archive.missing",
        hint: "Published but no confirmed archive (run archive-sweep / generate)",
      }),
      metric({
        key: "archive.pending",
        label: "Archive pending",
        value: pending,
        severity: pendingSeverity(pending),
        drilldown: "archive.pending",
      }),
      metric({
        key: "archive.failed",
        label: "Archive failed",
        value: failed,
        severity: failSeverity(failed),
        drilldown: "archive.failed",
      }),
    ],
    now,
  );
}

async function zarrSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<"universe" | "ready" | "pending" | "failed" | "stores">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED}) as universe,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND zarr_status = 'ready') as ready,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND zarr_status = 'pending') as pending,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND zarr_status = 'failed') as failed,
       (SELECT COALESCE(SUM(zarr_store_count), 0) FROM datasets WHERE ${PUBLIC_MANAGED} AND zarr_status = 'ready') as stores`,
  );
  const universe = c.universe ?? 0;
  const pending = c.pending ?? 0;
  const failed = c.failed ?? 0;
  return section(
    "zarr",
    "Zarr conversion",
    "nemar-cli",
    [
      metric({
        key: "zarr.ready",
        label: "Zarr ready",
        value: c.ready ?? 0,
        total: universe,
        severity: "ok",
        hint: "Public datasets with a built Zarr serving copy",
      }),
      metric({
        key: "zarr.pending",
        label: "Processing",
        value: pending,
        severity: pendingSeverity(pending),
        drilldown: "zarr.pending",
        hint: "Dispatched, conversion not yet confirmed",
      }),
      metric({
        key: "zarr.failed",
        label: "Zarr failed",
        value: failed,
        severity: failSeverity(failed),
        drilldown: "zarr.failed",
      }),
      metric({
        key: "zarr.stores",
        label: "Zarr stores",
        value: c.stores ?? 0,
        unit: "count",
        severity: "info",
        hint: "Total .zarr stores across ready datasets",
      }),
    ],
    now,
  );
}

async function syncSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<"synced" | "pending" | "failed">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND nemar_sync_status = 'synced') as synced,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND nemar_sync_status = 'pending') as pending,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLIC_MANAGED} AND nemar_sync_status = 'failed') as failed`,
  );
  const failed = c.failed ?? 0;
  const pending = c.pending ?? 0;
  return section(
    "sync",
    "nemar.org sync",
    "nemar-cli",
    [
      metric({
        key: "sync.synced",
        label: "Synced",
        value: c.synced ?? 0,
        severity: "ok",
        hint: "Synced to the legacy nemar.org dataexplorer",
      }),
      metric({
        key: "sync.pending",
        label: "Sync pending",
        value: pending,
        severity: pendingSeverity(pending),
        drilldown: "sync.pending",
      }),
      metric({
        key: "sync.failed",
        label: "Sync failed",
        value: failed,
        severity: failSeverity(failed),
        drilldown: "sync.failed",
      }),
    ],
    now,
  );
}

async function publicationSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<"open" | "prescreen_failed" | "blocked">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM publication_requests WHERE status IN ('requested', 'approving')) as open,
       (SELECT COUNT(*) FROM publication_requests WHERE prescreen_status = 'failed') as prescreen_failed,
       (SELECT COUNT(*) FROM publication_requests WHERE status = 'blocked') as blocked`,
  );
  const open = c.open ?? 0;
  const blocked = c.blocked ?? 0;
  return section(
    "publication",
    "Publication",
    "nemar-cli",
    [
      metric({
        key: "publication.open",
        label: "Open requests",
        value: open,
        severity: pendingSeverity(open),
        drilldown: "publication.open",
        hint: "Requested or in-progress publication requests",
      }),
      metric({
        key: "publication.prescreen_failed",
        label: "Pre-screen failed",
        value: c.prescreen_failed ?? 0,
        severity: failSeverity(c.prescreen_failed ?? 0),
        drilldown: "publication.prescreen_failed",
      }),
      metric({
        key: "publication.blocked",
        label: "Blocked",
        value: blocked,
        severity: blocked > 0 ? "warn" : "ok",
        drilldown: "publication.blocked",
      }),
    ],
    now,
  );
}

async function usersSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<"pending" | "approved" | "active_tokens">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM users WHERE status = 'pending') as pending,
       (SELECT COUNT(*) FROM users WHERE status = 'approved') as approved,
       (SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL) as active_tokens`,
  );
  const pending = c.pending ?? 0;
  return section(
    "users",
    "Users",
    "nemar-cli",
    [
      metric({
        key: "users.pending",
        label: "Pending approval",
        value: pending,
        severity: pendingSeverity(pending),
        drilldown: "users.pending",
        hint: "Verified users awaiting admin approval",
      }),
      metric({
        key: "users.approved",
        label: "Approved users",
        value: c.approved ?? 0,
        severity: "info",
      }),
      metric({
        key: "users.active_tokens",
        label: "Active API tokens",
        value: c.active_tokens ?? 0,
        unit: "count",
        severity: "info",
      }),
    ],
    now,
  );
}

/**
 * Compute the full snapshot: all built-in sections (parallel) + the access
 * section (Analytics Engine) + any pushed pipeline sections, merged in order.
 * A section that throws is dropped (logged) rather than failing the whole
 * snapshot — one broken source shouldn't blank the dashboard.
 */
export async function buildSnapshot(env: Bindings): Promise<MetricSnapshot> {
  const now = new Date().toISOString();
  const db = env.NEMAR_DB;

  const builtins = await Promise.allSettled([
    datasetsSection(db, now),
    archiveSection(db, now),
    zarrSection(db, now),
    syncSection(db, now),
    publicationSection(db, now),
    computeAccessSection(env, now),
    usersSection(db, now),
  ]);

  const sections: Section[] = [];
  for (const r of builtins) {
    if (r.status === "fulfilled") sections.push(r.value);
    else console.error("[metrics] section failed:", r.reason);
  }

  // Merge pushed pipeline sections (push mode). Skip any whose key collides
  // with a built-in so a pipeline can't shadow core metrics.
  const builtinKeys = new Set(sections.map((s) => s.key));
  try {
    for (const s of await loadPushedSections(env.OBS_DB)) {
      if (!builtinKeys.has(s.key)) sections.push(s);
    }
  } catch (err) {
    console.error("[metrics] loading pushed sections failed:", err);
  }

  return { schema_version: SCHEMA_VERSION, generated_at: now, sections };
}
