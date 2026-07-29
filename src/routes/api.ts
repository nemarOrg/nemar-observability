// JSON API for the observability dashboard, mounted at /observability/api.
//
//   GET    /snapshot            public  latest snapshot (headline only)
//   GET    /snapshot/history    public  trend points for one metric key
//   GET    /drilldown/:key      admin   list of items behind a tile (READ-ONLY)
//   POST   /sections/:key       token   push a pipeline section (push mode)
//
// This Worker has NO mutation surface. The admin action relays it used to carry
// (approve/delete a user, approve/deny a publication request) were removed in
// #8: every one of them is live in the website admin portal on app.nemar.org,
// which authenticates with an HttpOnly host-scoped session cookie instead of a
// long-lived `nm_...` API token pasted into a web page. The only remaining
// write is the token-gated pipeline section push.

import { Hono } from "hono";
import { resolveAdmin } from "../lib/auth";
import { isKnownDrilldown, runDrilldown } from "../lib/drilldown";
import { buildSnapshot } from "../lib/metrics";
import { BUILTIN_SECTION_KEYS, SectionIngestSchema } from "../lib/schema";
import {
  loadLatestSnapshot,
  loadMetricHistory,
  savePushedSection,
  saveSnapshot,
} from "../lib/store";
import type { Bindings } from "../types";

export const apiRoutes = new Hono<{ Bindings: Bindings }>();

const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

/** Constant-time string compare (avoids leaking the ingest token via timing). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Latest snapshot. If none has been computed yet (fresh deploy before the first
// cron), compute one on the fly and store it so the first visitor isn't empty.
apiRoutes.get("/snapshot", async (c) => {
  const snapshot = await loadLatestSnapshot(c.env.OBS_DB);
  if (snapshot) return c.json(snapshot, 200, { "Cache-Control": PUBLIC_CACHE });

  // No stored snapshot yet (fresh deploy before the first cron): compute one on
  // the fly and persist it. If the persist fails (OBS_DB broken/unmigrated),
  // serve the computed result but DON'T cache it -- caching a never-persisted
  // snapshot would hammer NEMAR_DB + AE on every request until the cron runs.
  const fresh = await buildSnapshot(c.env);
  try {
    await saveSnapshot(c.env.OBS_DB, fresh);
  } catch (err) {
    console.error("[api] OBS_DB write failed on first snapshot (is it migrated?):", err);
    return c.json(fresh, 200, { "Cache-Control": "no-store" });
  }
  return c.json(fresh, 200, { "Cache-Control": PUBLIC_CACHE });
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
  const noStore = { "Cache-Control": "no-store" };
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin) return c.json({ error: "Admin authentication required" }, 401, noStore);
  const key = c.req.param("key");
  if (!isKnownDrilldown(key)) return c.json({ error: "Unknown drill-down key" }, 404, noStore);
  const result = await runDrilldown(c.env.NEMAR_DB, key);
  if (!result) return c.json({ error: "Unknown drill-down key" }, 404, noStore);
  return c.json(result, 200, noStore);
});

// Push a pipeline section (push mode). Bearer must equal OBS_INGEST_TOKEN.
// Body must be a schema-conformant Section whose `key` matches the path.
apiRoutes.post("/sections/:key", async (c) => {
  const expected = c.env.OBS_INGEST_TOKEN;
  if (!expected) return c.json({ error: "Section ingest is not configured" }, 503);
  const auth = c.req.header("Authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim();
  if (!token || !safeEqual(token, expected)) return c.json({ error: "Invalid ingest token" }, 401);

  const key = c.req.param("key");
  // Reject a built-in key at ingest (409) instead of accepting it, storing it,
  // and silently dropping it at snapshot-assembly time (which would 200 a push
  // that never appears and pollute ingested_sections).
  if (BUILTIN_SECTION_KEYS.has(key)) {
    return c.json({ error: "Cannot shadow a built-in section key" }, 409);
  }
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
