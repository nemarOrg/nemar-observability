// Freshness rules for /health: a source that stopped delivering must turn the
// dashboard red on its own, without anyone noticing a missing day by eye.

import type { UmamiLiveness } from "./umami";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long after a UTC midnight the collectors get to publish the day that
 * just closed. They run hourly and retry by design, so six hours means several
 * failed runs, not one slow one.
 */
export const SERIES_GRACE_MS = 6 * HOUR_MS;

/** Umami sees traffic from many countries; six silent hours means it is broken. */
export const UMAMI_SILENT_AFTER_MS = 6 * HOUR_MS;

/** The newest UTC day every pushed daily series must already contain. */
export function expectedLatestDay(now: Date): string {
  return new Date(now.getTime() - SERIES_GRACE_MS - DAY_MS).toISOString().slice(0, 10);
}

export interface BehindSeries {
  key: string;
  latest: string | null;
  expected: string;
}

/** Pushed daily series whose newest day is older than expected, or that have none. */
export async function loadSeriesBehind(db: D1Database, now: Date): Promise<BehindSeries[]> {
  const expected = expectedLatestDay(now);
  const rows = await db
    .prepare(
      `SELECT s.series_key AS key,
         (SELECT MAX(p.date) FROM daily_series_points p
           WHERE p.section_key = s.section_key AND p.series_key = s.series_key) AS latest
       FROM daily_series s ORDER BY s.series_key`,
    )
    .all<{ key: string; latest: string | null }>();
  return (rows.results ?? [])
    .filter((row) => row.latest === null || row.latest < expected)
    .map((row) => ({ key: row.key, latest: row.latest, expected }));
}

export type UmamiHealth = "ok" | "unconfigured" | "unreachable" | "silent";

export function umamiHealth(liveness: UmamiLiveness, now: Date): UmamiHealth {
  if (liveness.state !== "ok") return liveness.state;
  return now.getTime() - liveness.lastEventAt > UMAMI_SILENT_AFTER_MS ? "silent" : "ok";
}
