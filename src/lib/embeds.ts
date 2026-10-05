// Embed loads of the signal viewer on other sites (the "third-party" half of
// the Signal viewer entry, nemar-observability#97, plan nemarOrg/website#410).
//
// WHERE THE DATA COMES FROM. The website's edge middleware writes one Analytics
// Engine point for every GET of /dataset/<id>/embed it answers with a 200
// (website ADR 0024). The layout is a contract with that ADR:
//   index1, blob1 = dataset id
//   blob2         = the embedding site's hostname from Referer, or "" when unknown
//   blob3         = kind: "iframe" (a real embed), "document" (the URL opened
//                   directly), "none" (no Sec-Fetch-Dest: scripts, crawlers),
//                   "other" (any other value)
//   double1       = 1
// Production writes nemar_website_embeds; staging and website previews write
// nemar_website_embeds_dev. The Worker reads the one named by EMBED_AE_DATASET.
//
// Aggregate with SUM(_sample_interval), never COUNT(*) (AGENTS.md, AE sampling).
//
// WHAT THE PAGE SHOWS, AND WHAT IT MUST NOT. The dashboard page is public with
// no auth, so everything here is shaped for that:
//   - Totals by kind per UTC day are kept in this Worker's own D1 (see
//     embed-store.ts), because Analytics Engine keeps only about three months.
//   - Per-site and per-dataset detail is NOT kept: it is read from Analytics
//     Engine for the part of the selected dates it still holds, so hostnames and
//     dataset ids never outlive the edge's own retention.
//   - Only "iframe" loads are ranked by site and by dataset. A site that embeds
//     the viewer is the site in the Referer of an iframe load; the Referer of a
//     direct open is merely where a person came from.
//   - Datasets are named only when they are public now (PUBLIC_MANAGED in
//     nemar-db), because an embed of an unpublished or private dataset still
//     records its id. Everything else is folded into an unnamed count.
//   - Embedding sites are NEVER named on the public page, whatever their count.
//     Referer and Sec-Fetch-Dest are set by the client, so a handful of curl
//     requests can put any hostname, including an offensive or defamatory one,
//     on a public page; and a floor on the count only invites probing it. A
//     hostname can also identify a person (a personal site is named after its
//     owner). The public answer is counts: localhost, addresses, private names
//     and empty hosts as "unknown or local", the loads from every other host,
//     and how many distinct such hosts there were. Signed-in admins get the host
//     list through the admin drill-down (loadEmbedSitesAdmin), never the page.

import type { Bindings } from "../types";
import { type AeRow, num as aeNum, queryAe } from "./access";
import { isSettled } from "./request-series";
import { publicDatasetIds } from "./sql";

// ---------- vocabulary ----------

/** The request kinds the website records (website ADR 0024), in display order. */
export const EMBED_KINDS = ["iframe", "document", "none", "other"] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

/** How the dashboard groups the four recorded kinds. `embedded` is the headline. */
export type EmbedGroup = "embedded" | "direct" | "other";
export const EMBED_GROUP_OF: Record<EmbedKind, EmbedGroup> = {
  iframe: "embedded",
  document: "direct",
  none: "other",
  other: "other",
};

/** Analytics Engine keeps about three months; plan inside it with a margin so
 *  the oldest planned day is never one the edge has already dropped. */
export const EMBED_RETENTION_DAYS = 85;

/** Public dataset names in the ranking; the rest is folded into an unnamed count. */
export const EMBED_DATASET_LIMIT = 10;

/** Cap on the rows read for one Analytics Engine ranking. When it is reached the
 *  total is queried separately, so the remainder stays right. */
export const AE_ROW_LIMIT = 5000;

/** A sync that has not succeeded for this long is stale: the card says so. */
export const STALE_SYNC_MS = 3 * 60 * 60 * 1000;

/**
 * Analytics Engine queries one uncached list load costs: sites and datasets.
 * A third (the total) is claimed separately, and only if a row cap is hit.
 */
