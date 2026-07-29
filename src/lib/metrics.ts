// Built-in metric sections, computed from nemar-cli's nemar-db (read-only) and
// Cloudflare Analytics Engine. These are the "pull" sections; pushed pipeline
// sections are merged in by buildSnapshot().

import type { Bindings } from "../types";
import { computeAccessSection } from "./access";
import { computeCfSection } from "./cf-section";
import {
  type Metric,
  type MetricSnapshot,
  SCHEMA_VERSION,
  type Section,
  type Severity,
  metric,
} from "./schema";
import { ARCHIVE_CUTOFF_BYTES, buildSizeHistogram } from "./sizes";
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

/**
 * Dataset sizes: a log-binned histogram beside the largest datasets.
 *
 * Its own section with layout "split" rather than two more tiles in `datasets`:
 * a 23-bin histogram needs roughly two thirds of the row to be legible, and
 * dropping one tall tile into the uniform stat grid stretches the short tiles
 * beside it over a tall empty row. See src/lib/sizes.ts for why the bins are
 * logarithmic and why 100 GB is an exact boundary.
 *
 * Exported for tests; buildSnapshot() is the only production caller.
 */
export async function sizesSection(db: D1Database, now: string): Promise<Section> {
  const rows = await db
    .prepare(
      `SELECT dataset_id, file_size FROM datasets
       WHERE ${PUBLIC_MANAGED} AND file_size IS NOT NULL AND file_size > 0
       ORDER BY file_size DESC`,
    )
    .all<{ dataset_id: string; file_size: number }>();
  const sized = rows.results ?? [];
  const overCutoff = sized.filter((r) => r.file_size > ARCHIVE_CUTOFF_BYTES).length;
  const pct = sized.length ? Math.round((overCutoff / sized.length) * 100) : 0;

  // Concentration: what the ten largest hold, and what the smaller half does not.
  const top = sized.slice(0, 10);
  const topBytes = top.reduce((n, r) => n + r.file_size, 0);
  const totalBytes = sized.reduce((n, r) => n + r.file_size, 0);
  const smallHalf = sized.slice(Math.ceil(sized.length / 2));
  const smallHalfBytes = smallHalf.reduce((n, r) => n + r.file_size, 0);
  const smallHalfPct = totalBytes ? Math.round((smallHalfBytes / totalBytes) * 100) : 0;

  return {
    key: "sizes",
    label: "Dataset sizes",
    source: "nemar-cli",
    updated_at: now,
    layout: "split",
    metrics: [
      metric({
        key: "sizes.histogram",
        label: "Size distribution",
        value: sized.length,
        unit: "datasets",
        severity: "info",
        breakdown: buildSizeHistogram(sized.map((r) => r.file_size)),
        hint: `Log-scaled bins — sizes span seven orders of magnitude, so equal-width bins would put ~98% of the catalog in one bar. ${overCutoff} datasets (${pct}%) sit above the 100 GB archive cutoff and get no downloadable zip.`,
      }),
      // Headline is the SHARE these ten hold, not the number ten. "10" restates
      // the row count and tells a reader nothing; the concentration does --
      // ten datasets out of 754 hold well over a third of everything.
      metric({
        key: "sizes.largest",
        label: "Top 10 by size",
        value: topBytes,
        total: totalBytes,
        unit: "bytes",
        severity: "info",
        breakdown: top.map((r) => ({ label: r.dataset_id, value: r.file_size })),
        breakdown_unit: "bytes",
        breakdown_style: "ranked",
        hint: `The ten largest of ${sized.length} public datasets. Storage is heavily concentrated: the smaller half of the catalog accounts for ${smallHalfPct}% of all bytes.`,
      }),
    ],
  };
}

async function archiveSection(db: D1Database, now: string): Promise<Section> {
  // All archive metrics are scoped to PUBLISHED (public + concept DOI) so the
  // denominator is consistent and `ready` can never exceed `published` -- a
  // published dataset is the only thing that should have a generated archive.
  const c = await counts<"published" | "ready" | "pending" | "failed" | "missing">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED}) as published,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_status = 'ready') as ready,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_status = 'pending') as pending,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_status = 'failed') as failed,
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
        hint: "Public datasets with a built Zarr serving copy (of all public datasets)",
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

