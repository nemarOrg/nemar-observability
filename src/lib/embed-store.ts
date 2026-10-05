// Reads and writes for embed_daily_loads in this Worker's own D1 (migration
// 0006). The rules (a settled day is written once, a closed day never goes
// down) are explained there and in embeds.ts.

import { EMBED_KINDS, type EmbedDayRow, normalizeKind } from "./embeds";

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

/** The latest stored day with any load, or null when no load was ever recorded. */
export async function loadLastNonzeroEmbedDay(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(date) AS last FROM embed_daily_loads WHERE loads > 0")
    .first<{ last: string | null }>();
  return row?.last ?? null;
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

/** Which share of the minute's budget a load draws on (see embeds.ts). */
export type BudgetPool = "preset" | "custom";

/**
 * Claim `cost` Analytics Engine queries from this UTC minute's shared budget of
 * `perMinute` in `pool`. True when the claim fits. The counter is in D1, so it
 * holds across every isolate; a claim that does not fit still counts, which only
 * makes a flood refuse sooner. Old minutes are deleted by the cron
 * (pruneQueryBudget), not on this public request path.
 */
export async function claimQueryBudget(
  db: D1Database,
  now: Date,
  cost: number,
  perMinute: number,
  pool: BudgetPool = "custom",
): Promise<boolean> {
  const key = `${now.toISOString().slice(0, 16)}|${pool}`;
  const row = await db
    .prepare(
      `INSERT INTO embed_query_budget (minute, used) VALUES (?1, ?2)
       ON CONFLICT(minute) DO UPDATE SET used = used + ?2 RETURNING used`,
    )
    .bind(key, cost)
    .first<{ used: number }>();
  return row !== null && row.used <= perMinute;
}

/** Delete budget rows from minutes that are over. Called by the hourly cron. */
export async function pruneQueryBudget(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString().slice(0, 16);
  await db.prepare("DELETE FROM embed_query_budget WHERE minute < ?1").bind(cutoff).run();
}

export interface EmbedSyncState {
  last_ok_at: string | null;
  last_error: string | null;
  last_run_at: string | null;
}

/** Record one sync attempt. Success clears last_error and advances last_ok_at;
 *  failure keeps the prior last_ok_at. Upserts, so a missing row is created. */
export async function recordEmbedSync(
  db: D1Database,
  ok: boolean,
  at: string,
  error?: string,
): Promise<void> {
  if (ok) {
    await db
      .prepare(
        `INSERT INTO embed_sync_status (id, last_ok_at, last_error, last_run_at) VALUES (1, ?1, NULL, ?1)
         ON CONFLICT(id) DO UPDATE SET last_ok_at = ?1, last_error = NULL, last_run_at = ?1`,
      )
      .bind(at)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO embed_sync_status (id, last_ok_at, last_error, last_run_at) VALUES (1, NULL, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET last_error = ?1, last_run_at = ?2`,
      )
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

/** A shared preset answer and when it was computed, if that was at most `ttlMs` ago. */
export interface SharedPresetAnswer {
  answer: string;
  /** Milliseconds since the epoch, never later than `now`. */
  computedAt: number;
}

/** Clock skew between isolates tolerated when judging a row's age. */
const SKEW_MS = 5_000;

export async function readPresetAnswer(
  db: D1Database,
  key: string,
  now: Date,
  ttlMs: number,
): Promise<SharedPresetAnswer | null> {
  const row = await db
    .prepare("SELECT answer, computed_at FROM embed_preset_answers WHERE key = ?1")
    .bind(key)
    .first<{ answer: string; computed_at: string }>();
  if (!row) return null;
  const computedAt = Date.parse(row.computed_at);
  const age = now.getTime() - computedAt;
  if (!(age > -SKEW_MS && age < ttlMs)) return null;
  return { answer: row.answer, computedAt: Math.min(computedAt, now.getTime()) };
}

/** Share a good preset answer with every isolate. */
export async function writePresetAnswer(
  db: D1Database,
  key: string,
  answer: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO embed_preset_answers (key, answer, computed_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET answer = ?2, computed_at = ?3`,
    )
    .bind(key, answer, now.toISOString())
    .run();
}

/** Delete preset answers and claims that are long past their use. Called by the hourly cron. */
export async function prunePresetAnswers(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
  await db.prepare("DELETE FROM embed_preset_answers WHERE computed_at < ?1").bind(cutoff).run();
  await db.prepare("DELETE FROM embed_preset_claims WHERE claimed_at < ?1").bind(cutoff).run();
}

/**
 * Take the claim on computing a preset window, for `ttlMs`. True when this
 * caller now holds it: no claim existed, or the one that did had expired. False
 * when another isolate holds a live claim.
 */
export async function tryClaimPreset(
  db: D1Database,
  key: string,
  now: Date,
  ttlMs: number,
): Promise<boolean> {
  const expired = new Date(now.getTime() - ttlMs).toISOString();
  const row = await db
    .prepare(
      `INSERT INTO embed_preset_claims (key, claimed_at) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET claimed_at = ?2 WHERE embed_preset_claims.claimed_at < ?3
       RETURNING key`,
    )
    .bind(key, now.toISOString(), expired)
    .first<{ key: string }>();
  return row !== null;
}

/** Give the claim back, so a waiting isolate need not wait for it to expire. */
export async function releasePresetClaim(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM embed_preset_claims WHERE key = ?1").bind(key).run();
}