export const LIST_QUERY_COST = 2;
/**
 * Analytics Engine queries the public endpoint may spend per UTC minute, across
 * every isolate (a counter in this Worker's own D1). Cloudflare publishes no SQL
 * API limit, but its global API limit is 1,200 requests per five minutes per
 * user, with a five minute lockout of ALL API calls when exceeded, and the
 * analytics token shares that with the access section. 60 a minute is at most
 * 300 of the 1,200 in five minutes (a quarter), and the hourly cron adds a few.
 */
export const LIST_QUERIES_PER_MINUTE = 60;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (day: string, offset: number) =>
  dayOf(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS);
export const rangeDays = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;

/** The first UTC day the edge still holds as of `now`, planned with a margin. */
export function embedRetentionStart(now: Date): string {
  return shiftDay(dayOf(now.getTime()), -(EMBED_RETENTION_DAYS - 1));
}

/** Map any value the edge sends to one of the four known kinds. */
export function normalizeKind(raw: unknown): EmbedKind {
  return raw === "iframe" || raw === "document" || raw === "none" ? raw : "other";
}

// ---------- embedding sites ----------

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME = /^[a-z0-9.-]+$/;
/** Names that only resolve on a private network or are reserved for testing. */
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home.arpa",
  ".home",
  ".corp",
  ".intranet",
  ".private",
  ".test",
];
/** Wildcard DNS that turns any IP address, usually a private one, into a name. */
const IP_WILDCARD_DOMAINS = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
  "traefik.me",
];

/** Lowercase and drop every trailing dot. The edge already lowercases; this is for
 *  anything older or odd, so one site is never two. */
export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * True for a host that is not a site on the public internet as far as the
 * dashboard can tell: an empty host (no Referer, or one the edge could not
 * parse), localhost, an IPv4 or IPv6 literal, a name whose last label is all
 * digits, a private-network or test name (no dot, .local, .internal, .lan,
 * .corp, .test and the like), wildcard DNS that embeds an IP address (nip.io,
 * sslip.io), and anything that is not a plausible hostname at all. This only
 * sorts a claimed host into a bucket; the host itself is never shown publicly.
 */
export function isUnknownOrLocalHost(raw: string): boolean {
  const host = normalizeHost(raw);
  if (host === "" || host === "localhost") return true;
  // A URL parser keeps the brackets of an IPv6 literal; a bare one has colons.
  if (host.startsWith("[") || host.includes(":")) return true;
  if (IPV4.test(host)) return true;
  if (!HOSTNAME.test(host)) return true;
  if (!host.includes(".")) return true;
  if (/\.\d+$/.test(host)) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return IP_WILDCARD_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The key two spellings of one site share when counting distinct sites. */
export function siteKey(raw: string): string {
  const host = normalizeHost(raw);
  return host.startsWith("www.") ? host.slice(4) : host;
}

export interface RankedRow {
  label: string;
  value: number;
}

/** What the public page may say about embedding sites: counts, never names. */
export interface EmbedSiteCounts {
  /** localhost, addresses, private names and empty hosts. */
  unknown_or_local: number;
  /** Embedded loads from every other host. */
  sites_loads: number;
  /** How many distinct other hosts those came from (www. folded). A claimed host
   *  count: the Referer is set by the client. */
  distinct_sites: number;
  /** All embedded loads in the window. */
  total: number;
  /** True when the row cap was reached, so distinct_sites is a lower bound. */
  capped: boolean;
}

const byValueThenLabel = (a: RankedRow, b: RankedRow) =>
  b.value - a.value || a.label.localeCompare(b.label);

/**
 * Reduce per-host embedded load counts to the public counts. `total` is the
 * window's embedded loads, so the remainder stays right when `rows` was cut
 * short by a row cap; it is never smaller than the rows it must contain.
 */
export function summarizeEmbedSites(
  rows: readonly { host: string; loads: number }[],
  total: number,
  capped = false,
): EmbedSiteCounts {
  const distinct = new Set<string>();
  let unknown = 0;
  let seen = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.loads) || row.loads <= 0) continue;
    seen += row.loads;
    if (isUnknownOrLocalHost(row.host)) unknown += row.loads;
    else distinct.add(siteKey(row.host));
  }
  const all = Math.max(total, seen);
  return {
    unknown_or_local: unknown,
    sites_loads: all - unknown,
    distinct_sites: distinct.size,
    total: all,
    capped,
  };
}

