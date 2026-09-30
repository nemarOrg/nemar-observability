// Freshness rules for /health: a source that stopped delivering must turn the
// dashboard red on its own, without anyone noticing a missing day by eye.

import type { UmamiFailure, UmamiLiveness } from "./umami";

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

/**
 * The first-party pushed daily series that production must always carry. Only
 * these are held to the "has yesterday" rule: a third-party pipeline that
 * pushes on its own schedule is not judged by ours, and a series that was
 * renamed or retired cannot keep /health red forever. A missing row is itself
 * a fault in production (a first ingest that is rejected every time never
 * registers a series, and health must not read that as "nothing to check").
 */
export const EXPECTED_SERIES = [{ section: "egress", key: "s3_bytes_downloaded" }] as const;

/**
 * The first-party pushed sections and the longest they may go without a
 * delivery. Egress runs hourly, so three hours is two missed runs. Storage runs
 * at 08:45 and 14:45 UTC, an 18 hour gap overnight, so a day is one missed day.
 */
export const EXPECTED_SECTION_MAX_AGE_MS: Record<string, number> = {
  egress: 3 * HOUR_MS,
  storage: 24 * HOUR_MS,
};

/** The newest UTC day every expected daily series must already contain. */
export function expectedLatestDay(now: Date): string {
  return new Date(now.getTime() - SERIES_GRACE_MS - DAY_MS).toISOString().slice(0, 10);
}

export interface BehindSeries {
  key: string;
  latest: string | null;
  expected: string;
}

/**
 * Expected daily series whose newest day is older than expected. Outside
 * production a series that has never been pushed is not a fault (dev has no
 * collectors); in production it is.
 */
export async function loadSeriesBehind(
  db: D1Database,
  now: Date,
  production: boolean,
): Promise<BehindSeries[]> {
  const expected = expectedLatestDay(now);
  const rows = await db
    .prepare(
      `SELECT s.section_key AS section, s.series_key AS key,
         (SELECT MAX(p.date) FROM daily_series_points p
           WHERE p.section_key = s.section_key AND p.series_key = s.series_key) AS latest
       FROM daily_series s`,
    )
    .all<{ section: string; key: string; latest: string | null }>();
  const found = new Map((rows.results ?? []).map((r) => [`${r.section}/${r.key}`, r.latest]));
  const behind: BehindSeries[] = [];
  for (const want of EXPECTED_SERIES) {
    const id = `${want.section}/${want.key}`;
    if (!found.has(id)) {
      if (production) behind.push({ key: want.key, latest: null, expected });
      continue;
    }
    const latest = found.get(id) ?? null;
    if (latest === null || latest < expected) behind.push({ key: want.key, latest, expected });
  }
  return behind;
}

export interface PushedProblem {
  section: string;
  problem: "missing" | "stale" | "reported_error" | "unreadable";
  detail: string;
}

/**
 * Faults in what the collectors push, for the first-party sections: one that
 * never arrived (production only), one that stopped arriving, and one that
 * arrived carrying an error metric (a failed collector run, or a collector
 * whose own code has stopped updating). Reports the metric key and the age,
 * never the free-text hint, so an alert body stays small and safe.
 */
export async function loadPushedProblems(
  db: D1Database,
  now: Date,
  production: boolean,
): Promise<PushedProblem[]> {
  const rows = await db
    .prepare("SELECT key, section_json, received_at FROM ingested_sections")
    .all<{ key: string; section_json: string; received_at: string }>();
  const bySection = new Map((rows.results ?? []).map((r) => [r.key, r]));
  const problems: PushedProblem[] = [];
  for (const [section, maxAgeMs] of Object.entries(EXPECTED_SECTION_MAX_AGE_MS)) {
    const row = bySection.get(section);
    if (!row) {
      if (production) problems.push({ section, problem: "missing", detail: "never received" });
      continue;
    }
    const received = Date.parse(row.received_at);
    if (Number.isNaN(received) || now.getTime() - received > maxAgeMs) {
      const hours = Number.isNaN(received)
        ? "unknown"
        : `${Math.floor((now.getTime() - received) / HOUR_MS)}h`;
      problems.push({ section, problem: "stale", detail: `last received ${hours} ago` });
    }
  }
  for (const row of bySection.values()) {
    let metrics: { key?: unknown; severity?: unknown }[];
    try {
      metrics = (JSON.parse(row.section_json) as { metrics: typeof metrics }).metrics;
      if (!Array.isArray(metrics)) throw new Error("no metrics");
    } catch {
      problems.push({
        section: row.key,
        problem: "unreadable",
        detail: "stored section is invalid",
      });
      continue;
    }
    for (const m of metrics) {
      if (m.severity === "error") {
        problems.push({
          section: row.key,
          problem: "reported_error",
          detail: typeof m.key === "string" ? m.key : "unknown metric",
        });
      }
    }
  }
  return problems;
}

export type UmamiHealth = "ok" | "unconfigured" | "misconfigured" | "unreachable" | "silent";

/**
 * Production must have Umami fully configured: a deleted or blanked API key
 * would otherwise read as "not configured" and pass. Only a non-production
 * environment may run without it. Partial configuration is always a fault.
 */
export function umamiHealth(liveness: UmamiLiveness, now: Date, production: boolean): UmamiHealth {
  if (liveness.state === "unconfigured") return production ? "misconfigured" : "unconfigured";
  if (liveness.state !== "ok") return liveness.state;
  return now.getTime() - liveness.lastEventAt > UMAMI_SILENT_AFTER_MS ? "silent" : "ok";
}

/** Why Umami was unreachable, when it was; never a value from the response. */
export function umamiReason(liveness: UmamiLiveness): UmamiFailure | null {
  return liveness.state === "unreachable" ? liveness.reason : null;
}
