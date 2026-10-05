// Hourly snapshot recompute (wrangler crons = ["47 * * * *"]).

import { fetchHostDay, fetchZoneDailyRequests } from "./lib/cf-analytics";
import { CRON_RETRY, type RetryPolicy } from "./lib/d1-retry";
import {
  loadEmbedDayStamps,
  loadEmbedDays,
  loadFirstEmbedDay,
  pruneQueryBudget,
  recordEmbedSync,
  saveEmbedDays,
} from "./lib/embed-store";
import {
  buildEmbedDays,
  embedRetentionStart,
  fetchEmbedDays,
  isEmbedConfigured,
  planEmbedPull,
  writableEmbedDays,
} from "./lib/embeds";
import { buildSnapshot } from "./lib/metrics";
import { isSettled, planRequestPull, writablePoints } from "./lib/request-series";
import {
  loadHostDayStamps,
  loadSeriesPoints,
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

/**
 * Accumulate the per-host Cloudflare split, which cannot be queried over a
 * 30-day window in one call (see cf-analytics.ts).
 *
 * Pulls today every run (its totals are still growing) and yesterday only
 * until it is settled (see request-series.ts), so a closed day costs one or two
 * calls in its life, not one per hour. Both are upserts of the authoritative
 * day-to-date total, so re-pulling is idempotent. The per-host view fills in
 * one day at a time from deploy; the lifetime request total does not depend on
 * it (see syncRequestSeries).
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
  const dayMs = 86_400_000;
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - dayMs).toISOString().slice(0, 10);
  const days = [today];
  try {
    const stamps = await loadHostDayStamps(env.OBS_DB, yesterday);
    const written = stamps.get(yesterday);
    if (!written || !isSettled(yesterday, written)) days.unshift(yesterday);
  } catch (err) {
    console.error("[cron] cf host-day settle lookup failed:", err);
    days.unshift(yesterday);
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
 * Keep every day's zone-wide request total beyond Cloudflare's 30 days, from
 * the same daily rollup as the headline (httpRequests1dGroups). One call per
 * run covers the open day plus any day not yet settled or never stored; settled
 * days are not asked for again and never overwritten with a lower value. Points
 * are never deleted, so the lifetime total keeps growing.
 *
 * Isolated like the host pull: an edge outage must not stop the snapshot.
 */
export async function syncRequestSeries(env: Bindings, now: Date): Promise<void> {
  if (!env.CF_ZONE_ANALYTICS_TOKEN || !env.CF_ZONE_ID) return;
  try {
    const stored = await loadSeriesPoints(env.OBS_DB, "cf", "requests");
    const { since, until } = planRequestPull(stored, now);
    const fetched = await fetchZoneDailyRequests(env, since, until);
    const points = writablePoints(stored, fetched, now.toISOString().slice(0, 10));
    if (points.length === 0) return;
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
          coverage_start: points[0].date,
          coverage_end: points[points.length - 1].date,
          freshness_after_hours: 36,
          points,
        },
      ],
      now.toISOString(),
    );
  } catch (err) {
    console.error("[cron] cf request series sync failed:", err);
  }
}

/**
 * Keep every UTC day's embed loads by kind beyond the edge's retention (about
 * three months), from the website's embed dataset (migration 0006). One ranged
 * read per run covers the open day plus any day not yet stored or not yet
 * settled; a settled day is not asked for again and a closed day is never
 * overwritten with less. Rows are never deleted.
 *
 * Every attempt is recorded (migration 0007), so the public answer can say when
 * the totals were last updated and downgrade a card whose sync has gone stale.
 * Zero embeds is a normal state and a failure here changes no health rule: it is
 * logged with its stage, dataset and range, recorded, and shown on the page.
 * Isolated like the request series: an edge outage must not stop the snapshot.
 */
export async function syncEmbedDays(env: Bindings, now: Date): Promise<void> {
  if (!isEmbedConfigured(env)) {
    console.warn(
      "[cron] embed loads sync skipped: CF_ANALYTICS_TOKEN, CF_ACCOUNT_ID or EMBED_AE_DATASET is not configured",
    );
    return;
  }
  let stage = "plan";
  let since = "";
  let until = "";
  try {
    const today = now.toISOString().slice(0, 10);
    const first = await loadFirstEmbedDay(env.OBS_DB);
    const stamps = await loadEmbedDayStamps(env.OBS_DB, embedRetentionStart(now));
    ({ since, until } = planEmbedPull(first, stamps, now));
    stage = "read the edge";
    // The whole retention window, though only days from `since` are written: an
    // answer with a row for no day at all settles no zeros (buildEmbedDays), and
    // that needs the wider window to tell a quiet stretch from a dead dataset.
    const rows = await fetchEmbedDays(env, embedRetentionStart(now), until);
    stage = "build days";
    const fetched = buildEmbedDays(rows, since, today, first);
    stage = "write days";
    if (fetched.length > 0) {
      const stored = await loadEmbedDays(env.OBS_DB, since, today);
      await saveEmbedDays(env.OBS_DB, writableEmbedDays(stored, fetched, today), now.toISOString());
    }
    stage = "record success";
    await recordEmbedSync(env.OBS_DB, true, now.toISOString());
  } catch (err) {
    console.error(
      `[cron] embed loads sync failed at "${stage}" (dataset ${env.EMBED_AE_DATASET}, ${since || "?"} to ${until || "?"}):`,
      err,
    );
    await recordEmbedSync(env.OBS_DB, false, now.toISOString(), `${stage}: ${String(err)}`).catch(
      (e) => console.error("[cron] could not record the embed sync failure:", e),
    );
  }
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
    const now = new Date();
    await accumulateHostDays(env, now);
    await syncRequestSeries(env, now);
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
  // After the snapshot and its status are saved, whatever happened to them: the
  // embed read is the one outbound call a slow edge could hold up, and it must
  // not delay either (nor be skipped because the snapshot failed).
  const now = new Date();
  await pruneQueryBudget(env.OBS_DB, now).catch((e) =>
    console.error("[cron] could not prune the embed query budget:", e),
  );
  await syncEmbedDays(env, now);
}
