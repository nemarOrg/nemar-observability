// Access metrics from the Cloudflare Analytics Engine dataset that nemar-cli's
// data-plane writes (one point per served archive download / zarr read). Read
// via the account-scoped AE SQL API (no binding; Bearer token).
//
// The AE point layout is a contract with nemar-cli's `buildAccessDataPoint`
// (backend/src/services/access-metrics.ts):
//   blob1 = dataset_id
//   blob2 = source   ("archive" | "zarr" | "file")
//   blob3 = detail   (archive -> version string; zarr -> "index"|"metadata"|"chunk")
//   double1 = bytes the Worker served (archive rows are always 0 -- the Worker
//             302s to a presigned S3 URL and never sees the body)
//
// IMPORTANT: AE samples under load, so true counts use SUM(_sample_interval),
// never COUNT(*). Archive rows are demonstrably sampled (raw 1,900 -> 3,417
// estimated over a recent 30d window), so this is not theoretical.
//
// WHAT THESE NUMBERS ARE NOT (issue #9). Every count here is a *server-side
// event count* with no bot filter and no per-client dedup, because nemar-cli
// does not record a client or bot dimension. One scraper can therefore own the
// window: on 2026-07-29 a single hour produced 2,511 archive events against two
// datasets, 71% of that entire 30-day total. The tiles are labelled and shaped
// to make that visible rather than to imply human demand:
//   - the headline is a spike-robust median day, with the raw total demoted
//   - a spike day raises severity to `warn` instead of passing silently
//   - "most accessed" ranks by chunk bytes, so enumerating index.json cannot
//     top the list
// Human-vs-bot and unique-client reporting needs nemar-cli instrumentation and
// is tracked there.

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

const WINDOW_DAYS = 30;
const WINDOW = String(WINDOW_DAYS);

/**
 * How far above the median a single day must sit to be called a spike. A real
 * traffic uptick moves the median too; a scraper shows up as one day that
 * dwarfs it. 5x is deliberately loose -- the 2026-07-29 archive spike was
 * ~100x the median, and we would rather miss a 3x day than cry wolf on a
 * conference-week bump.
 */
const SPIKE_FACTOR = 5;

/** Median of a numeric list (0 for empty). Not an average: the average is what
 *  the spike already ruined. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface DailySeries {
  /** ISO date -> event count, as returned by AE. */
  points: { date: string; value: number }[];
}

export interface SpikeReport {
  /** Typical day: the median over days that actually have data. */
  medianDaily: number;
  /** The worst day in the window, or null when there is no data at all. */
  peak: { date: string; value: number } | null;
  /** True when the peak day exceeds SPIKE_FACTOR x the median. */
  isSpike: boolean;
  /** Share of the window's total that landed on the peak day (0-1). */
  peakShare: number;
}

/**
 * Reduce a daily series to a typical rate plus a spike verdict. Exported for
 * tests: this is the whole defence against a single client defining the number,
 * so it is worth testing directly rather than only through a live AE query.
 *
 * Days with no rows are absent from the AE result rather than zero. They are
 * left out of the median on purpose: including implicit zeros for a service
 * with bursty, low-volume traffic drags the "typical day" toward 0 and makes
 * every active day look like a spike.
 */
export function summarizeDaily(series: DailySeries): SpikeReport {
  const values = series.points.map((p) => p.value);
  const total = values.reduce((a, b) => a + b, 0);
  const med = median(values);
  const peak = series.points.reduce<{ date: string; value: number } | null>(
    (best, p) => (best === null || p.value > best.value ? p : best),
    null,
  );
  return {
    medianDaily: med,
    peak,
    isSpike: peak !== null && med > 0 && peak.value > med * SPIKE_FACTOR,
    peakShare: total > 0 && peak !== null ? peak.value / total : 0,
  };
}