/** One embedding host as an admin sees it. */
export interface EmbedSiteAdminRow {
  host: string;
  embedded: number;
  opened_directly: number;
  other: number;
  /** True for the hosts the public page counts as unknown or local. */
  unknown_or_local: boolean;
}

/** Group per-(host, kind) loads into one row per host, embedded loads first. */
export function summarizeSitesForAdmin(
  rows: readonly { host: string; kind: EmbedKind; loads: number }[],
): EmbedSiteAdminRow[] {
  const byHost = new Map<string, EmbedSiteAdminRow>();
  for (const row of rows) {
    const host = normalizeHost(row.host);
    let site = byHost.get(host);
    if (!site) {
      site = {
        host,
        embedded: 0,
        opened_directly: 0,
        other: 0,
        unknown_or_local: isUnknownOrLocalHost(host),
      };
      byHost.set(host, site);
    }
    const group = EMBED_GROUP_OF[row.kind];
    if (group === "embedded") site.embedded += row.loads;
    else if (group === "direct") site.opened_directly += row.loads;
    else site.other += row.loads;
  }
  return [...byHost.values()].sort(
    (a, b) =>
      b.embedded - a.embedded ||
      b.opened_directly + b.other - (a.opened_directly + a.other) ||
      a.host.localeCompare(b.host),
  );
}

// ---------- embedded datasets ----------

export interface EmbedDatasetRow {
  label: string;
  value: number;
  /** The dataset's page on the website for this environment. */
  href: string;
}

export interface EmbedDatasetSummary {
  /** Public datasets only, largest first, at most EMBED_DATASET_LIMIT. */
  rows: EmbedDatasetRow[];
  /** Every other embedded load: private, unpublished or unknown ids, and public
   *  datasets past the limit. Deliberately one number with no names. */
  other: number;
  total: number;
}

/**
 * Keep only datasets that are public now and fold the rest into one unnamed
 * count. `publicIds` is the set nemar-db says is public; an id absent from it
 * is never shown, whatever the reason it is absent. `siteBase` is the website
 * origin for this environment, so a dev dashboard links to the dev website.
 */
export function summarizeEmbedDatasets(
  rows: readonly { dataset_id: string; loads: number }[],
  publicIds: ReadonlySet<string>,
  total: number,
  siteBase = "https://nemar.org",
): EmbedDatasetSummary {
  const byId = new Map<string, number>();
  let seen = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.loads) || row.loads <= 0) continue;
    seen += row.loads;
    if (!publicIds.has(row.dataset_id)) continue;
    byId.set(row.dataset_id, (byId.get(row.dataset_id) ?? 0) + row.loads);
  }
  const named = [...byId.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort(byValueThenLabel)
    .slice(0, EMBED_DATASET_LIMIT)
    .map((row) => ({ ...row, href: `${siteBase}/dataset/${encodeURIComponent(row.label)}` }));
  const listed = named.reduce((sum, row) => sum + row.value, 0);
  const all = Math.max(total, seen);
  return { rows: named, other: all - listed, total: all };
}

/** The website origin dataset links point at: WEBSITE_BASE_URL, else nemar.org. */
export function websiteBase(env: Bindings): string {
  return (env.WEBSITE_BASE_URL?.trim() || "https://nemar.org").replace(/\/+$/, "");
}

// ---------- daily totals ----------

export interface EmbedDayRow {
  date: string;
  kind: EmbedKind;
  loads: number;
}

export interface EmbedLoadDay {
  date: string;
  embedded: number;
  direct: number;
  other: number;
}

