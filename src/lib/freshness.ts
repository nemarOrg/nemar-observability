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
export const EXPECTED_SERIES = [
  { section: "egress", key: "s3_bytes_downloaded" },
  { section: "website", key: "pageviews" },
] as const;

/**
 * The first-party pushed sections and the longest each may go without a
 * successful collector run. A day and two hours: the collectors run hourly (egress,
 * and website page views from the Umami pusher) or twice a day (storage) and retry
 * by themselves, so only a day with no success at all is a fault, and one failed
 * run never is. It is also long enough that the old once-a-day timer stays green
 * until the new ones are installed.
 */
export const EXPECTED_SECTION_MAX_AGE_MS: Record<string, number> = {
  egress: 26 * HOUR_MS,
  storage: 26 * HOUR_MS,
  website: 26 * HOUR_MS,
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
  problem: "missing" | "stale" | "code_stale" | "unreadable";
  detail: string;
}

/**
 * Faults in what the first-party collectors push: a section that never arrived
 * (production only), one whose collector has not succeeded within its window
 * (`last_ok_at`, which one failed run does not move), one whose collector code
 * has stopped updating (its `code_stale` metric), and one that cannot be read.
 * Third-party sections are not judged: their `severity` is a tile's display level,
 * not a health report. Reports ages and metric keys, never free-text hints, so an
 * alert body stays small and safe.
 */
export async function loadPushedProblems(
  db: D1Database,
  now: Date,
  production: boolean,
): Promise<PushedProblem[]> {
  const rows = await db
    .prepare("SELECT key, section_json, last_ok_at FROM ingested_sections")
    .all<{ key: string; section_json: string; last_ok_at: string | null }>();
  const bySection = new Map((rows.results ?? []).map((r) => [r.key, r]));
  const problems: PushedProblem[] = [];
  for (const [section, maxAgeMs] of Object.entries(EXPECTED_SECTION_MAX_AGE_MS)) {
    const row = bySection.get(section);
    if (!row) {
      if (production) problems.push({ section, problem: "missing", detail: "never received" });
      continue;
    }
    const lastOk = row.last_ok_at ? Date.parse(row.last_ok_at) : Number.NaN;
    if (Number.isNaN(lastOk)) {
      problems.push({ section, problem: "stale", detail: "no successful run yet" });
    } else if (now.getTime() - lastOk > maxAgeMs) {
      const hours = Math.floor((now.getTime() - lastOk) / HOUR_MS);
      problems.push({ section, problem: "stale", detail: `last success ${hours}h ago` });
    }
    let metrics: { key?: unknown; severity?: unknown }[];
    try {
      metrics = (JSON.parse(row.section_json) as { metrics: typeof metrics }).metrics;
      if (!Array.isArray(metrics)) throw new Error("no metrics");
    } catch {
      problems.push({ section, problem: "unreadable", detail: "stored section is invalid" });
      continue;
    }
    for (const m of metrics) {
      if (
        m.severity === "error" &&
        typeof m.key === "string" &&
        m.key.endsWith(".collector.code_stale")
      ) {
        problems.push({ section, problem: "code_stale", detail: m.key });
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
