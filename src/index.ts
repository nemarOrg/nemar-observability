// Worker entry: Hono app (UI + API) under /observability + the hourly cron.
// Mounted at dashboard.nemar.org/observability* via a Worker route (see
// wrangler.toml), layered over the legacy /citations Pages project.

import { Hono } from "hono";
import { handleScheduled } from "./cron";
import { apiRoutes } from "./routes/api";
import { renderDashboardPage } from "./routes/ui";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/observability/health", (c) => c.json({ ok: true, service: "nemar-observability" }));
app.route("/observability/api", apiRoutes);

app.get("/observability", (c) => c.html(renderDashboardPage()));
app.get("/observability/", (c) => c.html(renderDashboardPage()));

// Convenience for bare hits on the workers.dev host.
app.get("/", (c) => c.redirect("/observability"));

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Bindings>;
