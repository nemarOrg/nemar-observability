// Worker entry: Hono app for dashboard.nemar.org. Serves the dashboard hub at
// the host root `/` (a root-only Worker route) and the observability dashboard
// (UI + API + hourly cron) under `/observability*`. Both are layered over the
// `nemar-dashboard` Pages project, which keeps serving `/citations`.

import { Hono } from "hono";
import { handleScheduled } from "./cron";
import { loadCronStatus, loadLatestSnapshotState } from "./lib/store";
import { apiRoutes } from "./routes/api";
import { renderHubPage } from "./routes/hub";
import { renderDashboardPage } from "./routes/ui";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// Health for an external uptime monitor. `ok` is the alerting signal and is
// false — with a 503 so a monitor that only reads status codes still pages —
// whenever the dashboard is lying to its readers, not merely when the Worker is
// down. Four independent faults qualify:
//
//   stale             the hourly cron missed a run, so the tiles are old
//   section_errors    a built-in section threw, so tiles are silently MISSING
//   snapshot_*        the newest snapshot row is corrupt or schema-drifted
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
    const [cron, snapshot] = await Promise.all([
      loadCronStatus(c.env.OBS_DB),
      loadLatestSnapshotState(c.env.OBS_DB),
    ]);
    const last = cron?.last_success_at ? Date.parse(cron.last_success_at) : Number.NaN;
    const stale = Number.isNaN(last) || Date.now() - last > STALE_AFTER_MS;
    // Report the keys only. The full error strings stay in the snapshot API;
    // health is what a pager reads, and it should fit in an alert body.
    const sectionErrors = snapshot.state === "ok" ? snapshot.sectionErrors : [];
    const unreadable = snapshot.state === "unreadable" ? snapshot.reason : null;
    const ok = !stale && sectionErrors.length === 0 && unreadable === null;
    return c.json(
      {
        ok,
        service,
        stale,
        section_errors: sectionErrors,
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