/** Group stored (date, kind) rows into one record per day, oldest first. */
export function groupEmbedDays(rows: readonly EmbedDayRow[]): EmbedLoadDay[] {
  const days = new Map<string, EmbedLoadDay>();
  for (const row of rows) {
    let day = days.get(row.date);
    if (!day) {
      day = { date: row.date, embedded: 0, direct: 0, other: 0 };
      days.set(row.date, day);
    }
    day[EMBED_GROUP_OF[row.kind]] += row.loads;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The one date range to ask the edge for, `until` exclusive. A settled day is
 * written once, so the range starts at the oldest day inside retention that is
 * absent or not yet settled, and always reaches today (the open day is
 * re-read until it closes and settles).
 *
 * Days before the first day ever stored are not "missing": the edge counted
 * nothing then. Without that rule the range would reach back to the start of
 * retention on every run for the life of the Worker. With nothing stored yet,
 * the whole retention window is asked for once, to find the first day.
 */
export function planEmbedPull(
  first: string | null,
  stamps: ReadonlyMap<string, string>,
  now: Date,
): { since: string; until: string } {
  const today = dayOf(now.getTime());
  const retentionStart = embedRetentionStart(now);
  const until = shiftDay(today, 1);
  if (first === null) return { since: retentionStart, until };
  let since = today;
  for (
    let day = first > retentionStart ? first : retentionStart;
    day < today;
    day = shiftDay(day, 1)
  ) {
    const written = stamps.get(day);
    if (written === undefined || !isSettled(day, written)) {
      since = day;
      break;
    }
  }
  return { since, until };
}

/**
 * Turn the edge's per-(day, kind) answer into the rows to store: all four kinds
 * for every day from the first recorded day through today, with zero where the
 * edge returned no row. A day with no rows at all is a measured zero only
 * between the first recorded day and today, because the edge answered and had
 * nothing for it; days before the first embed ever counted stay absent, since
 * the counting may not have existed yet, and absent means unknown, not zero.
 *
 * `first` is the earliest day already stored, if any.
 */
export function buildEmbedDays(
  rows: readonly EmbedDayRow[],
  since: string,
  today: string,
  first: string | null,
): EmbedDayRow[] {
  const values = new Map<string, number>();
  let earliest = first;
  for (const row of rows) {
    if (row.date < since || row.date > today || !(row.loads >= 0)) continue;
    const key = `${row.date}|${row.kind}`;
    values.set(key, (values.get(key) ?? 0) + row.loads);
    if (earliest === null || row.date < earliest) earliest = row.date;
  }
  if (earliest === null) return [];
  const out: EmbedDayRow[] = [];
  for (let day = earliest > since ? earliest : since; day <= today; day = shiftDay(day, 1)) {
    for (const kind of EMBED_KINDS)
      out.push({ date: day, kind, loads: values.get(`${day}|${kind}`) ?? 0 });
  }
  return out;
}

/**
 * The rows worth writing. A closed day only ever goes up: a lower re-read is a
 * partial answer, not a correction, so that row is not written at all. Writing
 * the stored value back would stamp the day as settled on a read that was not
 * trusted; leaving it alone keeps the day unsettled, so it is asked for again.
 * The open day takes the edge's day-to-date figure.
 */
export function writableEmbedDays(
  stored: readonly EmbedDayRow[],
  fetched: readonly EmbedDayRow[],
  today: string,
): EmbedDayRow[] {
  const have = new Map(stored.map((row) => [`${row.date}|${row.kind}`, row.loads]));
  return fetched.filter((row) => {
    const prior = have.get(`${row.date}|${row.kind}`);
    if (row.date < today && prior !== undefined && row.loads < prior) {
      console.error(
        `[cron] embed loads for closed day ${row.date} (${row.kind}) came back lower (${row.loads} < ${prior}); keeping the stored value and not re-stamping the day`,
      );
      return false;
    }
    return true;
  });
}

// ---------- Analytics Engine queries ----------

/** True when the Worker can read the embed dataset at all. */
export function isEmbedConfigured(env: Bindings): boolean {
  return Boolean(
    env.CF_ANALYTICS_TOKEN?.trim() && env.EMBED_AE_DATASET?.trim() && env.CF_ACCOUNT_ID,
  );
}

const DATASET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The dataset name from deployment config, checked before it enters SQL. */
function datasetName(env: Bindings): string {
  const name = env.EMBED_AE_DATASET?.trim() ?? "";
  if (!DATASET_NAME.test(name)) throw new Error("EMBED_AE_DATASET is not a valid dataset name");
  return name;
}

/** A UTC midnight as an Analytics Engine DateTime literal. `until` is exclusive. */
function utcMidnight(day: string): string {
  if (!DAY_RE.test(day)) throw new Error(`not a UTC day: ${day}`);
  return `toDateTime('${day} 00:00:00')`;
}

function windowSql(since: string, until: string): string {
  return `timestamp >= ${utcMidnight(since)} AND timestamp < ${utcMidnight(until)}`;
}

/** Loads per UTC day and kind, every kind, for `since` (inclusive) to `until` (exclusive). */
export function embedDaysSql(dataset: string, since: string, until: string): string {
  return `SELECT toDate(timestamp) AS day, blob3 AS kind, SUM(_sample_interval) AS loads
         FROM ${dataset}
         WHERE ${windowSql(since, until)}
         GROUP BY day, kind
         ORDER BY day`;
}

/** Embedded loads per embedding host. */
export function embedSitesSql(dataset: string, since: string, until: string): string {
  return `SELECT blob2 AS host, SUM(_sample_interval) AS loads
         FROM ${dataset}
         WHERE blob3 = 'iframe' AND ${windowSql(since, until)}
         GROUP BY host
         ORDER BY loads DESC
         LIMIT ${AE_ROW_LIMIT}`;
}

/** Embedded loads per dataset id. */
export function embedDatasetsSql(dataset: string, since: string, until: string): string {
  return `SELECT blob1 AS dataset_id, SUM(_sample_interval) AS loads
         FROM ${dataset}
         WHERE blob3 = 'iframe' AND ${windowSql(since, until)}
         GROUP BY dataset_id
         ORDER BY loads DESC
         LIMIT ${AE_ROW_LIMIT}`;
}

/** All embedded loads in the window. */
export function embedTotalSql(dataset: string, since: string, until: string): string {
  return `SELECT SUM(_sample_interval) AS loads
         FROM ${dataset}
         WHERE blob3 = 'iframe' AND ${windowSql(since, until)}`;
}

/** Loads per embedding host and kind, for the admin site list. */
export function embedSiteKindsSql(dataset: string, since: string, until: string): string {
  return `SELECT blob2 AS host, blob3 AS kind, SUM(_sample_interval) AS loads
         FROM ${dataset}
         WHERE ${windowSql(since, until)}
         GROUP BY host, kind
         ORDER BY loads DESC
         LIMIT ${AE_ROW_LIMIT}`;
}

/**
 * A count from an Analytics Engine row: a finite, non-negative number, or null.
 * Unlike access.ts's num(), a value that does not parse is never read as 0, so
 * an odd answer cannot become a settled zero.
 */
export function strictCount(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse the per-(day, kind) answer. A row that does not parse is an error, not a
 * zero and not a skipped row: the caller logs it and stores nothing for this
 * pull, so the days stay unsettled and are asked for again.
 */
export function parseEmbedDayRows(rows: readonly AeRow[]): EmbedDayRow[] {
  const out: EmbedDayRow[] = [];
  for (const row of rows) {
    const date = typeof row.day === "string" ? row.day.slice(0, 10) : "";
    const loads = strictCount(row.loads);
    if (!DAY_RE.test(date) || loads === null) {
      throw new Error(`embed day row could not be parsed: ${JSON.stringify(row).slice(0, 120)}`);
    }
    out.push({ date, kind: normalizeKind(row.kind), loads });
  }
  return out;
}

function badRow(what: string, row: unknown): Error {
  return new Error(`${what} row could not be parsed: ${JSON.stringify(row).slice(0, 120)}`);
}

/** Per-host embedded loads. A row that does not parse fails the read. */
export function parseHostRows(rows: readonly AeRow[]): { host: string; loads: number }[] {
  return rows.map((row) => {
    const loads = strictCount(row.loads);
    if (typeof row.host !== "string" || loads === null) throw badRow("embed host", row);
    return { host: row.host, loads };
  });
}

/** Per-(host, kind) loads for the admin list. */
export function parseHostKindRows(
  rows: readonly AeRow[],
): { host: string; kind: EmbedKind; loads: number }[] {
  return rows.map((row) => {
    const loads = strictCount(row.loads);
    if (typeof row.host !== "string" || loads === null) throw badRow("embed host and kind", row);
    return { host: row.host, kind: normalizeKind(row.kind), loads };
  });
}

/** Per-dataset embedded loads. A row that does not parse fails the read. */
export function parseDatasetRows(rows: readonly AeRow[]): { dataset_id: string; loads: number }[] {
  return rows.map((row) => {
    const loads = strictCount(row.loads);
    if (typeof row.dataset_id !== "string" || loads === null) throw badRow("embed dataset", row);
    return { dataset_id: row.dataset_id, loads };
  });
}

/** The single SUM row; no row means the sum is not known here (null). */
export function parseTotalRow(rows: readonly AeRow[]): number | null {
  if (rows.length === 0) return null;
  const loads = strictCount(rows[0].loads);
  if (loads === null) throw badRow("embed total", rows[0]);
  return loads;
}

/** Read the per-(day, kind) totals for `since` to `until` (exclusive). */
export async function fetchEmbedDays(
  env: Bindings,
  since: string,
  until: string,
): Promise<EmbedDayRow[]> {
  return parseEmbedDayRows(await queryAe(env, embedDaysSql(datasetName(env), since, until)));
}

// ---------- the API answer ----------

export type EmbedSourceStatus = "available" | "partial" | "unconfigured" | "unavailable";

/** Why a loads block has no day to show, when it has none. */
export type EmbedEmptyReason = "future" | "before_counting" | "none_yet";

export interface EmbedLoadsBlock {
  status: EmbedSourceStatus;
  /** First and last stored day inside the range, or null when none is stored. */
  coverage: { start: string; end: string } | null;
  /** The stored days inside the range, oldest first. */
  days: EmbedLoadDay[];
  /** Sums over `days`; null when no day is stored, which is unknown, not zero. */
  totals: { embedded: number; direct: number; other: number } | null;
  days_recorded: number;
  days_in_range: number;
  /** The first day any load was ever recorded, or null. Earlier days are unknown. */
  counting_began: string | null;
  /** Why no day is shown: the dates are in the future, before counting began, or
   *  nothing is recorded yet. */
  empty_reason: EmbedEmptyReason | null;
  /** When the sync last succeeded, or null if it never has. */
  last_synced_at: string | null;
  note?: string;
}

export interface EmbedListBlock<T> {
  status: EmbedSourceStatus;
  /** The UTC days the detail covers: the selected dates inside what the edge keeps. */
  window: { start: string; end: string } | null;
  summary: T | null;
  /** Set when there is no summary for a reason that is not a fault. */
  reason?: "future" | "expired";
  note?: string;
}

export interface EmbedsResponse {
  start: string;
  end: string;
  observed_at: string;
  loads: EmbedLoadsBlock;
  sites: EmbedListBlock<EmbedSiteCounts>;
  datasets: EmbedListBlock<EmbedDatasetSummary>;
}

/** The selected dates that the edge's own retention still covers. */
export function detailWindow(
  start: string,
  end: string,
  now: Date,
): { start: string; end: string; clipped: boolean } | null {
  const today = dayOf(now.getTime());
  const oldest = shiftDay(today, -(EMBED_RETENTION_DAYS - 1));
  const from = start > oldest ? start : oldest;
  const to = end < today ? end : today;
  if (from > to) return null;
  return { start: from, end: to, clipped: from !== start || to !== end };
}

/** "2026-10-05 14:47 UTC" for a stored ISO timestamp. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

const FUTURE_NOTE = "These dates are in the future, so nothing has been counted yet.";

export interface LoadsContext {
  configured: boolean;
  /** The earliest stored day, or null when nothing is stored. */
  firstDay: string | null;
  /** The sync status row, or null when it is missing. */
  sync: { last_ok_at: string | null; last_error: string | null; last_run_at: string | null } | null;
}

/**
 * The accumulated daily totals for the selected dates, from this Worker's own
 * D1, with the health of the sync that fills them. A card never reads better
 * than its data: a sync that has never succeeded, or has not for a while, is
 * said so rather than shown as an empty or complete answer.
 */
export function buildLoadsBlock(
  rows: readonly EmbedDayRow[],
  start: string,
  end: string,
  now: Date,
  ctx: LoadsContext,
): EmbedLoadsBlock {
  const days = groupEmbedDays(rows);
  const daysInRange = rangeDays(start, end);
  const lastOk = ctx.sync?.last_ok_at ?? null;
  const base = {
    coverage: null,
    days: [] as EmbedLoadDay[],
    totals: null,
    days_recorded: 0,
    days_in_range: daysInRange,
    counting_began: ctx.firstDay,
    last_synced_at: lastOk,
  };
  if (!ctx.configured) {
    return {
      ...base,
      status: "unconfigured",
      empty_reason: null,
      note: "Embed counting is not configured for this dashboard.",
    };
  }
  const today = dayOf(now.getTime());
  const stale = lastOk !== null && now.getTime() - Date.parse(lastOk) > STALE_SYNC_MS;
  const updated = lastOk ? ` Last updated ${formatUtc(lastOk)}.` : "";

  if (days.length === 0) {
    if (start > today) {
      return { ...base, status: "available", empty_reason: "future", note: FUTURE_NOTE };
    }
    if (lastOk === null) {
      return {
        ...base,
        status: "unavailable",
        empty_reason: null,
        note: ctx.sync?.last_error
          ? "The update of embed totals has failed and none has succeeded yet."
          : "Embed totals have not been collected yet. The first update runs within the hour.",
      };
    }
    if (stale) {
      return {
        ...base,
        status: "unavailable",
        empty_reason: null,
        note: `Embed totals have not updated for several hours, so these dates cannot be shown.${updated}`,
      };
    }
    if (ctx.firstDay !== null && end < ctx.firstDay) {
      return {
        ...base,
        status: "available",
        empty_reason: "before_counting",
        note: `Counting began on ${ctx.firstDay}. These dates are before it, so the loads are unknown, not zero.`,
      };
    }
    return {
      ...base,
      status: "available",
      empty_reason: "none_yet",
      note: "No embed loads are recorded for these dates.",
    };
  }

  const totals = { embedded: 0, direct: 0, other: 0 };
  for (const day of days) {
    totals.embedded += day.embedded;
    totals.direct += day.direct;
    totals.other += day.other;
  }
  const notes: string[] = [];
  if (days.length < daysInRange) {
    notes.push(
      `Recorded for ${days.length} of ${daysInRange} days; days before counting began or not yet collected are unknown, not zero.`,
    );
  }
  if (end >= today) {
    notes.push("The current UTC day is still in progress, so its totals may be incomplete.");
  }
  if (stale) {
    notes.push(
      `Embed totals have not updated for several hours, so recent days may be missing.${updated}`,
    );
  }
  return {
    ...base,
    status: notes.length ? "partial" : "available",
    coverage: { start: days[0].date, end: days[days.length - 1].date },
    days,
    totals,
    days_recorded: days.length,
    empty_reason: null,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
