// JSON API for the observability dashboard, mounted at /observability/api.
//
//   GET    /snapshot            public  latest snapshot (headline only)
//   GET    /snapshot/history    public  trend points for one metric key
//   GET    /timeseries          public  bounded daily series and metadata
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
  commitPushedSectionIngest,
  dailySeriesMetadataConflict,
  loadDailySeries,
  loadLatestSnapshot,
  loadMetricHistory,
  saveSnapshot,
  stageDailySeries,
  stagePushedSection,
} from "../lib/store";
import type { Bindings } from "../types";

export const apiRoutes = new Hono<{ Bindings: Bindings }>();

const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
const MAX_SECTION_BODY_BYTES = 1_000_000;

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; tooLarge: boolean };

/** Read one bounded JSON request body without allowing unbounded buffering. */
async function readBoundedJsonBody(request: Request): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("Content-Length");
  const declaredLength = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SECTION_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SECTION_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The oversized body is rejected either way.
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)),
    };
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }
}

/** Compare fixed-size SHA-256 digests without a content- or length-based exit. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const provided = new Uint8Array(providedHash);
  const expected = new Uint8Array(expectedHash);
  let diff = 0;
  for (let index = 0; index < provided.length; index++) {
    diff |= provided[index] ^ expected[index];
  }
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

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

apiRoutes.get("/timeseries", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!validDate(start) || !validDate(end) || start > end) {
    return c.json({ error: "Valid start and end dates are required" }, 400);
  }
  const days =
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > 3660) return c.json({ error: "Date range cannot exceed 3660 days" }, 400);
  const series = await loadDailySeries(c.env.OBS_DB, start, end);
  return c.json({ start, end, series }, 200, { "Cache-Control": PUBLIC_CACHE });
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

// Push a pipeline section (push mode). Bearer is scoped to the URL section key.
// Body must be a schema-conformant Section whose `key` matches the path.
apiRoutes.post("/sections/:key", async (c) => {
  let tokenMap: unknown;
  try {
    tokenMap = JSON.parse(c.env.OBS_INGEST_TOKENS_JSON ?? "");
  } catch {
    return c.json({ error: "Section ingest is not configured" }, 503);
  }
  if (!tokenMap || typeof tokenMap !== "object" || Array.isArray(tokenMap)) {
    return c.json({ error: "Section ingest is not configured" }, 503);
  }
  const configuredTokens = Object.values(tokenMap);
  if (configuredTokens.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    return c.json({ error: "Section ingest is not configured" }, 503);
  }
  const normalizedTokens = (configuredTokens as string[]).map((value) => value.trim());
  if (new Set(normalizedTokens).size !== normalizedTokens.length) {
    return c.json({ error: "Section ingest tokens must be distinct per section" }, 503);
  }
  const auth = c.req.header("Authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim();
  const key = c.req.param("key");
  const configured = Object.prototype.hasOwnProperty.call(tokenMap, key)
    ? (tokenMap as Record<string, unknown>)[key]
    : undefined;
  const expected = typeof configured === "string" ? configured.trim() : undefined;
  if (typeof expected !== "string" || !token || !(await safeEqual(token, expected))) {
    return c.json({ error: "Invalid ingest token" }, 401);
  }
  // Reject a built-in key at ingest (409) instead of accepting it, storing it,
  // and silently dropping it at snapshot-assembly time (which would 200 a push
  // that never appears and pollute ingested_sections).
  if (BUILTIN_SECTION_KEYS.has(key)) {
    return c.json({ error: "Cannot shadow a built-in section key" }, 409);
  }
  const body = await readBoundedJsonBody(c.req.raw);
  if (!body.ok)
    return c.json(
      { error: body.tooLarge ? "Section payload exceeds 1 MB" : "Invalid JSON" },
      body.tooLarge ? 413 : 400,
    );
  const parsed = SectionIngestSchema.safeParse(body.value);
  if (!parsed.success) {
    return c.json({ error: "Section does not match schema", issues: parsed.error.issues }, 422);
  }
  if (parsed.data.key !== key) {
    return c.json({ error: "Body key must match the URL key" }, 400);
  }
  const { daily_series: series, ...sectionInput } = parsed.data;
  const section = { ...sectionInput, updated_at: new Date().toISOString() };
  const metadataConflict = series
    ? await dailySeriesMetadataConflict(c.env.OBS_DB, key, section.source, series)
    : null;
  if (metadataConflict) {
    return c.json(
      {
        error:
          "Daily series metadata is immutable; publish changed semantics under a new series key",
        series_key: metadataConflict,
      },
      409,
    );
  }

  const ingestId = crypto.randomUUID();
  await stagePushedSection(c.env.OBS_DB, ingestId, section);
  if (series) await stageDailySeries(c.env.OBS_DB, ingestId, series);
  try {
    await commitPushedSectionIngest(c.env.OBS_DB, ingestId, key);
  } catch (error) {
    if (error instanceof Error && error.message.includes("daily_series_semantics_immutable")) {
      return c.json(
        {
          error: "Daily series metadata changed concurrently; retry with a new series key",
        },
        409,
      );
    }
    throw error;
  }
  return c.json({ ok: true, key, merged_on_next_snapshot: true });
});
