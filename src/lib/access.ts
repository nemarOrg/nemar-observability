// Access metrics from the Cloudflare Analytics Engine dataset that nemar-cli's
// data-plane writes (one point per served archive download / zarr read). Read
// via the account-scoped AE SQL API (no binding; Bearer token).
//
// IMPORTANT: AE samples under load, so true counts use SUM(_sample_interval),
// never COUNT(*). Bytes are double1 (archive rows carry 0 — the Worker 302s to
// S3 and never streams the archive).

import type { Bindings } from "../types";
import { type Section, type Severity, metric } from "./schema";
import { PUBLIC_MANAGED } from "./sql";

interface AeRow {
  [col: string]: string | number | null;
}

/** Run one SQL statement against the AE SQL API. Throws on a non-ok response so
 *  the caller can distinguish "query failed" from "genuinely zero activity". */
async function queryAe(env: Bindings, sql: string): Promise<AeRow[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!res.ok) {
    throw new Error(`AE SQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: AeRow[] };
  return json.data ?? [];
}

function num(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? (n as number) : 0;
}

const WINDOW = "30";

function singleMetricSection(
  now: string,
  key: string,
  label: string,
  severity: Severity,
  hint: string,
): Section {
  return {
    key: "access",
    label: "Access (30d)",
    source: "access",
    updated_at: now,
    metrics: [metric({ key, label, value: 0, unit: "count", severity, hint })],
  };
}

/**
 * Keep only the dataset ids that are CURRENTLY public+managed. Access points
 * can outlive a dataset's public window (30d), so without this a dataset that
 * was made private would leak in the public snapshot's "most accessed" list.
 */
async function filterPublic(
  env: Bindings,
  items: { label: string; value: number }[],
): Promise<{ label: string; value: number }[]> {
  if (items.length === 0) return items;
  const placeholders = items.map(() => "?").join(",");
  const rows = await env.NEMAR_DB.prepare(
    `SELECT dataset_id FROM datasets WHERE dataset_id IN (${placeholders}) AND ${PUBLIC_MANAGED}`,
  )
    .bind(...items.map((b) => b.label))
    .all<{ dataset_id: string }>();
  const publicIds = new Set((rows.results ?? []).map((r) => r.dataset_id));
  return items.filter((b) => publicIds.has(b.label));
}

/**
 * Build the access section. Degrades to a single informational/warning metric
 * when the AE token is unset (dev / not provisioned) or the AE query fails, so
 * the dashboard still renders and an operator can tell "unavailable" from "zero".
 */
export async function computeAccessSection(env: Bindings, now: string): Promise<Section> {
  if (!env.CF_ANALYTICS_TOKEN) {
    return singleMetricSection(
      now,
      "access.unconfigured",
      "Access metrics",
      "info",
      "Analytics Engine token not configured yet (CF_ANALYTICS_TOKEN)",
    );
  }
  if (!env.AE_DATASET) {
    return singleMetricSection(
      now,
      "access.unconfigured",
      "Access metrics",
      "warn",
      "AE_DATASET binding not configured",
    );
  }

  const ds = env.AE_DATASET;
  let bySource: AeRow[];
  let topDatasets: AeRow[];
  try {
    [bySource, topDatasets] = await Promise.all([
      queryAe(
        env,
        `SELECT blob2 AS source, SUM(_sample_interval) AS hits, SUM(double1) AS bytes
         FROM ${ds}
         WHERE timestamp > NOW() - INTERVAL '${WINDOW}' DAY
         GROUP BY source`,
      ),
      queryAe(
        env,
        `SELECT blob1 AS dataset_id, SUM(_sample_interval) AS hits
         FROM ${ds}
         WHERE timestamp > NOW() - INTERVAL '${WINDOW}' DAY
         GROUP BY dataset_id
         ORDER BY hits DESC
         LIMIT 50`,
      ),
    ]);
  } catch (err) {
    console.error("[access] AE query failed:", err);
    return singleMetricSection(
      now,
      "access.unavailable",
      "Access metrics unavailable",
      "warn",
      `Analytics Engine query failed: ${String(err).slice(0, 160)}`,
    );
  }

  let archiveHits = 0;
  let zarrHits = 0;
  let totalBytes = 0;
  for (const r of bySource) {
    const hits = num(r.hits);
    totalBytes += num(r.bytes);
    if (r.source === "archive") archiveHits += hits;
    else if (r.source === "zarr") zarrHits += hits;
  }

  const rawTop = topDatasets
    .map((r) => ({ label: String(r.dataset_id ?? ""), value: num(r.hits) }))
    .filter((b) => b.label);
  // Privacy: never surface a now-private dataset id in the public snapshot.
  const topBreakdown = (await filterPublic(env, rawTop)).slice(0, 20);

  const sev: Severity = "info";
  return {
    key: "access",
    label: "Access (30d)",
    source: "access",
    updated_at: now,
    metrics: [
      metric({
        key: "access.downloads",
        label: "Archive downloads",
        value: archiveHits,
        unit: "count",
        severity: sev,
        hint: "data.nemar.org zip downloads, last 30 days",
      }),
      metric({
        key: "access.zarr_reads",
        label: "Zarr reads",
        value: zarrHits,
        unit: "count",
        severity: sev,
        hint: "zarr.nemar.org object reads, last 30 days",
      }),
      metric({
        key: "access.bytes",
        label: "Bytes served (zarr)",
        value: totalBytes,
        unit: "bytes",
        severity: sev,
        hint: "Worker-served bytes; archive bytes flow direct from S3",
      }),
      metric({
        key: "access.top",
        label: "Most accessed",
        value: topBreakdown.length,
        unit: "count",
        severity: sev,
        breakdown: topBreakdown,
        hint: "Top public datasets by request count (30d)",
      }),
    ],
  };
}
