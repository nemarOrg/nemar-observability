// JSON API for the observability dashboard, mounted at /observability/api.
//
//   GET    /snapshot            public  latest snapshot (headline only)
//   GET    /snapshot/history    public  trend points for one metric key
//   GET    /timeseries          public  bounded daily series and metadata
//   GET    /audience            public  selected-range Umami and Cloudflare aggregates
//   GET    /embeds              public  selected-range embed loads of the signal viewer
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
import {
  type AudienceResponse,
  type AudienceSourceStatus,
  emptyUmamiEventReport,
  summarizeCountries,
  summarizeDailyCountryRows,
} from "../lib/audience";
import { resolveAdmin } from "../lib/auth";
import { fetchZoneCountryRange } from "../lib/cf-analytics";
import { isKnownDrilldown, runDrilldown } from "../lib/drilldown";
import {
  EMBED_SITES_DRILLDOWN,
  beforeCountingLists,
  loadEmbedLists,
  loadEmbedSitesAdmin,
  readEmbedLoads,
} from "../lib/embed-lists";
import type { EmbedsResponse } from "../lib/embeds";
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
import { fetchUmamiAudience } from "../lib/umami";
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

function unavailableCloudflare(
  status: AudienceSourceStatus,
  note: string,
): AudienceResponse["cloudflare"] {
  return {
    status,
    coverage: null,
    country_coverage: null,
    country_requests: null,
    requests: null,
    countries: [],
    suppressed_small_countries: false,
    note,
  };
}

async function loadCloudflareAudience(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
  includeCountryBreakdown: boolean,
): Promise<AudienceResponse["cloudflare"]> {
  if (!env.CF_ZONE_ANALYTICS_TOKEN?.trim()) {
    return unavailableCloudflare("unconfigured", "Network edge analytics are not configured.");
  }

  let result: Awaited<ReturnType<typeof fetchZoneCountryRange>>;
  try {
    result = await fetchZoneCountryRange(env, start, end, now, includeCountryBreakdown);
  } catch {
    console.error("[api] Cloudflare audience request failed");
    return unavailableCloudflare("unavailable", "Network edge data is currently unavailable.");
  }
  if (!result.coverage || result.requests === null) {
    return unavailableCloudflare(
      "unavailable",
      "No network edge data overlaps the selected range.",
    );
  }

  const countrySummary = result.country_coverage
    ? summarizeDailyCountryRows(result.country_days)
    : { countries: [], suppressedSmallCountries: false, omittedUnreportedCountries: false };
  const clipped = result.coverage.start > start || result.coverage.end < end;
  const currentUtcDay = now.toISOString().slice(0, 10);
  const includesCurrentUtcDay =
    result.coverage.start <= currentUtcDay && result.coverage.end >= currentUtcDay;
  const notes = ["Counts are requests at the network edge, not visitors or completed downloads."];
  if (result.country_coverage) {
    notes.push(
      "Country totals cover completed UTC days only; each day's small cells are suppressed before daily values are added.",
    );
    notes.push("Country values omit requests without a reported country.");
  }
  if (clipped) notes.unshift("Network edge data covers only part of the selected range.");
  if (includesCurrentUtcDay) {
    notes.push(
      "The current UTC day is still in progress, so its request totals may be incomplete.",
    );
  }
  if (countrySummary.suppressedSmallCountries) {
    notes.push(
      "Country values below 10 are withheld per day; daily withheld rows are combined only when their daily total reaches 10.",
    );
  }
  if (countrySummary.omittedUnreportedCountries) {
    notes.push("Some request rows have no reported country and are not assigned a location.");
  }

  return {
    status: clipped || includesCurrentUtcDay ? "partial" : "available",
    coverage: result.coverage,
    country_coverage: result.country_coverage,
    country_requests: result.country_requests,
    requests: result.requests,
    countries: countrySummary.countries,
    suppressed_small_countries: countrySummary.suppressedSmallCountries,
    note: notes.join(" "),
  };
}

