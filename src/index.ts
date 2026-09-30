// Worker entry: Hono app for dashboard.nemar.org. Serves the dashboard hub at
// the host root `/` (a root-only Worker route) and the observability dashboard
// (UI + API + hourly cron) under `/observability*`. Both are layered over the
// `nemar-dashboard` Pages project, which keeps serving `/citations`.

import { Hono } from "hono";
import { handleScheduled } from "./cron";
import { loadPushedProblems, loadSeriesBehind, umamiHealth, umamiReason } from "./lib/freshness";
import { loadCronStatus, loadLatestSnapshotState } from "./lib/store";
import { fetchUmamiLiveness } from "./lib/umami";
import { apiRoutes } from "./routes/api";
import { renderHubPage } from "./routes/hub";
import { renderDashboardPage } from "./routes/ui";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// Health for an external uptime monitor. `ok` is the alerting signal and is
// false — with a 503 so a monitor that only reads status codes still pages —
// whenever the dashboard is lying to its readers, not merely when the Worker is
// down. Independent faults qualify:
//
//   stale             the hourly cron missed a run, so the tiles are old
//   section_errors    a built-in section threw, so tiles are silently MISSING
//   snapshot_*        the newest snapshot row is corrupt or schema-drifted
//   series_behind     the S3 egress series is missing a closed UTC day, or never arrived
//   pushed_problems   a collector section is missing, stale, or reports an error metric
//   umami             website analytics unreachable, silent, or misconfigured
//   checks_failed     a freshness check itself could not run (for example an unmigrated table)
//   store_unavailable OBS_DB is unreadable, so we cannot judge any of the above
//
// The section_errors case is the one that motivated this: the `sync` section
// broke when nemar-cli migration 0053 dropped `nemar_sync_status`, and health
// answered `{"ok":true}` for weeks because per-section `Promise.allSettled`
// failures never reached it (issue #7).
//
// Every "cannot tell" is reported as unhealthy rather than healthy — a monitor
// that goes quiet when its own store breaks is the exact blind spot being
// fixed. That is also why this reads loadLatestSnapshotState rather than
// loadLatestSnapshot: the latter returns null for BOTH "no snapshot yet" and
// "snapshot is unreadable", and `null.section_errors ?? []` would score a
// corrupt snapshot as "zero section errors" — silently healthy. That window is
// real: ship a schema change and the previous cron's row stops validating while
// cron_status is still fresh, so nothing else would catch it until the next tick.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
app.get("/observability/health", async (c) => {
  const noStore = { "Cache-Control": "no-store" };
  const service = "nemar-observability";
  try {
    const now = new Date();
    const production = c.env.ENVIRONMENT === "production";
    // cron and snapshot are the store itself: if either cannot be read the
    // catch below reports store_unavailable. The freshness checks are settled
    // one by one, so a check that cannot run says so under its own name instead
    // of blanking the rest of the report.
    const [cron, snapshot] = await Promise.all([
      loadCronStatus(c.env.OBS_DB),
      loadLatestSnapshotState(c.env.OBS_DB),
    ]);
    const [seriesResult, pushedResult, umamiState] = await Promise.all([
      loadSeriesBehind(c.env.OBS_DB, now, production).then(
        (value) => ({ ok: true as const, value }),
        (err) => ({ ok: false as const, err }),
      ),
      loadPushedProblems(c.env.OBS_DB, now, production).then(
        (value) => ({ ok: true as const, value }),
        (err) => ({ ok: false as const, err }),
      ),
      fetchUmamiLiveness(c.env),
    ]);
    const checksFailed: string[] = [];
    if (!seriesResult.ok) {
      console.error("[health] series check failed:", seriesResult.err);
      checksFailed.push("series");
    }
    if (!pushedResult.ok) {
      console.error("[health] pushed-section check failed:", pushedResult.err);
      checksFailed.push("pushed_sections");
    }
    const seriesBehind = seriesResult.ok ? seriesResult.value : [];
    const pushedProblems = pushedResult.ok ? pushedResult.value : [];
    const umami = umamiHealth(umamiState, now, production);
    const umamiFailure = umamiReason(umamiState);
    const last = cron?.last_success_at ? Date.parse(cron.last_success_at) : Number.NaN;
    const stale = Number.isNaN(last) || Date.now() - last > STALE_AFTER_MS;
    // Report the keys only. The full error strings stay in the snapshot API;
    // health is what a pager reads, and it should fit in an alert body.
    const sectionErrors = snapshot.state === "ok" ? snapshot.sectionErrors : [];
    const unreadable = snapshot.state === "unreadable" ? snapshot.reason : null;
    const ok =
      !stale &&
      sectionErrors.length === 0 &&
      unreadable === null &&
      seriesBehind.length === 0 &&
      pushedProblems.length === 0 &&
      checksFailed.length === 0 &&
      (umami === "ok" || umami === "unconfigured");
    return c.json(
      {
        ok,
        service,
        stale,
        section_errors: sectionErrors,
        series_behind: seriesBehind,
        pushed_problems: pushedProblems,
        checks_failed: checksFailed,
        umami,
        ...(umamiFailure ? { umami_reason: umamiFailure } : {}),
        snapshot: snapshot.state,
        ...(unreadable ? { snapshot_error: unreadable } : {}),
        cron,
      },
      ok ? 200 : 503,
      noStore,
    );
  } catch (err) {
    console.error("[health] OBS_DB unreadable:", err);
    return c.json({ ok: false, service, error: "store_unavailable" }, 503, noStore);
  }
});
app.route("/observability/api", apiRoutes);

app.get("/observability", (c) => c.html(renderDashboardPage()));
app.get("/observability/", (c) => c.html(renderDashboardPage()));

// Host root: the dashboard hub (lists the NEMAR dashboards). The root-only
// Worker route in wrangler.toml sends only `/` here; `/citations` stays on Pages.
app.get("/", (c) => c.html(renderHubPage()));

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Bindings>;
