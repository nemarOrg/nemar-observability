// Cloudflare zone analytics for nemar.org, via the GraphQL Analytics API.
// This is edge-side truth (what Cloudflare actually served) as opposed to the
// Analytics Engine section, which is what nemar-cli's Workers chose to record.
//
// Two datasets, because neither alone answers the question:
//
//   httpRequests1dGroups        daily rollup. Accepts a 30-day window in one
//                               call and carries bytes/requests/cached/country.
//                               NO host dimension.
//   httpRequestsAdaptiveGroups  has clientRequestHTTPHost, but rejects any
//                               window wider than 1 day:
//                                 "cannot request a time range wider than 1d"
//
// So the 30-day headline comes from 1dGroups directly, and the per-host split
// is accumulated one day at a time by the cron into OBS_DB (cf_daily_host) and
// aggregated from there. The headline is therefore correct from the first run;
// the per-host view fills in over the following 30 days and reports its own
// coverage rather than pretending to a full window it does not have.

import type { Bindings } from "../types";
import { type Section, metric } from "./schema";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const WINDOW_DAYS = 30;

/**
 * Cloudflare's own internal host. It appears in zone analytics with six-figure
 * request counts and effectively zero bytes, and it is not a NEMAR surface.
 * Leaving it in is most of why the zone-wide visitor count reads as
 * implausibly high (~20k/day).
 */
const EXCLUDED_HOSTS = new Set(["rate-limit.internal"]);

/** Which NEMAR surface a host belongs to. Drives the visits breakdown: `visits`
 *  is only a meaningful human proxy on the hosts a person actually browses. */
export type HostClass = "web" | "data" | "api" | "origin" | "other";

export function classifyHost(host: string): HostClass {
  if (host.endsWith(".amazonaws.com")) return "origin";
  if (host === "api.nemar.org") return "api";
  if (host === "data.nemar.org" || host === "zarr.nemar.org") return "data";
  if (
    host === "nemar.org" ||
    host === "ww2.nemar.org" ||
    host === "app.nemar.org" ||
    host === "dashboard.nemar.org" ||
    host === "docs.nemar.org"
  ) {
    return "web";
  }
  return "other";
}

interface GraphQLResponse<T> {
  data: T | null;
  errors?: { message: string }[];
}

