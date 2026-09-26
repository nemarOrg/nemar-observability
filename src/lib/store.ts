// Reads/writes against this worker's own D1 (OBS_DB): snapshot history and
// pushed pipeline sections. Never touches nemar-db.

import type { HostDay } from "./cf-analytics";
import {
  type DailySeries,
  type MetricSnapshot,
  MetricSnapshotSchema,
  type Section,
  SectionSchema,
} from "./schema";

/** Persist a freshly computed snapshot (one row per cron run). */
export async function saveSnapshot(db: D1Database, snapshot: MetricSnapshot): Promise<void> {
  await db
    .prepare("INSERT INTO snapshots (generated_at, snapshot_json) VALUES (?, ?)")
    .bind(snapshot.generated_at, JSON.stringify(snapshot))
    .run();
}

/**
 * The state of the newest stored snapshot row.
 *
 * `loadLatestSnapshot` collapses "no row yet" and "row is corrupt" into the
 * same `null`, which is right for the API route (both mean "recompute") but
 * WRONG for /health: a corrupt row is a fault, an absent row on a fresh deploy
 * is not, and neither is the same as "read fine, no section errors". Health
 * needs all three distinguished, so it reads this instead.
 */
export type SnapshotState =
  | { state: "ok"; snapshot: MetricSnapshot; sectionErrors: string[] }
  /** No snapshot row at all (fresh deploy before the first cron). */
  | { state: "none" }
  /** A row exists but is not valid JSON or no longer matches the schema. */
  | { state: "unreadable"; reason: string };

/**
 * Read + validate the newest snapshot row, reporting which of the three states
 * it is in. Re-validates against the schema rather than blindly casting, so
 * schema drift is caught rather than served.
 */
export async function loadLatestSnapshotState(db: D1Database): Promise<SnapshotState> {
  const row = await db
    .prepare("SELECT snapshot_json FROM snapshots ORDER BY id DESC LIMIT 1")
    .first<{ snapshot_json: string }>();
  if (!row) return { state: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(row.snapshot_json);
  } catch (err) {
    console.error("[store] latest snapshot is not valid JSON:", err);
    return { state: "unreadable", reason: "invalid_json" };
  }
  const parsed = MetricSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[store] latest snapshot failed schema validation");
    return { state: "unreadable", reason: "schema_mismatch" };
  }
  return {
    state: "ok",
    snapshot: parsed.data,
    sectionErrors: (parsed.data.section_errors ?? []).map((e) => e.key),
  };
}

/** The latest stored snapshot, or null if none computed yet / it's unreadable.
 *  Both cases mean the same thing to the API route: recompute. Callers that
 *  need to tell them apart (i.e. /health) must use loadLatestSnapshotState. */
export async function loadLatestSnapshot(db: D1Database): Promise<MetricSnapshot | null> {
  const result = await loadLatestSnapshotState(db);
  return result.state === "ok" ? result.snapshot : null;
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

/** Stage a section before publishing it together with all its daily points. */
export async function stagePushedSection(
  db: D1Database,
  ingestId: string,
  section: Section,
): Promise<void> {
  const staleBefore = new Date(Date.parse(section.updated_at) - 86_400_000).toISOString();
  await db.batch([
    db
      .prepare(
        `DELETE FROM daily_series_point_ingest_staging
         WHERE ingest_id IN (SELECT ingest_id FROM section_ingest_staging WHERE started_at < ?)`,
      )
      .bind(staleBefore),
    db
      .prepare(
        `DELETE FROM daily_series_ingest_staging
         WHERE ingest_id IN (SELECT ingest_id FROM section_ingest_staging WHERE started_at < ?)`,
      )
      .bind(staleBefore),
    db.prepare("DELETE FROM section_ingest_staging WHERE started_at < ?").bind(staleBefore),
  ]);
  await db
    .prepare(
      `INSERT INTO section_ingest_staging (ingest_id, key, section_json, source, received_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ingestId,
      section.key,
      JSON.stringify(section),
      section.source,
      section.updated_at,
      section.updated_at,
    )
    .run();
}

/** Write possibly multi-batch series data to hidden staging tables. */
export async function stageDailySeries(
  db: D1Database,
  ingestId: string,
  series: DailySeries[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const item of series) {
    statements.push(
      db
        .prepare(
          `INSERT INTO daily_series_ingest_staging
           (ingest_id, series_key, label, unit, aggregation, timezone, coverage_start, coverage_end, freshness_after_hours)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ingestId,
          item.key,
          item.label,
          item.unit,
          item.aggregation,
          item.timezone,
          item.coverage_start,
          item.coverage_end,
          item.freshness_after_hours,
        ),
    );
    for (let offset = 0; offset < item.points.length; offset += 20) {
      const points = item.points.slice(offset, offset + 20);
      const values = points.map(() => "(?, ?, ?, ?)").join(", ");
      const bindings = points.flatMap((point) => [ingestId, item.key, point.date, point.value]);
      statements.push(
        db
          .prepare(
            `INSERT INTO daily_series_point_ingest_staging (ingest_id, series_key, date, value)
             VALUES ${values}`,
          )
          .bind(...bindings),
      );
    }
  }
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
}

