// Hourly snapshot recompute (wrangler crons = ["47 * * * *"]).

import { fetchHostDay } from "./lib/cf-analytics";
import { CRON_RETRY, type RetryPolicy } from "./lib/d1-retry";
import { buildSnapshot } from "./lib/metrics";
import {
  loadHostDates,
  loadHostDayTotals,
  pruneHostDays,
  recordCronRun,
  saveDailySeries,
  saveHostDays,
  saveSnapshot,
} from "./lib/store";
import type { Bindings } from "./types";

/** Keep ~5 weeks of hourly snapshots for trend history; prune the rest. */
const KEEP_SNAPSHOTS = 850;
/** Match the cf section's reporting window, plus a day of slack. */
const KEEP_HOST_DAYS = 31;
/** How far back Cloudflare's adaptive dataset can be asked for a missing day. */
const BACKFILL_DAYS = 30;
/** Missing days fetched per run, so a backfill cannot stall the snapshot. */
const BACKFILL_PER_RUN = 5;

/**
 * Accumulate the per-host Cloudflare split, which cannot be queried over a
 * 30-day window in one call (see cf-analytics.ts).
 *
 * Pulls TWO days every run: today, whose totals are still growing, and
 * yesterday, which may have been last pulled before it finished. Both are
 * upserts of the authoritative day-to-date total, so re-pulling is idempotent.
 *
 * Isolated from the snapshot path on purpose: a zone-analytics outage or an
 * expired token must not take down the D1-derived sections, so this logs and
 * returns instead of throwing.
 *
 * PRUNE ONLY AFTER A SUCCESSFUL PULL. If pulls are failing, pruning anyway
 * would walk the retention window forward over a table nothing is refilling,
 * and after ~31 days the section would report `days: 0` / "no data accumulated
 * yet" — identical to a fresh deploy, with a month-long outage hidden behind it.
 * Holding the prune keeps the stale rows, so `latestDate` stops advancing and
 * the section can say the accumulator is stalled and since when. Retention
 * overshoots while broken; that is the intended trade.
 */
async function accumulateHostDays(env: Bindings, now: Date): Promise<void> {
  if (!env.CF_ZONE_ANALYTICS_TOKEN || !env.CF_ZONE_ID) return;
  const at = now.toISOString();
  const days = [
    new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10),
    now.toISOString().slice(0, 10),
  ];
  // Days inside Cloudflare's retention that we never stored (a fresh deploy, or
  // an outage): fill a few per run, newest first, until the window is complete.
  const dayMs = 86_400_000;
  const oldest = new Date(now.getTime() - BACKFILL_DAYS * dayMs).toISOString().slice(0, 10);
  try {
    const have = await loadHostDates(env.OBS_DB, oldest);
    const missing: string[] = [];
    for (let back = 2; back <= BACKFILL_DAYS; back++) {
      const date = new Date(now.getTime() - back * dayMs).toISOString().slice(0, 10);
      if (!have.has(date)) missing.push(date);
    }
    days.push(...missing.slice(0, BACKFILL_PER_RUN));
  } catch (err) {
    console.error("[cron] cf host-day backfill lookup failed:", err);
  }
  let pulled = 0;
  for (const date of days) {
    try {
      await saveHostDays(env.OBS_DB, await fetchHostDay(env, date), at);
      pulled++;
    } catch (err) {
      console.error(`[cron] cf host-day pull failed for ${date}:`, err);
    }
  }
  if (pulled === 0) {
    console.error("[cron] cf host-day: every pull failed; skipping prune to preserve the signal");
    return;
  }
  // Before the prune: the series is the permanent record, cf_daily_host is only
  // the window it is derived from.
  try {
    await saveRequestSeries(env, at);
  } catch (err) {
    console.error("[cron] cf request series save failed:", err);
  }
  try {
    await pruneHostDays(
      env.OBS_DB,
      new Date(now.getTime() - KEEP_HOST_DAYS * 86_400_000).toISOString().slice(0, 10),
    );
  } catch (err) {
    console.error("[cron] cf host-day prune failed:", err);
  }
}

/**
 * Keep every day's zone-wide request total beyond Cloudflare's 30 days.
 * Days are upserted (idempotent) and never deleted, so the lifetime total keeps
 * growing after cf_daily_host prunes the per-host rows.
 */
export async function saveRequestSeries(env: Bindings, at: string): Promise<void> {
  const totals = await loadHostDayTotals(env.OBS_DB);
  if (totals.length === 0) return;
  await saveDailySeries(
    env.OBS_DB,
    "cf",
    "cloudflare",
    [
      {
        key: "requests",
        label: "Network edge requests",
        unit: "count",
        aggregation: "sum",
        timezone: "UTC",
        coverage_start: totals[0].date,
        coverage_end: totals[totals.length - 1].date,
        freshness_after_hours: 36,
        points: totals.map((t) => ({ date: t.date, value: t.requests })),
      },
    ],
    at,
  );
}

export async function handleScheduled(
  env: Bindings,
  retry: RetryPolicy = CRON_RETRY,
): Promise<void> {
  const started = Date.now();
  try {
    // Before the snapshot: computeCfSection reads the rows this writes, so
    // running it first means the section reflects the current hour, not the
    // previous one.
    await accumulateHostDays(env, new Date());
    let retries = 0;
    const snapshot = await buildSnapshot(env, {
      ...retry,
      onRetry: (label) => {
        retries++;
        retry.onRetry?.(label);
      },
    });
    await saveSnapshot(env.OBS_DB, snapshot);
    await env.OBS_DB.prepare(
      "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)",
    )
      .bind(KEEP_SNAPSHOTS)
      .run();
    await recordCronRun(env.OBS_DB, true, snapshot.generated_at);
    const errs = snapshot.section_errors?.length ?? 0;
    console.log(
      `[cron] snapshot ${snapshot.generated_at} sections=${snapshot.sections.length} errors=${errs} d1_retries=${retries} in ${Date.now() - started}ms`,
    );
  } catch (err) {
    console.error("[cron] snapshot failed:", err);
    // Best-effort: record the failure so /health surfaces staleness. Must not
    // throw out of the scheduled handler.
    await recordCronRun(env.OBS_DB, false, new Date().toISOString(), String(err)).catch((e) =>
      console.error("[cron] could not record failure status:", e),
    );
  }
}
