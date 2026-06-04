// JSON API for the observability dashboard, mounted at /observability/api.
//
//   GET  /snapshot              public  latest computed snapshot (headline only)
//   GET  /snapshot/history      public  trend points for one metric key
//   GET  /drilldown/:key        admin   list of items behind a tile
//   POST /sections/:key         token   push a pipeline section (push mode)

import { Hono } from "hono";
import { resolveAdmin } from "../lib/auth";
import { isKnownDrilldown, runDrilldown } from "../lib/drilldown";
import { buildSnapshot } from "../lib/metrics";
import { SectionIngestSchema } from "../lib/schema";
import {
  loadLatestSnapshot,
  loadMetricHistory,
  savePushedSection,
  saveSnapshot,
} from "../lib/store";
import type { Bindings } from "../types";

export const apiRoutes = new Hono<{ Bindings: Bindings }>();

const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

// Latest snapshot. If none has been computed yet (fresh deploy before the first
// cron), compute one on the fly and store it so the first visitor isn't empty.
apiRoutes.get("/snapshot", async (c) => {
  let snapshot = await loadLatestSnapshot(c.env.OBS_DB);
  if (!snapshot) {
    snapshot = await buildSnapshot(c.env);
    try {
      await saveSnapshot(c.env.OBS_DB, snapshot);
    } catch (err) {
      console.error("[api] saving first snapshot failed:", err);
    }
  }
  return c.json(snapshot, 200, { "Cache-Control": PUBLIC_CACHE });
});

// Trend history for one metric key (oldest -> newest), for sparklines.
apiRoutes.get("/snapshot/history", async (c) => {
  const key = c.req.query("metric");
  if (!key) return c.json({ error: "metric query param required" }, 400);
  const points = await loadMetricHistory(c.env.OBS_DB, key);
  return c.json({ metric: key, points }, 200, { "Cache-Control": PUBLIC_CACHE });
});

// Admin drill-down: the list behind a tile. Bearer admin only (delegated to
// nemar-cli /users/me). Never cached — it can contain private dataset ids.
apiRoutes.get("/drilldown/:key", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin) return c.json({ error: "Admin authentication required" }, 401);
  const key = c.req.param("key");
  if (!isKnownDrilldown(key)) return c.json({ error: "Unknown drill-down key" }, 404);
  const result = await runDrilldown(c.env.NEMAR_DB, key);
  if (!result) return c.json({ error: "Unknown drill-down key" }, 404);
  return c.json(result, 200, { "Cache-Control": "no-store" });
});

// Push a pipeline section (push mode). Bearer must equal OBS_INGEST_TOKEN.
// Body must be a schema-conformant Section whose `key` matches the path.
apiRoutes.post("/sections/:key", async (c) => {
  const expected = c.env.OBS_INGEST_TOKEN;
  if (!expected) return c.json({ error: "Section ingest is not configured" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim();
  if (!token || token !== expected) return c.json({ error: "Invalid ingest token" }, 401);

  const key = c.req.param("key");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const parsed = SectionIngestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Section does not match schema", issues: parsed.error.issues }, 422);
  }
  if (parsed.data.key !== key) {
    return c.json({ error: "Body key must match the URL key" }, 400);
  }
  const section = { ...parsed.data, updated_at: new Date().toISOString() };
  await savePushedSection(c.env.OBS_DB, section);
  return c.json({ ok: true, key, merged_on_next_snapshot: true });
});
