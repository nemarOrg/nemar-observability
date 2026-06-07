// JSON API for the observability dashboard, mounted at /observability/api.
//
//   GET    /snapshot                       public  latest snapshot (headline only)
//   GET    /snapshot/history               public  trend points for one metric key
//   GET    /drilldown/:key                 admin   list of items behind a tile
//   GET    /me                             admin   {username, role} for owner-gating
//   POST   /actions/users/:username/approve admin  relay -> approve a user
//   DELETE /actions/users/:id              owner   relay -> delete (tombstone) a user
//   POST   /actions/publish/:id/deny       admin   relay -> deny a publication request
//   POST   /actions/publish/:id/approve    admin   relay -> approve+publish (loop in client)
//   POST   /sections/:key                  token   push a pipeline section (push mode)

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

// ---------------------------------------------------------------------------
// Admin action relays. Each re-checks admin via resolveAdmin (delegated to
// nemar-cli /users/me) and then forwards the SAME admin Bearer to the matching
// nemar-cli admin endpoint, returning its JSON + status verbatim. Never cached.
// The dashboard never holds nemar-cli admin powers of its own: every mutation
// is the admin's own key acting through nemar-cli's existing authz.
// ---------------------------------------------------------------------------

/** Extract the raw Bearer token (already validated as admin by resolveAdmin). */
function bearer(c: { req: { header: (n: string) => string | undefined } }): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((c.req.header("Authorization") ?? "").trim());
  return m ? m[1].trim() : null;
}

/**
 * Relay to a nemar-cli admin endpoint with the caller's admin Bearer. Forwards
 * the method + JSON body (if any) and returns the upstream body + status
 * verbatim with a forced JSON content-type and no-store. Returns 502 if the
 * upstream is unreachable. NEVER logs the Bearer.
 */
async function relayToNemar(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  // Defensive: NEMAR_API_BASE is a deploy-time [vars] constant, but never relay
  // an admin Bearer to a non-HTTPS target if it is ever misconfigured.
  if (!base.startsWith("https://")) {
    console.error("[actions] NEMAR_API_BASE is not https; refusing to relay");
    return new Response(JSON.stringify({ error: "Upstream NEMAR API misconfigured" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`, init);
  } catch (err) {
    console.error("[actions] upstream unreachable:", path, err);
    return new Response(JSON.stringify({ error: "Upstream NEMAR API unreachable" }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// GET /me -> {username, role} for the client's owner-gating. resolveAdmin
// already returns that shape (delegated to nemar-cli /users/me), so no extra
// upstream call is needed.
apiRoutes.get("/me", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  return c.json({ username: admin.username, role: admin.role }, 200, {
    "Cache-Control": "no-store",
  });
});

// POST /actions/users/:username/approve -> nemar-cli POST /admin/approve/:username
apiRoutes.post("/actions/users/:username/approve", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  const token = bearer(c);
  if (!token)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  const username = c.req.param("username");
  return relayToNemar(
    c.env.NEMAR_API_BASE,
    token,
    "POST",
    `/admin/approve/${encodeURIComponent(username)}`,
  );
});

// DELETE /actions/users/:id -> nemar-cli DELETE /admin/users/by-id/:id (owner-only).
// Owner-gate is enforced HERE (defense-in-depth) and again upstream by
// ownerMiddleware. A non-owner admin is rejected before any upstream call.
apiRoutes.delete("/actions/users/:id", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  if (admin.role !== "owner") {
    return c.json({ error: "Owner role required to delete users" }, 403, {
      "Cache-Control": "no-store",
    });
  }
  const token = bearer(c);
  if (!token)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  const id = c.req.param("id");
  return relayToNemar(
    c.env.NEMAR_API_BASE,
    token,
    "DELETE",
    `/admin/users/by-id/${encodeURIComponent(id)}`,
  );
});

// POST /actions/publish/:id/deny -> nemar-cli POST /admin/publish/:id/deny  {reason}
apiRoutes.post("/actions/publish/:id/deny", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  const token = bearer(c);
  if (!token)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400, { "Cache-Control": "no-store" });
  }
  const id = c.req.param("id");
  return relayToNemar(
    c.env.NEMAR_API_BASE,
    token,
    "POST",
    `/admin/publish/${encodeURIComponent(id)}/deny`,
    body,
  );
});

// POST /actions/publish/:id/approve -> nemar-cli POST /admin/publish/:id/approve
// Schema-agnostic pass-through: the browser drives the multi-step continuation
// loop and this route never knows the step list or s3-lock contract. Body +
// upstream response are both forwarded verbatim.
apiRoutes.post("/actions/publish/:id/approve", async (c) => {
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  const token = bearer(c);
  if (!token)
    return c.json({ error: "Admin authentication required" }, 401, { "Cache-Control": "no-store" });
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400, { "Cache-Control": "no-store" });
  }
  const id = c.req.param("id");
  return relayToNemar(
    c.env.NEMAR_API_BASE,
    token,
    "POST",
    `/admin/publish/${encodeURIComponent(id)}/approve`,
    body,
  );
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