/**
 * OpenNeuro auto-import (epic #775). Reads the import pipeline state from
 * `import_jobs` (status, populated by the paced scheduler + onboard workflow)
 * and the dispatch heartbeat from `audit_log` (action='auto_import_dispatch').
 * `import_jobs.source` is always 'openneuro' for this section. The `auto_24h`
 * tile reads 0 while AUTO_IMPORT_ENABLED is dark, then becomes the live "the
 * engine is firing" signal once the flag is flipped (~16 dispatches/day).
 */
export async function autoImportSection(db: D1Database, now: string): Promise<Section> {
  const c = await counts<
    "active" | "failed" | "quarantined" | "upstream" | "imported" | "auto_24h"
  >(
    db,
    // active/failed/quarantined are live pipeline states (import_jobs), but
    // `imported` is the TRUE count of properly-imported OpenNeuro datasets: the
    // `source='openneuro'` rows in `datasets`. NOT import_jobs (only has rows for
    // the new pipeline). The legacy `ds######` rows that used to inflate this
    // total were deleted when nemar-cli#793 / epic #837 shipped (v0.8.70), so
    // every `source='openneuro'` row is now an `on######` import -- the old
    // `dataset_id LIKE 'on%'` filter is no longer needed.
    `SELECT
       (SELECT COUNT(*) FROM import_jobs WHERE source = 'openneuro' AND status IN ('preparing','copying','finalizing')) as active,
       (SELECT COUNT(*) FROM import_jobs WHERE source = 'openneuro' AND status = 'failed') as failed,
       (SELECT COUNT(*) FROM import_jobs WHERE source = 'openneuro' AND status = 'quarantined') as quarantined,
       (SELECT COUNT(*) FROM import_jobs WHERE source = 'openneuro' AND status = 'quarantined' AND last_error LIKE '%upstream_inaccessible%') as upstream,
       (SELECT COUNT(*) FROM datasets WHERE source = 'openneuro') as imported,
       (SELECT COUNT(*) FROM audit_log WHERE action = 'auto_import_dispatch' AND timestamp >= datetime('now','-1 day')) as auto_24h`,
  );
  const active = c.active ?? 0;
  const failed = c.failed ?? 0;
  const quarantined = c.quarantined ?? 0;
  return section(
    "imports",
    "OpenNeuro import",
    "nemar-cli",
    [
      metric({
        key: "imports.active",
        label: "In flight",
        value: active,
        severity: pendingSeverity(active),
        drilldown: "imports.active",
        hint: "Imports currently preparing, copying, or finalizing",
      }),
      metric({
        key: "imports.failed",
        label: "Failed",
        value: failed,
        severity: failSeverity(failed),
        drilldown: "imports.failed",
        hint: "Imports that errored after the auto-retry cap",
      }),
      metric({
        key: "imports.quarantined",
        label: "Quarantined",
        value: quarantined,
        severity: failSeverity(quarantined),
        drilldown: "imports.quarantined",
        hint: "Parked for admin review",
      }),
      metric({
        key: "imports.upstream_inaccessible",
        label: "OpenNeuro inaccessible",
        value: c.upstream ?? 0,
        severity: "info",
        drilldown: "imports.upstream_inaccessible",
        hint: "OpenNeuro-side problem (objects not anonymously readable, no signed login); report to OpenNeuro support. Subset of Quarantined.",
      }),
      metric({
        key: "imports.imported",
        label: "Imported",
        value: c.imported ?? 0,
        severity: "ok",
        hint: "OpenNeuro datasets imported into NEMAR (source='openneuro' in datasets; legacy ds-numbered rows retired per nemar-cli#793)",
      }),
      metric({
        key: "imports.auto_24h",
        label: "Auto-dispatched (24h)",
        value: c.auto_24h ?? 0,
        unit: "count",
        severity: "info",
        hint: "Auto-import dispatches in the last 24h (~16/day when active; 0 while dark)",
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

// Exported for tests (run against a real SQLite engine). Not part of the
// public snapshot API; buildSnapshot() is the only production caller.
export async function usersSection(db: D1Database, now: string): Promise<Section> {
  // Every user count excludes soft-deleted tombstones (`deleted_at IS NULL`,
  // nemar-cli migration 0037). The status pin also drops the id=-1
  // 'nemar-system' sentinel (it is status='revoked'), but deleted_at is the
  // authoritative exclusion now that the column exists.
  const c = await counts<"pending" | "verified" | "approved" | "active_tokens">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM users WHERE status = 'pending'  AND deleted_at IS NULL) as pending,
       (SELECT COUNT(*) FROM users WHERE status = 'verified' AND deleted_at IS NULL) as verified,
       (SELECT COUNT(*) FROM users WHERE status = 'approved' AND deleted_at IS NULL) as approved,
       (SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL) as active_tokens`,
  );
  const pending = c.pending ?? 0;
  const verified = c.verified ?? 0;
  return section(
    "users",
    "Users",
    "nemar-cli",
    [
      // Email-verified users are the actionable approval queue: nemar-cli's
      // POST /admin/approve/:username only approves status='verified' (or
      // re-approves 'revoked'); a 'pending' user gets 400 "needs to verify
      // their email first". So this is the warn tile.
      metric({
        key: "users.verified",
        label: "Awaiting approval",
        value: verified,
        severity: pendingSeverity(verified),
        drilldown: "users.verified",
        hint: "Email-verified users an admin can approve now (nemar approve)",
      }),
      metric({
        key: "users.pending",
        label: "Pending verification",
        value: pending,
        severity: "info",
        drilldown: "users.pending",
        hint: "Signed up but not yet email-verified / web-onboarded — not one-click approvable",
      }),
      metric({
        key: "users.approved",
        label: "Approved users",
        value: c.approved ?? 0,
        severity: "info",
        drilldown: "users.approved",
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
 * A section that throws is recorded in `section_errors` (not silently dropped)
 * so the dashboard can show a visible "unavailable" signal instead of just
 * fewer tiles — one broken source shouldn't blank the whole dashboard, but it
 * also shouldn't hide that it's broken.
 */
export async function buildSnapshot(env: Bindings): Promise<MetricSnapshot> {
  const now = new Date().toISOString();
  const db = env.NEMAR_DB;

  const labels = ["datasets", "archive", "zarr", "imports", "publication", "access", "cf", "users"];
  const builtins = await Promise.allSettled([
    datasetsSection(db, now),
    sizesSection(db, now),
    archiveSection(db, now),
    zarrSection(db, now),
    autoImportSection(db, now),
    publicationSection(db, now),
    computeAccessSection(env, now),
    computeCfSection(env, now),
    usersSection(db, now),
  ]);

  const sections: Section[] = [];
  const sectionErrors: { key: string; error: string }[] = [];
  builtins.forEach((r, i) => {
    if (r.status === "fulfilled") {
      sections.push(r.value);
    } else {
      const key = labels[i] ?? `section_${i}`;
      console.error(`[metrics] section "${key}" failed:`, r.reason);
      sectionErrors.push({ key, error: String(r.reason).slice(0, 300) });
    }
  });

  // Merge pushed pipeline sections (push mode). Skip any whose key collides
  // with a built-in so a pipeline can't shadow core metrics.
  const builtinKeys = new Set(sections.map((s) => s.key));
  try {
    for (const s of await loadPushedSections(env.OBS_DB)) {
      if (!builtinKeys.has(s.key)) sections.push(s);
    }
  } catch (err) {
    console.error("[metrics] loading pushed sections failed:", err);
    sectionErrors.push({ key: "pushed", error: String(err).slice(0, 300) });
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: now,
    sections,
    ...(sectionErrors.length ? { section_errors: sectionErrors } : {}),
  };
}
