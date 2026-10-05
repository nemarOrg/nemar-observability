// Reads and writes for embed_daily_loads in this Worker's own D1 (migration
// 0006). The rules (a settled day is written once, a closed day never goes
// down) are explained there and in embeds.ts.

import type { Bindings } from "../types";
import {
  EMBED_KINDS,
  type EmbedDayRow,
  type EmbedLoadsBlock,
  buildLoadsBlock,
  isEmbedConfigured,
  normalizeKind,
} from "./embeds";

/**
 * Upsert whole days. One statement per day writes all four kinds together.
 *
 * Value rule for a row that already exists: a closed day (before the UTC date of
 * this write) never goes down, because a lower value is a partial or empty
 * re-read, not a correction. When a write would lower a closed day, the row is
 * left exactly as it was, updated_at included, so a read that was not trusted
 * cannot stamp the day as settled. Otherwise the new figure is taken (the open
 * day takes its day-to-date figure) and updated_at advances, which is what lets
 * the day settle.
 */
export async function saveEmbedDays(
  db: D1Database,
  rows: readonly EmbedDayRow[],
  at: string,
): Promise<void> {
  if (rows.length === 0) return;
  const byDate = new Map<string, EmbedDayRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.date);
    if (list) list.push(row);
    else byDate.set(row.date, [row]);
  }
  const statements = [...byDate.values()].map((day) => {
    const values = day.map(() => "(?, ?, ?, ?)").join(", ");
    const bindings = day.flatMap((row) => [row.date, row.kind, Math.round(row.loads), at]);
    return db
      .prepare(
        `INSERT INTO embed_daily_loads (date, kind, loads, updated_at) VALUES ${values}
         ON CONFLICT(date, kind) DO UPDATE SET
           loads = CASE
             WHEN excluded.date < substr(excluded.updated_at, 1, 10) AND excluded.loads < embed_daily_loads.loads
             THEN embed_daily_loads.loads ELSE excluded.loads END,
           updated_at = CASE
             WHEN excluded.date < substr(excluded.updated_at, 1, 10) AND excluded.loads < embed_daily_loads.loads
             THEN embed_daily_loads.updated_at ELSE excluded.updated_at END`,
      )
      .bind(...bindings);
  });
  // A statement carries at most 16 bound values (4 rows), far under D1's limit
  // of 100, and a batch of 100 statements covers 100 days.
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
}

/** Stored rows for `start` to `end`, both inclusive, oldest first. */
export async function loadEmbedDays(
  db: D1Database,
  start: string,
  end: string,
): Promise<EmbedDayRow[]> {
  const rows = await db
    .prepare(
      `SELECT date, kind, loads FROM embed_daily_loads
       WHERE date >= ?1 AND date <= ?2 ORDER BY date, kind`,
    )
    .bind(start, end)
    .all<{ date: string; kind: string; loads: number }>();
  return (rows.results ?? []).map((r) => ({
    date: r.date,
    kind: normalizeKind(r.kind),
    loads: r.loads,
  }));
}

/** The earliest stored day, or null when nothing is stored. */
export async function loadFirstEmbedDay(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MIN(date) AS first FROM embed_daily_loads")
    .first<{ first: string | null }>();
  return row?.first ?? null;
}

/**
 * When each stored day was last written, on or after `since`. A day is only as
 * settled as its oldest row, so a day with fewer than all four kinds counts as
 * absent and is asked for again.
 */
export async function loadEmbedDayStamps(
  db: D1Database,
  since: string,
): Promise<Map<string, string>> {
  const rows = await db
    .prepare(
      `SELECT date, MIN(updated_at) AS at FROM embed_daily_loads
       WHERE date >= ?1 GROUP BY date HAVING COUNT(*) = ?2`,
    )
    .bind(since, EMBED_KINDS.length)
    .all<{ date: string; at: string }>();
  return new Map((rows.results ?? []).map((r) => [r.date, r.at]));
}

/**
 * The stored daily totals for the selected dates, shaped for the API. A store
 * that cannot answer (the migration not applied, a D1 fault) is reported as
 * unavailable, never as zero loads.
 */
export async function readEmbedLoads(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
): Promise<EmbedLoadsBlock> {
  let rows: EmbedDayRow[];
  try {
    rows = await loadEmbedDays(env.OBS_DB, start, end);
  } catch (err) {
    console.error("[embeds] stored daily totals could not be read:", err);
    return {
      status: "unavailable",
      coverage: null,
      days: [],
      totals: null,
      days_recorded: 0,
      days_in_range:
        Math.round(
          (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
        ) + 1,
      note: "Embed totals are currently unavailable.",
    };
  }
  return buildLoadsBlock(rows, start, end, now, isEmbedConfigured(env));
}

export interface EmbedSyncState {
  last_ok_at: string | null;
  last_error: string | null;
  last_run_at: string | null;
}

/** Record one sync attempt. Success clears last_error and advances last_ok_at;
 *  failure keeps the prior last_ok_at. */
export async function recordEmbedSync(
  db: D1Database,
  ok: boolean,
  at: string,
  error?: string,
): Promise<void> {
  if (ok) {
    await db
      .prepare(
        "UPDATE embed_sync_status SET last_ok_at = ?1, last_error = NULL, last_run_at = ?1 WHERE id = 1",
      )
      .bind(at)
      .run();
  } else {
    await db
      .prepare("UPDATE embed_sync_status SET last_error = ?1, last_run_at = ?2 WHERE id = 1")
      .bind((error ?? "unknown").slice(0, 500), at)
      .run();
  }
}

/** The single sync status row, or null when the migration has not created it. */
export async function loadEmbedSync(db: D1Database): Promise<EmbedSyncState | null> {
  return (
    (await db
      .prepare("SELECT last_ok_at, last_error, last_run_at FROM embed_sync_status WHERE id = 1")
      .first<EmbedSyncState>()) ?? null
  );
}
