// Reads/writes against this worker's own D1 (OBS_DB): snapshot history and
// pushed pipeline sections. Never touches nemar-db.

import { type MetricSnapshot, type Section, SectionSchema } from "./schema";

/** Persist a freshly computed snapshot (one row per cron run). */
export async function saveSnapshot(db: D1Database, snapshot: MetricSnapshot): Promise<void> {
  await db
    .prepare("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)")
    .bind(snapshot.generated_at, JSON.stringify(snapshot))
    .run();
}

/** The latest stored snapshot, or null if none computed yet. */
export async function loadLatestSnapshot(db: D1Database): Promise<MetricSnapshot | null> {
  const row = await db
    .prepare("SELECT snapshot_json FROM snapshots ORDER BY id DESC LIMIT 1")
    .first<{ snapshot_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.snapshot_json) as MetricSnapshot;
  } catch {
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
    } catch {
      // skip a corrupt row
    }
  }
  return points.reverse();
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
    const parsed = SectionSchema.safeParse(JSON.parse(row.section_json));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
