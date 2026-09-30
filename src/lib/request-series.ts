// Planning for the stored edge-request series (issue #94). Pure functions, so
// the "never fetch a settled day twice" rule is tested without a network.

import { SERIES_GRACE_MS } from "./freshness";

const DAY_MS = 86_400_000;
/** Cloudflare keeps about 30 days of daily analytics. */
export const EDGE_RETENTION_DAYS = 30;

export interface StoredPoint {
  date: string;
  value: number;
  updated_at: string;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A closed day is settled once it was written after its own close plus the
 * grace the collectors get (freshness.ts). Until then the edge may still have
 * been adding late requests, so it is worth one more pull.
 */
export function isSettled(date: string, writtenAt: string): boolean {
  const settledAt = Date.parse(`${date}T00:00:00Z`) + DAY_MS + SERIES_GRACE_MS;
  return Date.parse(writtenAt) >= settledAt;
}

/**
 * The one date range to ask the edge for, `until` exclusive. It starts at the
 * oldest day inside retention that is absent or unsettled and always reaches
 * today, so the open day is refreshed and settled past days are left alone.
 * A day with no traffic has no row and is asked for again; that only widens a
 * single call, never adds one.
 */
export function planRequestPull(
  stored: StoredPoint[],
  now: Date,
): { since: string; until: string } {
  const byDate = new Map(stored.map((p) => [p.date, p]));
  const today = dayOf(now.getTime());
  let since = today;
  for (let back = EDGE_RETENTION_DAYS - 1; back >= 1; back--) {
    const date = dayOf(now.getTime() - back * DAY_MS);
    const have = byDate.get(date);
    if (!have || !isSettled(date, have.updated_at)) {
      since = date;
      break;
    }
  }
  return { since, until: dayOf(now.getTime() + DAY_MS) };
}

/**
 * Points worth writing. A closed day only ever goes up: a lower re-pull is a
 * partial answer, not a correction, so the stored value is written back (which
 * stamps the day as written, letting it settle instead of being re-requested
 * every hour). The open day is replaced with the authoritative day-to-date total.
 */
export function writablePoints(
  stored: StoredPoint[],
  fetched: { date: string; requests: number }[],
  today: string,
): { date: string; value: number }[] {
  const have = new Map(stored.map((p) => [p.date, p.value]));
  const out: { date: string; value: number }[] = [];
  for (const row of fetched) {
    const prior = have.get(row.date);
    if (row.date < today && prior !== undefined && row.requests < prior) {
      console.error(
        `[cron] cf requests for closed day ${row.date} came back lower (${row.requests} < ${prior}); keeping the stored value`,
      );
      out.push({ date: row.date, value: prior });
      continue;
    }
    out.push({ date: row.date, value: row.requests });
  }
  return out;
}
