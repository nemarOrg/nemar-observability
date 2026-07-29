// Reads/writes against this worker's own D1 (OBS_DB): snapshot history and
// pushed pipeline sections. Never touches nemar-db.

import type { HostDay } from "./cf-analytics";
import { type MetricSnapshot, MetricSnapshotSchema, type Section, SectionSchema } from "./schema";

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

/** Per-host totals over the retained window, plus how many distinct days that
 *  window actually covers (the per-host view backfills one day per cron run,
 *  so early on it is honestly shorter than 30 days). */
export async function loadHostRollup(
  db: D1Database,
  sinceDate: string,
): Promise<{ hosts: HostRollup[]; days: number }> {
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
      .prepare("SELECT COUNT(DISTINCT date) AS n FROM cf_daily_host WHERE date >= ?1")
      .bind(sinceDate)
      .first<{ n: number }>(),
  ]);
  return { hosts: hosts.results ?? [], days: cover?.n ?? 0 };
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