/** Publish a staged section and its complete series update in one D1 batch. */
export async function commitPushedSectionIngest(
  db: D1Database,
  ingestId: string,
  sectionKey: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT INTO daily_series
      (section_key, series_key, source, label, unit, aggregation, timezone, coverage_start, coverage_end, freshness_after_hours, updated_at)
      SELECT h.key, s.series_key, h.source, s.label, s.unit, s.aggregation, s.timezone,
        s.coverage_start, s.coverage_end, s.freshness_after_hours, h.received_at
      FROM daily_series_ingest_staging s
      JOIN section_ingest_staging h ON h.ingest_id=s.ingest_id
      WHERE s.ingest_id=?
      ON CONFLICT(section_key, series_key) DO UPDATE SET source=excluded.source, label=excluded.label,
        unit=excluded.unit, aggregation=excluded.aggregation, timezone=excluded.timezone,
        coverage_start=MIN(daily_series.coverage_start, excluded.coverage_start),
        coverage_end=MAX(daily_series.coverage_end, excluded.coverage_end),
        freshness_after_hours=excluded.freshness_after_hours, updated_at=excluded.updated_at`)
      .bind(ingestId),
    db
      .prepare(`INSERT INTO daily_series_points (section_key, series_key, date, value, updated_at)
      SELECT h.key, p.series_key, p.date, p.value, h.received_at
      FROM daily_series_point_ingest_staging p
      JOIN section_ingest_staging h ON h.ingest_id=p.ingest_id
      WHERE p.ingest_id=?
      ON CONFLICT(section_key, series_key, date) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .bind(ingestId),
    db
      .prepare(`INSERT INTO ingested_sections (key, section_json, source, received_at)
      SELECT key, section_json, source, received_at
      FROM section_ingest_staging WHERE ingest_id=? AND key=?
      ON CONFLICT(key) DO UPDATE SET section_json=excluded.section_json,
        source=excluded.source, received_at=excluded.received_at`)
      .bind(ingestId, sectionKey),
    db.prepare("DELETE FROM daily_series_point_ingest_staging WHERE ingest_id=?").bind(ingestId),
    db.prepare("DELETE FROM daily_series_ingest_staging WHERE ingest_id=?").bind(ingestId),
    db.prepare("DELETE FROM section_ingest_staging WHERE ingest_id=?").bind(ingestId),
  ]);
}

/** Return the first existing key whose source or meaning is being changed. */
export async function dailySeriesMetadataConflict(
  db: D1Database,
  section: string,
  source: string,
  series: DailySeries[],
): Promise<string | null> {
  const rows = await db
    .prepare(
      `SELECT series_key, source, label, unit, aggregation, timezone, freshness_after_hours
       FROM daily_series WHERE section_key=?`,
    )
    .bind(section)
    .all<{
      series_key: string;
      source: string;
      label: string;
      unit: string;
      aggregation: string;
      timezone: string;
      freshness_after_hours: number;
    }>();
  const existing = new Map((rows.results ?? []).map((row) => [row.series_key, row]));
  for (const incoming of series) {
    const current = existing.get(incoming.key);
    if (
      current &&
      (current.source !== source ||
        current.label !== incoming.label ||
        current.unit !== incoming.unit ||
        current.aggregation !== incoming.aggregation ||
        current.timezone !== incoming.timezone ||
        current.freshness_after_hours !== incoming.freshness_after_hours)
    ) {
      return incoming.key;
    }
  }
  return null;
}

export interface DailySeriesRecord extends DailySeries {
  section: string;
  source: string;
  updated_at: string;
  latest_observation_date: string | null;
}

