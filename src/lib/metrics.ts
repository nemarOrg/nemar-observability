// Built-in metric sections, computed from nemar-cli's nemar-db (read-only) and
// Cloudflare Analytics Engine. These are the "pull" sections; pushed pipeline
// sections are merged in by buildSnapshot().

import type { Bindings } from "../types";
import { computeAccessSection } from "./access";
import { computeCfSection } from "./cf-section";
import { NO_RETRY, type RetryPolicy, withD1Retry } from "./d1-retry";
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
        hint: `Bins are log-scaled because sizes span seven orders of magnitude; equal-width bins would put about 98% of the catalog in one bar. ${overCutoff} datasets (${pct}%) are above the 100 GB archive cutoff and have no downloadable zip.`,
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

export async function archiveSection(db: D1Database, now: string): Promise<Section> {
  // Archive metrics are scoped to PUBLISHED (public + concept DOI), then split
  // again by whether an archive is even SUPPOSED to exist.
  //
  // NEMAR does not generate archives for datasets over 100 GB. nemar-cli #752
  // records that in `archive_skip_reason` and deliberately leaves
  // `archive_status` NULL, so a predicate keyed on archive_status alone cannot
  // tell "we chose not to build this" from "it is missing". Ours could not, and
  // reported 133 missing archives when 101 of those were working exactly as
  // designed and only 32 were actionable -- a permanently-amber tile
  // overstating by 4x, which teaches people to ignore the colour.
  //
  // So `eligible` (published minus skipped) is the denominator for anything
  // that means "should have an archive", and skipped datasets get their own
  // informational tile instead of being counted as a backlog.
  const c = await counts<"published" | "skipped" | "ready" | "pending" | "failed" | "missing">(
    db,
    `SELECT
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED}) as published,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_skip_reason IS NOT NULL) as skipped,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_skip_reason IS NULL AND archive_status = 'ready') as ready,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_status = 'pending') as pending,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED} AND archive_status = 'failed') as failed,
       (SELECT COUNT(*) FROM datasets WHERE ${PUBLISHED}
          AND archive_skip_reason IS NULL
          AND (archive_status IS NULL OR archive_status != 'ready')) as missing`,
  );
  const published = c.published ?? 0;
  const skipped = c.skipped ?? 0;
  const missing = c.missing ?? 0;
  const failed = c.failed ?? 0;
  const pending = c.pending ?? 0;
  // Never let a data anomaly (a skipped dataset that also has a ready archive)
  // produce a negative denominator the UI would render as a nonsense percent.
  const eligible = Math.max(0, published - skipped);
  return section(
    "archive",
    "Archives",
    "nemar-cli",
    [
      metric({
        key: "archive.ready",
        label: "With archive",
        value: c.ready ?? 0,
        total: eligible,
        severity: "ok",
        hint: "Published datasets with a downloadable zip archive, of those eligible for one",
      }),
      metric({
        key: "archive.missing",
        label: "Missing archive",
        value: missing,
        total: eligible,
        severity: missing > 0 ? "warn" : "ok",
        drilldown: "archive.missing",
        hint: "Eligible for an archive but without a confirmed one yet. Excludes datasets over the 100 GB archive limit.",
      }),
      metric({
        key: "archive.skipped",
        label: "Archive skipped",
        value: skipped,
        total: published,
        severity: "info",
        drilldown: "archive.skipped",
        hint: "Over the 100 GB archive limit, so no zip is built. Working as designed, not a backlog.",
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

const STALE_PENDING_DAYS = 7;

/** "1 recording", "2 recordings": the hints print counts, so they must agree in number. */
function countOf(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Reader-facing text for the partly-converted tile. Public copy: plain words. */
export function partialHint(datasets: number, recordings: number): string {
  if (datasets === 0) return "Datasets that are ready but missing some recordings";
  const where = datasets === 1 ? "in this dataset" : "across these datasets";
  return `Ready, but ${countOf(recordings, "recording", "recordings")} ${where} did not convert yet`;
}

/** Reader-facing text for the processing tile. Public copy: plain words. */
export function pendingHint(stale: number): string {
  const base = "Dispatched, conversion not yet confirmed";
  return stale > 0
    ? `${base}. ${stale === 1 ? "1 of these was" : `${stale.toLocaleString("en-US")} of these were`} last converted more than ${STALE_PENDING_DAYS} days ago, or never`
    : base;
}

/**
 * Per-dataset recording facts, with the converter's summary pulled out of
 * `zarr_data_failures` (nemar-cli keeps `pending` and `discovered` counts there
 * as additive keys; an older row holds a bare array, which has neither key).
 * `CAST` keeps a stray non-numeric value from comparing as text.
 */
const ZARR_FACTS = `
  SELECT zarr_status AS st,
         recording_count AS rc,
         COALESCE(zarr_store_count, 0) AS stores,
         COALESCE(zarr_errors, 0) AS errs,
         zarr_converted_at AS converted_at,
         CAST(COALESCE(CASE WHEN json_valid(zarr_data_failures) THEN json_extract(zarr_data_failures, '$.pending') END, 0) AS INTEGER) AS jp,
         CAST(COALESCE(CASE WHEN json_valid(zarr_data_failures) THEN json_extract(zarr_data_failures, '$.discovered') END, 0) AS INTEGER) AS jd
  FROM datasets WHERE ${PUBLIC_MANAGED}`;

/**
 * Zarr conversion health. "Ready" is a dataset-level status: a dataset stays
 * ready after a run in which some recordings failed or are still pending, so it
 * overstates coverage and flatlines once every dataset has a copy. The
 * recording-level tile keeps moving while conversion work continues, and
 * `zarr.complete` is the strict dataset-level count (ready with nothing failed
 * or pending).
 */
export async function zarrSection(db: D1Database, now: string): Promise<Section> {
  const staleBefore = new Date(Date.parse(now) - STALE_PENDING_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const c = await counts<
    | "universe"
    | "ready"
    | "complete"
    | "partial"
    | "partial_recordings"
    | "pending"
    | "pending_stale"
    | "failed"
    | "stores"
    | "converted"
    | "discovered"
  >(
    db,
    `SELECT
       COUNT(*) AS universe,
       COALESCE(SUM(st = 'ready'), 0) AS ready,
       COALESCE(SUM(st = 'ready' AND errs = 0 AND jp = 0), 0) AS complete,
       COALESCE(SUM(st = 'ready' AND (errs > 0 OR jp > 0)), 0) AS partial,
       COALESCE(SUM(CASE WHEN st = 'ready' AND (errs > 0 OR jp > 0)
         THEN CASE WHEN jd > 0 THEN MAX(jd - stores, 0) ELSE errs + jp END
         ELSE 0 END), 0) AS partial_recordings,
       COALESCE(SUM(st = 'pending'), 0) AS pending,
       COALESCE(SUM(st = 'pending' AND (converted_at IS NULL OR datetime(converted_at) < ?1)), 0) AS pending_stale,
       COALESCE(SUM(st = 'failed'), 0) AS failed,
       COALESCE(SUM(CASE WHEN st = 'ready' THEN stores ELSE 0 END), 0) AS stores,
       COALESCE(SUM(stores), 0) AS converted,
       -- Recordings found per dataset: the last index sweep's count, or what the
       -- conversion callback reported when that is larger (a sweep can lag a
       -- rebuild). The converter's own count (discovered = stores + failed +
       -- pending) is preferred when it reports one, because a failed recording
       -- can also sit in pending and would be counted twice by adding errors to
       -- pending; without it, stores + errors + pending is the best estimate. A
       -- failed dataset keeps its last good stores and reports this run's errors,
       -- which can overlap them, so take the larger rather than the sum. A
       -- dataset that failed outright has no sweep and no stores, so its failed
       -- recordings are its count.
       COALESCE(SUM(CASE WHEN st = 'failed'
         THEN MAX(COALESCE(rc, 0), stores, errs, jd)
         ELSE MAX(COALESCE(rc, 0), stores, CASE WHEN jd > 0 THEN jd ELSE stores + errs + jp END) END), 0) AS discovered
     FROM (${ZARR_FACTS})`,
    staleBefore,
  );
  const universe = c.universe ?? 0;
  const partial = c.partial ?? 0;
  const pending = c.pending ?? 0;
  const failed = c.failed ?? 0;
  return section(
    "zarr",
    "Zarr conversion",
    "nemar-cli",
    [
      // First so the card's headline ring shows recording-level coverage, the
      // number that keeps moving; dataset-level readiness has plateaued.
      metric({
        key: "zarr.recordings",
        label: "Recordings converted",
        value: c.converted ?? 0,
        total: c.discovered ?? 0,
        unit: "count",
        severity: "ok",
        hint: "Recordings with a Zarr copy, of all recordings found in public datasets. This keeps moving while conversion continues, even when the dataset counts do not. It includes datasets that are being rebuilt, unlike Zarr stores below",
      }),
      metric({
        key: "zarr.complete",
        label: "Fully converted",
        value: c.complete ?? 0,
        total: universe,
        severity: "ok",
        hint: "Public datasets where every recording has a Zarr copy, with none failed or waiting",
      }),
      metric({
        key: "zarr.ready",
        label: "Zarr ready",
        value: c.ready ?? 0,
        total: universe,
        severity: "ok",
        hint: "Public datasets with a Zarr serving copy, including datasets where a few recordings did not convert",
      }),
      metric({
        key: "zarr.partial",
        label: "Partly converted",
        value: partial,
        severity: pendingSeverity(partial),
        hint: partialHint(partial, c.partial_recordings ?? 0),
      }),
      metric({
        key: "zarr.pending",
        label: "Processing",
        value: pending,
        severity: pendingSeverity(pending),
        drilldown: "zarr.pending",
        hint: pendingHint(c.pending_stale ?? 0),
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
        hint: "Zarr stores across datasets with a ready serving copy. A dataset being rebuilt is left out until it finishes",
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
        hint: "Imports that failed after automatic retries",
      }),
      metric({
        key: "imports.quarantined",
        label: "Quarantined",
        value: quarantined,
        severity: failSeverity(quarantined),
        drilldown: "imports.quarantined",
        hint: "Set aside for an administrator to review",
      }),
      metric({
        key: "imports.upstream_inaccessible",
        label: "OpenNeuro inaccessible",
        value: c.upstream ?? 0,
        severity: "info",
        drilldown: "imports.upstream_inaccessible",
        hint: "The source files on OpenNeuro could not be read anonymously, so these imports wait until OpenNeuro resolves it. Included in Quarantined.",
      }),
      metric({
        key: "imports.imported",
        label: "Imported",
        value: c.imported ?? 0,
        severity: "ok",
        hint: "OpenNeuro datasets imported into NEMAR",
      }),
      metric({
        key: "imports.auto_24h",
        label: "Auto-dispatched (24h)",
        value: c.auto_24h ?? 0,
        unit: "count",
        severity: "info",
        hint: "Automatic imports started in the last 24 hours (about 16 a day while running, 0 while paused)",
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
  // One headline: registered users who proved an ORCID iD by signing in with
  // ORCID (`orcid_verified`, nemar-cli migration 0050). A DOI-discovered iD in
  // `users.orcid` is not counted: nobody proved it. Soft-deleted tombstones are
  // excluded (`deleted_at IS NULL`, migration 0037) and so are revoked users,
  // which also drops the id=-1 'nemar-system' sentinel. Approval queues and
  // token counts are admin work and live in the admin portal, not here.
  const c = await counts<"with_orcid">(
    db,
    `SELECT COUNT(*) as with_orcid FROM users
     WHERE orcid_verified = 1 AND status != 'revoked' AND deleted_at IS NULL`,
  );
  return section(
    "users",
    "Users",
    "nemar-cli",
    [
      metric({
        key: "users.with_orcid",
        label: "Users with ORCID iD",
        value: c.with_orcid ?? 0,
        unit: "users",
        severity: "info",
        hint: "Registered users who signed in with ORCID, which proves their iD",
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
export async function buildSnapshot(
  env: Bindings,
  retry: RetryPolicy = NO_RETRY,
): Promise<MetricSnapshot> {
  const now = new Date().toISOString();
  const db = env.NEMAR_DB;
  // Waits out nemar-db's hourly backup export instead of dropping the tiles.
  // Only builders that read nemar-db need it; the edge section reads our own DB.
  const guard = <T>(key: string, build: () => Promise<T>) => withD1Retry(build, retry, key);

  // One key per builder below, in the same order, so a failed section is
  // reported under its own key.
  const labels = [
    "datasets",
    "sizes",
    "archive",
    "zarr",
    "imports",
    "publication",
    "access",
    "cf",
    "users",
  ];
  const builtins = await Promise.allSettled([
    guard("datasets", () => datasetsSection(db, now)),
    guard("sizes", () => sizesSection(db, now)),
    guard("archive", () => archiveSection(db, now)),
    guard("zarr", () => zarrSection(db, now)),
    guard("imports", () => autoImportSection(db, now)),
    guard("publication", () => publicationSection(db, now)),
    guard("access", () => computeAccessSection(env, now)),
    computeCfSection(env, now),
    guard("users", () => usersSection(db, now)),
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