function singleMetricSection(
  now: string,
  key: string,
  label: string,
  severity: Severity,
  hint: string,
): Section {
  return {
    key: "access",
    label: `Access (${WINDOW_DAYS}d)`,
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

/** Build the spike-annotated hint for an event-count tile. */
function spikeHint(base: string, report: SpikeReport): string {
  if (!report.isSpike || report.peak === null) return base;
  const share = Math.round(report.peakShare * 100);
  return `${base} Distorted: ${report.peak.value.toLocaleString()} of these landed on ${report.peak.date} (${share}% of the window) — treat the total as one client, not demand.`;
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
  let byClass: AeRow[];
  let topDatasets: AeRow[];
  let archiveDaily: AeRow[];
  try {
    [byClass, topDatasets, archiveDaily] = await Promise.all([
      // Group by source AND detail: blob3 is what separates a viewer opening a
      // dataset (index) from bulk chunk streaming, and the old query collapsed
      // the two into one meaningless "zarr reads" number.
      queryAe(
        env,
        `SELECT blob2 AS source, blob3 AS detail,
                SUM(_sample_interval) AS hits, SUM(double1) AS bytes
         FROM ${ds}
         WHERE timestamp > NOW() - INTERVAL '${WINDOW}' DAY
         GROUP BY source, detail`,
      ),
      // Rank by chunk bytes, not hits. A crawler walking index.json across the
      // catalog produces enormous hit counts and reads no science data; bytes of
      // actual chunk traffic is the closest thing we have to "this dataset was
      // used". Archive rows carry 0 bytes so they are excluded by construction.
      queryAe(
        env,
        `SELECT blob1 AS dataset_id, SUM(double1) AS bytes, SUM(_sample_interval) AS hits
         FROM ${ds}
         WHERE timestamp > NOW() - INTERVAL '${WINDOW}' DAY
           AND blob2 = 'zarr' AND blob3 = 'chunk'
         GROUP BY dataset_id
         ORDER BY bytes DESC
         LIMIT 50`,
      ),
      queryAe(
        env,
        `SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS hits
         FROM ${ds}
         WHERE timestamp > NOW() - INTERVAL '${WINDOW}' DAY AND blob2 = 'archive'
         GROUP BY day
         ORDER BY day`,
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
  let zarrIndexHits = 0;
  let zarrIndexBytes = 0;
  let zarrChunkHits = 0;
  let zarrChunkBytes = 0;
  let zarrMetadataHits = 0;
  for (const r of byClass) {
    const hits = num(r.hits);
    const bytes = num(r.bytes);
    if (r.source === "archive") {
      archiveHits += hits;
      continue;
    }
    if (r.source !== "zarr") continue;
    if (r.detail === "index") {
      zarrIndexHits += hits;
      zarrIndexBytes += bytes;
    } else if (r.detail === "chunk") {
      zarrChunkHits += hits;
      zarrChunkBytes += bytes;
    } else if (r.detail === "metadata") {
      zarrMetadataHits += hits;
    }
  }

  const archiveSpike = summarizeDaily({
    points: archiveDaily.map((r) => ({ date: String(r.day ?? ""), value: num(r.hits) })),
  });

  const rawTop = topDatasets
    .map((r) => ({ label: String(r.dataset_id ?? ""), value: num(r.bytes) }))
    .filter((b) => b.label && b.value > 0);
  // Privacy: never surface a now-private dataset id in the public snapshot.
  const topBreakdown = (await filterPublic(env, rawTop)).slice(0, 20);

  return {
    key: "access",
    label: `Access (${WINDOW_DAYS}d)`,
    source: "access",
    updated_at: now,
    metrics: [
      // The headline is the typical day, not the sum. The sum is still reported
      // (as `total`) so nothing is hidden, but it is no longer the number a
      // reader anchors on.
      metric({
        key: "access.archive_daily",
        label: "Archive downloads / day",
        value: Math.round(archiveSpike.medianDaily),
        total: archiveHits,
        unit: "count",
        severity: archiveSpike.isSpike ? "warn" : "info",
        hint: spikeHint(
          `Median day over ${WINDOW_DAYS}d; the denominator is the window total. Counts redirects ISSUED on /<id>/<version>.zip, not completed downloads.`,
          archiveSpike,
        ),
      }),
      metric({
        key: "access.zarr_opens",
        label: "Dataset opens",
        value: zarrIndexHits,
        unit: "count",
        severity: "info",
        hint: "zarr.nemar.org index.json fetches — one per dataset a client starts browsing. Includes crawlers.",
      }),
      metric({
        key: "access.zarr_chunks",
        label: "Chunk reads",
        value: zarrChunkHits,
        unit: "count",
        severity: "info",
        hint: `Zarr data-chunk requests (plus ${zarrMetadataHits.toLocaleString()} store-metadata reads). Small files by design, so a single viewer session produces many.`,
      }),
      // The number that was missing entirely: how much science data NEMAR
      // actually served. Chunk bytes only -- folding index.json in here is what
      // made the old "bytes served" tile 95% catalog listings.
      metric({
        key: "access.science_bytes",
        label: "Science data served",
        value: zarrChunkBytes,
        unit: "bytes",
        severity: "info",
        hint: "Zarr chunk bytes only. Archive bytes are excluded: those stream direct from S3 on a presigned URL and never cross the Worker.",
      }),
      metric({
        key: "access.catalog_bytes",
        label: "Catalog egress",
        value: zarrIndexBytes,
        unit: "bytes",
        severity: "info",
        hint: "Bytes spent on index.json rather than data. Large relative to science data means the store index is being crawled.",
      }),
      metric({
        key: "access.top",
        label: "Most read datasets",
        value: topBreakdown.length,
        unit: "count",
        severity: "info",
        breakdown: topBreakdown,
        breakdown_unit: "bytes",
        hint: "Ranked by Zarr chunk bytes, so index.json crawling cannot reach the top.",
      }),
    ],
  };
}
