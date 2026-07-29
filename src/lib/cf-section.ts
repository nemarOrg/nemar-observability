// The `cf` section: what the Cloudflare edge actually served for nemar.org,
// as opposed to what nemar-cli's Workers chose to record (the `access` section).
//
// Read the header of cf-analytics.ts for why this is assembled from two
// different zone datasets with different window limits.

import type { Bindings } from "../types";
import { type HostClass, classifyHost, fetchZoneTotals } from "./cf-analytics";
import { type Section, type Severity, metric } from "./schema";
import { type HostRollup, loadHostRollup } from "./store";

const WINDOW_DAYS = 30;

function unavailable(now: string, key: string, severity: Severity, hint: string): Section {
  return {
    key: "cf",
    label: "Edge traffic (30d)",
    source: "cloudflare",
    updated_at: now,
    metrics: [metric({ key, label: "Edge traffic", value: 0, unit: "count", severity, hint })],
  };
}

const CLASS_LABEL: Record<HostClass, string> = {
  web: "Web",
  data: "Data plane",
  api: "API",
  origin: "S3 origin",
  other: "Other",
};

/** Group host rollups by surface class, summing the given field. */
function byClass(hosts: HostRollup[], field: "visits" | "requests" | "bytes") {
  const totals = new Map<HostClass, number>();
  for (const h of hosts) {
    const cls = classifyHost(h.host);
    totals.set(cls, (totals.get(cls) ?? 0) + h[field]);
  }
  return [...totals.entries()]
    .map(([cls, value]) => ({ label: CLASS_LABEL[cls], value }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);
}

export async function computeCfSection(env: Bindings, now: string): Promise<Section> {
  if (!env.CF_ZONE_ANALYTICS_TOKEN) {
    return unavailable(
      now,
      "cf.unconfigured",
      "info",
      "Zone analytics token not configured (CF_ZONE_ANALYTICS_TOKEN; needs Zone > Analytics > Read on nemar.org)",
    );
  }
  if (!env.CF_ZONE_ID) {
    return unavailable(now, "cf.unconfigured", "warn", "CF_ZONE_ID var not configured");
  }

  const nowDate = new Date(now);
  const sinceDate = new Date(nowDate.getTime() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let totals: Awaited<ReturnType<typeof fetchZoneTotals>>;
  let rollup: Awaited<ReturnType<typeof loadHostRollup>>;
  try {
    [totals, rollup] = await Promise.all([
      fetchZoneTotals(env, nowDate),
      loadHostRollup(env.OBS_DB, sinceDate),
    ]);
  } catch (err) {
    console.error("[cf] zone analytics failed:", err);
    return unavailable(
      now,
      "cf.unavailable",
      "warn",
      `Cloudflare zone analytics failed: ${String(err).slice(0, 160)}`,
    );
  }

  const cacheRatio = totals.bytes > 0 ? (totals.cachedBytes / totals.bytes) * 100 : 0;
  // The per-host rollup backfills one day per cron run, so say how much of the
  // window it actually covers rather than labelling a partial view "30d".
  const coverage =
    rollup.days >= WINDOW_DAYS ? `${WINDOW_DAYS}d` : `${rollup.days}d so far (backfilling)`;
  const hostNote = rollup.days === 0 ? " No per-host data accumulated yet." : "";

  return {
    key: "cf",
    label: "Edge traffic (30d)",
    source: "cloudflare",
    updated_at: now,
    metrics: [
      metric({
        key: "cf.bytes",
        label: "Data transferred",
        value: totals.bytes,
        unit: "bytes",
        severity: "info",
        hint: `Everything Cloudflare served for the nemar.org zone over ${totals.days} days, S3 origin traffic included.`,
      }),
      metric({
        key: "cf.requests",
        label: "Requests",
        value: totals.requests,
        unit: "count",
        severity: "info",
        hint: "Zone-wide edge requests.",
      }),
      metric({
        key: "cf.cache_ratio",
        label: "Served from cache",
        value: Math.round(cacheRatio * 10) / 10,
        unit: "percent",
        severity: "info",
        hint: "Share of bytes served from the edge cache rather than fetched from origin.",
      }),
      // Deliberately the PEAK day, not a sum. Unique visitors cannot be added
      // across days -- the same person on two days is one person. Summing the
      // 30 daily figures for this zone gives 791,473, which would be wrong by
      // roughly an order of magnitude and is exactly the number that made the
      // old visitor figure look implausible.
      metric({
        key: "cf.peak_daily_uniques",
        label: "Busiest day (unique IPs)",
        value: totals.peakDailyUniques,
        unit: "count",
        severity: "info",
        hint: "Highest single-day unique-IP count. Daily uniques cannot be summed into a window total, and this counts IPs (bots included), not people.",
      }),
      metric({
        key: "cf.visits_by_surface",
        label: `Visits by surface (${coverage})`,
        value: rollup.hosts.reduce((n, h) => n + h.visits, 0),
        unit: "count",
        severity: "info",
        breakdown: byClass(rollup.hosts, "visits"),
        hint: `Cloudflare "visits" (session starts) per NEMAR surface. Only meaningful on hosts a person browses: the API and S3 origin register ~0 by nature. Excludes rate-limit.internal.${hostNote}`,
      }),
      metric({
        key: "cf.bytes_by_host",
        label: `Bytes by host (${coverage})`,
        value: rollup.hosts.length,
        unit: "count",
        severity: "info",
        breakdown: rollup.hosts
          .map((h) => ({ label: h.host, value: h.bytes }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 10),
        breakdown_unit: "bytes",
        hint: `Which hosts the egress actually goes to.${hostNote}`,
      }),
      metric({
        key: "cf.by_country",
        label: "Requests by country",
        value: totals.byCountry.length,
        unit: "count",
        severity: "info",
        breakdown: totals.byCountry.slice(0, 10),
        hint: "Zone-wide, so it includes crawler and origin traffic as well as readers.",
      }),
    ],
  };
}
