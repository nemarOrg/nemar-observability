// Access metrics from the Cloudflare Analytics Engine dataset that nemar-cli's
// data-plane writes (one point per served archive download / zarr read). Read
// via the account-scoped AE SQL API (no binding; Bearer token).
//
// IMPORTANT: AE samples under load, so true counts use SUM(_sample_interval),
// never COUNT(*). Bytes are double1 (archive rows carry 0 — the Worker 302s to
// S3 and never streams the archive).

import type { Bindings } from "../types";
import { type Section, type Severity, metric } from "./schema";

interface AeRow {
  [col: string]: string | number | null;
}

/** Run one SQL statement against the AE SQL API; returns the data rows. */
async function queryAe(env: Bindings, sql: string): Promise<AeRow[]> {
  const token = env.CF_ANALYTICS_TOKEN;
  if (!token) return [];
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
    body: sql,
  });
  if (!res.ok) {
    console.error(`[access] AE SQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return [];
  }
  const json = (await res.json()) as { data?: AeRow[] };
  return json.data ?? [];
}

function num(v: string | number | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? (n as number) : 0;
}

const WINDOW = "30";

/**
 * Build the access section. Degrades to a single informational metric when the
 * AE token is unset (dev / not yet provisioned) so the dashboard still renders.
 */
export async function computeAccessSection(env: Bindings, now: string): Promise<Section> {
  if (!env.CF_ANALYTICS_TOKEN) {
    return {
      key: "access",
      label: "Access (30d)",
      source: "access",
      updated_at: now,
      metrics: [
        metric({
          key: "access.unconfigured",
          label: "Access metrics",
          value: 0,
          unit: "count",
          severity: "info",
          hint: "Analytics Engine token not configured yet (CF_ANALYTICS_TOKEN)",
        }),
      ],
    };
  }

  const ds = env.AE_DATASET;
  const [bySource, topDatasets] = await Promise.all([
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
       LIMIT 20`,
    ),
  ]);

  let archiveHits = 0;
  let zarrHits = 0;
  let totalBytes = 0;
  for (const r of bySource) {
    const hits = num(r.hits);
    totalBytes += num(r.bytes);
    if (r.source === "archive") archiveHits += hits;
    else if (r.source === "zarr") zarrHits += hits;
  }

  const topBreakdown = topDatasets
    .map((r) => ({ label: String(r.dataset_id ?? ""), value: num(r.hits) }))
    .filter((b) => b.label);

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