async function queryGraphQL<T>(
  env: Bindings,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_ZONE_ANALYTICS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`CF GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  // GraphQL reports authz and quota faults as a 200 with an `errors` array, so
  // a bare `res.ok` check would silently treat a permission failure as no data.
  if (json.errors?.length) {
    throw new Error(
      `CF GraphQL: ${json.errors
        .map((e) => e.message)
        .join("; ")
        .slice(0, 200)}`,
    );
  }
  if (!json.data) throw new Error("CF GraphQL returned no data");
  return json.data;
}

/**
 * Unwrap `viewer.zones[0]`, treating an empty zone list as a fault.
 *
 * Cloudflare answers an unknown or inaccessible zone tag with an `errors` array
 * (verified: a bogus tag returns `data: null` + `Zone not found`), which
 * queryGraphQL already throws on. But the zone list is a filter result, so an
 * empty array is structurally possible, and `zones[0]?.x ?? []` would turn it
 * into "the zone served nothing" — a plausible-looking zero rather than a
 * failure. Anything that cannot distinguish "no traffic" from "no answer" has
 * no business being on a monitoring dashboard.
 */
function firstZone<T>(zones: T[]): T {
  const zone = zones[0];
  if (zone === undefined) {
    throw new Error("CF GraphQL returned no zone (check CF_ZONE_ID and the token's zone scope)");
  }
  return zone;
}

// ---------------------------------------------------------------------------
// 30-day zone totals (httpRequests1dGroups)
// ---------------------------------------------------------------------------

interface ZoneDay {
  dimensions: { date: string };
  sum: {
    bytes: number;
    cachedBytes: number;
    requests: number;
    countryMap: { clientCountryName: string; requests: number; bytes: number }[];
  };
  uniq: { uniques: number };
}

// `limit` must be an Int literal or a declared variable; interpolating the
// constant keeps it in one place. +2 covers the inclusive-today boundary.
const ZONE_TOTALS_QUERY = `query($zone:String!,$since:Date!,$until:Date!){
  viewer{zones(filter:{zoneTag:$zone}){
    httpRequests1dGroups(limit:${WINDOW_DAYS + 2},filter:{date_geq:$since,date_lt:$until},orderBy:[date_ASC]){
      dimensions{date}
      sum{bytes cachedBytes requests countryMap{clientCountryName requests bytes}}
      uniq{uniques}
    }
  }}
}`;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ZoneTotals {
  days: number;
  bytes: number;
  cachedBytes: number;
  requests: number;
  /** Highest single-day unique count in the window. Daily uniques CANNOT be
   *  summed into a window total — the same visitor on two days is one visitor,
   *  and adding them produced a nonsense 791,473 for a 30-day window. */
  peakDailyUniques: number;
  byCountry: { label: string; value: number }[];
}

export async function fetchZoneTotals(env: Bindings, now: Date): Promise<ZoneTotals> {
  const until = new Date(now.getTime() + 86_400_000); // exclusive; include today
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const data = await queryGraphQL<{
    viewer: { zones: { httpRequests1dGroups: ZoneDay[] }[] };
  }>(env, ZONE_TOTALS_QUERY, {
    zone: env.CF_ZONE_ID,
    since: isoDate(since),
    until: isoDate(until),
  });

  const rows = firstZone(data.viewer.zones).httpRequests1dGroups;
  const byCountry = new Map<string, number>();
  let bytes = 0;
  let cachedBytes = 0;
  let requests = 0;
  let peakDailyUniques = 0;
  for (const r of rows) {
    bytes += r.sum.bytes;
    cachedBytes += r.sum.cachedBytes;
    requests += r.sum.requests;
    peakDailyUniques = Math.max(peakDailyUniques, r.uniq.uniques);
    for (const c of r.sum.countryMap) {
      byCountry.set(c.clientCountryName, (byCountry.get(c.clientCountryName) ?? 0) + c.requests);
    }
  }
  return {
    days: rows.length,
    bytes,
    cachedBytes,
    requests,
    peakDailyUniques,
    byCountry: [...byCountry.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
  };
}

// ---------------------------------------------------------------------------
// Per-host, one day at a time (httpRequestsAdaptiveGroups)
// ---------------------------------------------------------------------------

export interface HostDay {
  date: string;
  host: string;
  requests: number;
  visits: number;
  bytes: number;
}

const HOST_DAY_QUERY = `query($zone:String!,$since:Time!,$until:Time!){
  viewer{zones(filter:{zoneTag:$zone}){
    httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$since,datetime_lt:$until},orderBy:[count_DESC]){
      dimensions{clientRequestHTTPHost}
      count
      sum{edgeResponseBytes visits}
    }
  }}
}`;

/**
 * Per-host traffic for one UTC day. `date` must be an ISO date; the window is
 * that whole day, which is exactly the maximum this dataset accepts.
 */
export async function fetchHostDay(env: Bindings, date: string): Promise<HostDay[]> {
  const start = `${date}T00:00:00Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = await queryGraphQL<{
    viewer: {
      zones: {
        httpRequestsAdaptiveGroups: {
          dimensions: { clientRequestHTTPHost: string };
          count: number;
          sum: { edgeResponseBytes: number; visits: number };
        }[];
      }[];
    };
  }>(env, HOST_DAY_QUERY, { zone: env.CF_ZONE_ID, since: start, until: end });

  const rows = firstZone(data.viewer.zones).httpRequestsAdaptiveGroups;
  return rows
    .filter((r) => !EXCLUDED_HOSTS.has(r.dimensions.clientRequestHTTPHost))
    .map((r) => ({
      date,
      host: r.dimensions.clientRequestHTTPHost,
      requests: r.count,
      visits: r.sum.visits,
      bytes: r.sum.edgeResponseBytes,
    }));
}
