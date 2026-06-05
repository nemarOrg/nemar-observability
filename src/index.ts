// Worker entry: Hono app for dashboard.nemar.org. Serves the dashboard hub at
// the host root `/` (a root-only Worker route) and the observability dashboard
// (UI + API + hourly cron) under `/observability*`. Both are layered over the
// `nemar-dashboard` Pages project, which keeps serving `/citations`.

import { Hono } from "hono";
import { handleScheduled } from "./cron";
import { loadCronStatus } from "./lib/store";
import { apiRoutes } from "./routes/api";
import { renderHubPage } from "./routes/hub";
import { renderDashboardPage } from "./routes/ui";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

// Liveness + cron staleness. `stale` is true when the last successful snapshot
// is older than ~2 hours (the hourly cron missed at least one run) so an
// external monitor can alert on it. Reading cron_status is best-effort: a bare
// liveness check still answers if OBS_DB is unavailable.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
app.get("/observability/health", async (c) => {
  try {
    const cron = await loadCronStatus(c.env.OBS_DB);
    const last = cron?.last_success_at ? Date.parse(cron.last_success_at) : Number.NaN;
    const stale = Number.isNaN(last) || Date.now() - last > STALE_AFTER_MS;
    return c.json({ ok: true, service: "nemar-observability", stale, cron }, 200, {
      "Cache-Control": "no-store",
    });
  } catch {
    return c.json({ ok: true, service: "nemar-observability" }, 200, {
      "Cache-Control": "no-store",
    });
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