// Selected-range audience aggregates. Umami sessions and Cloudflare edge
// requests remain separate sources with independent coverage and failures.
apiRoutes.get("/audience", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!validDate(start) || !validDate(end) || start > end) {
    return c.json({ error: "Valid start and end dates are required" }, 400);
  }
  const days =
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > 3660) return c.json({ error: "Date range cannot exceed 3660 days" }, 400);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const countryBreakdownScope =
    start !== end
      ? "multi_day"
      : start > today
        ? "future_day"
        : start === today
          ? "in_progress_day"
          : "single_completed_day";
  const includeUmamiCountryBreakdown = countryBreakdownScope === "single_completed_day";
  const includeCloudflareCountryBreakdown = start < today;
  const countryRangeNote =
    countryBreakdownScope === "single_completed_day"
      ? undefined
      : countryBreakdownScope === "in_progress_day"
        ? "Website sessions by country require one completed UTC day; select a date before today."
        : countryBreakdownScope === "future_day"
          ? "Website sessions by country are unavailable for future UTC days; select a completed UTC day."
          : "Website sessions by country are available only for one completed UTC day.";
  const umamiPromise = fetchUmamiAudience(c.env, start, end, includeUmamiCountryBreakdown).catch(
    () => {
      console.error("[api] Umami audience request failed");
      return {
        status: "unavailable" as const,
        coverage: null,
        country_coverage: null,
        visitors: null,
        visits: null,
        pageviews: null,
        event_metrics: emptyUmamiEventReport(
          "unavailable",
          "Website event data is currently unavailable.",
        ),
        countries: [],
        note: "Website analytics data is currently unavailable.",
      };
    },
  );
  const [umami, cloudflare] = await Promise.all([
    umamiPromise,
    loadCloudflareAudience(c.env, start, end, now, includeCloudflareCountryBreakdown),
  ]);
  const umamiCountries = includeUmamiCountryBreakdown
    ? summarizeCountries(umami.countries)
    : { countries: [], suppressedSmallCountries: false, omittedUnreportedCountries: false };
  const umamiNotes = [umami.note, countryRangeNote];
  if (umamiCountries.suppressedSmallCountries) {
    umamiNotes.push(
      "Country values below 10 are withheld; smaller rows are combined only when their total reaches 10.",
    );
  }
  if (umamiCountries.omittedUnreportedCountries) {
    umamiNotes.push("Some sessions have no reported country and are not assigned a location.");
  }

  const response: AudienceResponse = {
    start,
    end,
    observed_at: new Date().toISOString(),
    country_breakdown_scope: countryBreakdownScope,
    umami: {
      status: umami.status,
      coverage: umami.coverage,
      country_coverage: umami.country_coverage,
      visitors: umami.visitors,
      visits: umami.visits,
      pageviews: umami.pageviews,
      event_metrics: umami.event_metrics,
      countries: umamiCountries.countries,
      suppressed_small_countries: umamiCountries.suppressedSmallCountries,
      ...(umamiNotes.filter(Boolean).length ? { note: umamiNotes.filter(Boolean).join(" ") } : {}),
    },
    cloudflare,
  };
  return c.json(response, 200, { "Cache-Control": PUBLIC_CACHE });
});

// Selected-range embed loads of the signal viewer on other sites: daily totals
// by kind from this Worker's own store, and the top embedded datasets and counts
// of embedding sites from the edge's records. Shaped for a public page here:
// datasets are named only when public now, and embedding sites are never named,
// only counted (the hosts are for admins, through the drill-down below).
//
// Cached for at most a minute and never stale-while-revalidate: the answer can
// name a dataset, and "currently public" must not outlive a change by long. An
// answer with a block that could not be read is not cached at all.
const EMBEDS_CACHE = "public, max-age=30, s-maxage=60";
apiRoutes.get("/embeds", async (c) => {
  const start = c.req.query("start");
  const end = c.req.query("end");
  if (!validDate(start) || !validDate(end) || start > end) {
    return c.json({ error: "Valid start and end dates are required" }, 400);
  }
  const days =
    (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > 3660) return c.json({ error: "Date range cannot exceed 3660 days" }, 400);

  const now = new Date();
  // The loads card knows when counting began. For a range wholly before it the
  // lists say the same ("before counting began"), and the edge is not asked.
  const loads = await readEmbedLoads(c.env, start, end, now);
  const lists =
    loads.empty_reason === "before_counting"
      ? beforeCountingLists(loads.note ?? "")
      : await loadEmbedLists(c.env, start, end, now);
  const response: EmbedsResponse = {
    start,
    end,
    observed_at: now.toISOString(),
    loads,
    ...lists,
  };
  const unreadable = [loads.status, lists.sites.status, lists.datasets.status].includes(
    "unavailable",
  );
  return c.json(response, 200, { "Cache-Control": unreadable ? "no-store" : EMBEDS_CACHE });
});

// Admin drill-down: the list behind a tile. Bearer admin only (delegated to
// nemar-cli /users/me). Never cached — it can contain private dataset ids.
apiRoutes.get("/drilldown/:key", async (c) => {
  const noStore = { "Cache-Control": "no-store" };
  const admin = await resolveAdmin(c.env, c.req.header("Authorization") ?? null);
  if (!admin) return c.json({ error: "Admin authentication required" }, 401, noStore);
  const key = c.req.param("key");
  // The embedding site list is read from the edge, not nemar-db, and takes a
  // date range (default: the last 30 UTC days including today). It is the one
  // place embedding hostnames leave this Worker; the public page never has them.
  if (key === EMBED_SITES_DRILLDOWN) {
    const now = new Date();
    const end = c.req.query("end") ?? now.toISOString().slice(0, 10);
    const start =
      c.req.query("start") ??
      new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    if (!validDate(start) || !validDate(end) || start > end) {
      return c.json({ error: "Valid start and end dates are required" }, 400, noStore);
    }
    try {
      return c.json(await loadEmbedSitesAdmin(c.env, start, end, now), 200, noStore);
    } catch (err) {
      console.error("[api] embed sites drill-down failed:", err);
      return c.json({ error: "Embed sites are currently unavailable" }, 503, noStore);
    }
  }
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
