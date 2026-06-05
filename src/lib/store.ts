// Reads/writes against this worker's own D1 (OBS_DB): snapshot history and
// pushed pipeline sections. Never touches nemar-db.

import { type MetricSnapshot, MetricSnapshotSchema, type Section, SectionSchema } from "./schema";

/** Persist a freshly computed snapshot (one row per cron run). */
export async function saveSnapshot(db: D1Database, snapshot: MetricSnapshot): Promise<void> {
  await db
    .prepare("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)")
    .bind(snapshot.generated_at, JSON.stringify(snapshot))
    .run();
}

/** The latest stored snapshot, or null if none computed yet / it's unreadable.
 *  Re-validates against the schema rather than blindly casting, so a corrupt or
 *  schema-drifted row triggers an on-demand recompute instead of serving a
 *  malformed shape. */
export async function loadLatestSnapshot(db: D1Database): Promise<MetricSnapshot | null> {
  const row = await db
    .prepare("SELECT snapshot_json FROM snapshots ORDER BY id DESC LIMIT 1")
    .first<{ snapshot_json: string }>();
  if (!row) return null;
  try {
    const parsed = MetricSnapshotSchema.safeParse(JSON.parse(row.snapshot_json));
    if (parsed.success) return parsed.data;
    console.error("[store] latest snapshot failed schema validation; recomputing");
    return null;
  } catch (err) {
    console.error("[store] latest snapshot is not valid JSON; recomputing:", err);
    return null;
  }
}

/**
 * Trend history for one metric key: [{ at, value, total? }] oldest->newest.
 * Pulls the recent snapshots and extracts the metric, so the UI can sparkline
 * without storing a separate time series.
 */
export async function loadMetricHistory(
  db: D1Database,
  metricKey: string,
  limit = 168, // ~1 week of hourly points
): Promise<{ at: string; value: number; total?: number }[]> {
  const rows = await db
    .prepare("SELECT generated_at, snapshot_json FROM snapshots ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all<{ generated_at: string; snapshot_json: string }>();
  const points: { at: string; value: number; total?: number }[] = [];
  for (const row of rows.results ?? []) {
    try {
      const snap = JSON.parse(row.snapshot_json) as MetricSnapshot;
      for (const s of snap.sections) {
        const m = s.metrics.find((x) => x.key === metricKey);
        if (m) {
          points.push({ at: row.generated_at, value: m.value, total: m.total });
          break;
        }
      }
    } catch (err) {
      console.error("[store] skipping corrupt snapshot row in history:", row.generated_at, err);
    }
  }
  return points.reverse();
}

export interface CronStatus {
  last_success_at: string | null;
  last_error: string | null;
  last_run_at: string | null;
}

/** Record a cron attempt. Success clears last_error and advances last_success_at;
 *  failure records the error but preserves the prior last_success_at. */
export async function recordCronRun(
  db: D1Database,
  ok: boolean,
  at: string,
  error?: string,
): Promise<void> {
  if (ok) {
    await db
      .prepare(
        "UPDATE cron_status SET last_success_at = ?, last_error = NULL, last_run_at = ? WHERE id = 1",
      )
      .bind(at, at)
      .run();
  } else {
    await db
      .prepare("UPDATE cron_status SET last_error = ?, last_run_at = ? WHERE id = 1")
      .bind((error ?? "unknown").slice(0, 500), at)
      .run();
  }
}

/** Read the single cron_status row, or null if it isn't there yet. */
export async function loadCronStatus(db: D1Database): Promise<CronStatus | null> {
  return (
    (await db
      .prepare("SELECT last_success_at, last_error, last_run_at FROM cron_status WHERE id = 1")
      .first<CronStatus>()) ?? null
  );
}

/** Replace the stored section for a pushed pipeline key (push mode). */
export async function savePushedSection(db: D1Database, section: Section): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ingested_sections (key, section_json, source, received_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET section_json = ?2, source = ?3, received_at = ?4`,
    )
    .bind(section.key, JSON.stringify(section), section.source, section.updated_at)
    .run();
}

/** All currently-stored pushed sections, validated against the schema. */
export async function loadPushedSections(db: D1Database): Promise<Section[]> {
  const rows = await db
    .prepare("SELECT section_json FROM ingested_sections")
    .all<{ section_json: string }>();
  const out: Section[] = [];
  for (const row of rows.results ?? []) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.section_json);
    } catch (err) {
      console.error("[store] pushed section is not valid JSON; dropping:", err);
      continue;
    }
    const parsed = SectionSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    else
      console.error(
        "[store] pushed section failed schema validation; dropping:",
        parsed.error.issues,
      );
  }
  return out;
}