/** Persist metadata and source observations; a repeated push replaces each day. */
export async function saveDailySeries(
  db: D1Database,
  section: string,
  source: string,
  series: DailySeries[],
  at: string,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const item of series) {
    statements.push(
      db
        .prepare(`INSERT INTO daily_series
      (section_key, series_key, source, label, unit, aggregation, timezone, coverage_start, coverage_end, freshness_after_hours, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(section_key, series_key) DO UPDATE SET source=excluded.source, label=excluded.label, unit=excluded.unit,
      aggregation=excluded.aggregation, timezone=excluded.timezone,
      coverage_start=MIN(daily_series.coverage_start, excluded.coverage_start),
      coverage_end=MAX(daily_series.coverage_end, excluded.coverage_end),
      freshness_after_hours=excluded.freshness_after_hours, updated_at=excluded.updated_at`)
        .bind(
          section,
          item.key,
          source,
          item.label,
          item.unit,
          item.aggregation,
          item.timezone,
          item.coverage_start,
          item.coverage_end,
          item.freshness_after_hours,
          at,
        ),
    );
    // D1 allows at most 100 bound parameters per statement. Twenty points use
    // all 100 slots while cutting a large backfill to a small number of SQL
    // statements instead of one statement for every observation.
    for (let offset = 0; offset < item.points.length; offset += 20) {
      const points = item.points.slice(offset, offset + 20);
      const values = points.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const bindings = points.flatMap((point) => [section, item.key, point.date, point.value, at]);
      statements.push(
        db
          .prepare(`INSERT INTO daily_series_points (section_key, series_key, date, value, updated_at)
        VALUES ${values} ON CONFLICT(section_key, series_key, date) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
          .bind(...bindings),
      );
    }
  }
  for (let offset = 0; offset < statements.length; offset += 100)
    await db.batch(statements.slice(offset, offset + 100));
}

export async function loadDailySeries(
  db: D1Database,
  start: string,
  end: string,
): Promise<DailySeriesRecord[]> {
  const rows = await db
    .prepare(`SELECT s.section_key, s.series_key, s.source, s.label, s.unit, s.aggregation, s.timezone,
    s.coverage_start, s.coverage_end, s.freshness_after_hours, s.updated_at,
    (SELECT MAX(latest.date) FROM daily_series_points latest
      WHERE latest.section_key=s.section_key AND latest.series_key=s.series_key) AS latest_observation_date,
    p.date, p.value
    FROM daily_series s LEFT JOIN daily_series_points p ON p.section_key=s.section_key AND p.series_key=s.series_key
    AND p.date >= ? AND p.date <= ? AND p.date >= s.coverage_start AND p.date <= s.coverage_end WHERE s.coverage_start <= ? AND s.coverage_end >= ?
    ORDER BY s.section_key, s.series_key, p.date`)
    .bind(start, end, end, start)
    .all<{
      section_key: string;
      series_key: string;
      source: string;
      label: string;
      unit: "count" | "bytes";
      aggregation: "sum";
      timezone: "UTC";
      coverage_start: string;
      coverage_end: string;
      freshness_after_hours: number;
      updated_at: string;
      latest_observation_date: string | null;
      date: string | null;
      value: number | null;
    }>();
  const grouped = new Map<string, DailySeriesRecord>();
  for (const row of rows.results ?? []) {
    const id = `${row.section_key}\u0000${row.series_key}`;
    let record = grouped.get(id);
    if (!record) {
      record = {
        section: row.section_key,
        source: row.source,
        key: row.series_key,
        label: row.label,
        unit: row.unit,
        aggregation: row.aggregation,
        timezone: row.timezone,
        coverage_start: row.coverage_start,
        coverage_end: row.coverage_end,
        freshness_after_hours: row.freshness_after_hours,
        updated_at: row.updated_at,
        latest_observation_date: row.latest_observation_date,
        points: [],
      };
      grouped.set(id, record);
    }
    if (row.date !== null && row.value !== null)
      record.points.push({ date: row.date, value: row.value });
  }
  return [...grouped.values()];
}

/**
 * Upsert one day's per-host Cloudflare traffic.
 *
 * REPLACE, never accumulate: the cron re-pulls the current day every hour while
 * it is still filling up, so adding each pull to the previous one would multiply
 * today's traffic by the number of runs. The pulled value is always the
 * authoritative day-to-date total.
 */
export async function saveHostDays(db: D1Database, rows: HostDay[], at: string): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO cf_daily_host (date, host, requests, visits, bytes, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(date, host) DO UPDATE SET
             requests = ?3, visits = ?4, bytes = ?5, updated_at = ?6`,
        )
        .bind(r.date, r.host, r.requests, r.visits, r.bytes, at),
    ),
  );
}

export interface HostRollup {
  host: string;
  requests: number;
  visits: number;
  bytes: number;
}

/**
 * Per-host totals over the retained window, how many distinct days that window
 * actually covers, and the newest day present.
 *
 * `latestDate` is the liveness signal. The cron pulls yesterday + today on every
 * run, so a healthy accumulator always has today's row. If the newest row is
 * older than that, pulls are failing — and without this the section could not
 * tell a broken accumulator from a fresh deploy, since both eventually show
 * `days: 0`. Null when the table is empty for this window.
 */
export async function loadHostRollup(
  db: D1Database,
  sinceDate: string,
): Promise<{ hosts: HostRollup[]; days: number; latestDate: string | null }> {
  const [hosts, cover] = await Promise.all([
    db
      .prepare(
        `SELECT host, SUM(requests) AS requests, SUM(visits) AS visits, SUM(bytes) AS bytes
         FROM cf_daily_host WHERE date >= ?1
         GROUP BY host ORDER BY requests DESC`,
      )
      .bind(sinceDate)
      .all<HostRollup>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT date) AS n, MAX(date) AS latest FROM cf_daily_host WHERE date >= ?1",
      )
      .bind(sinceDate)
      .first<{ n: number; latest: string | null }>(),
  ]);
  return {
    hosts: hosts.results ?? [],
    days: cover?.n ?? 0,
    latestDate: cover?.latest ?? null,
  };
}

/** Drop accumulated host rows older than the reporting window. */
export async function pruneHostDays(db: D1Database, beforeDate: string): Promise<void> {
  await db.prepare("DELETE FROM cf_daily_host WHERE date < ?1").bind(beforeDate).run();
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
