// Hourly snapshot recompute (wrangler crons = ["17 * * * *"]).

import { buildSnapshot } from "./lib/metrics";
import { recordCronRun, saveSnapshot } from "./lib/store";
import type { Bindings } from "./types";

/** Keep ~5 weeks of hourly snapshots for trend history; prune the rest. */
const KEEP_SNAPSHOTS = 850;

export async function handleScheduled(env: Bindings): Promise<void> {
  const started = Date.now();
  try {
    const snapshot = await buildSnapshot(env);
    await saveSnapshot(env.OBS_DB, snapshot);
    await env.OBS_DB.prepare(
      "DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)",
    )
      .bind(KEEP_SNAPSHOTS)
      .run();
    await recordCronRun(env.OBS_DB, true, snapshot.generated_at);
    const errs = snapshot.section_errors?.length ?? 0;
    console.log(
      `[cron] snapshot ${snapshot.generated_at} sections=${snapshot.sections.length} errors=${errs} in ${Date.now() - started}ms`,
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
