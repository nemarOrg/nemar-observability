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
//   - Embedding sites are named only at or above MIN_NAMED_SITE_LOADS. A
//     hostname can identify a person (a personal site is named after its
//     owner), so a site that has barely embedded the viewer is not named; it is
//     counted in "other sites". localhost, IP addresses, private-network names
//     and empty hosts are never named either, whatever their count: they are
//     grouped as "unknown or local".

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

/**
 * An embedding site is named only when it accounts for at least this many
 * embedded loads in the selected dates. Ten is the same small-cell floor the
 * dashboard already applies to countries (summarizeCountries in audience.ts:
 * values below 10 are withheld), so one rule explains both lists.
 *
 * It is applied to the selected range as a whole, not to each day as the
 * country rule is. A per-day floor of ten would hide every partner whose
 * embeds are spread thin, which is most of them, and leave the list empty.
 * The cost is the usual small-cell caveat: comparing two ranges that differ by
 * one day can show that a site crossed the line. That reveals a count for a
 * site the reader could already see by name, never a name that was withheld.
 */
export const MIN_NAMED_SITE_LOADS = 10;

/** Rows in each public ranking; the rest is folded into an unnamed count. */
export const EMBED_LIST_LIMIT = 10;

/** Cap on the rows read for one ranking. The total is queried separately, so a
 *  cap cannot make the unnamed remainder too small. */
const AE_ROW_LIMIT = 5000;

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (day: string, offset: number) =>
  dayOf(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS);
const rangeDays = (start: string, end: string) =>
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
const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home.arpa",
];

/** Lowercase, drop a trailing dot. The edge already lowercases; this is for
 *  anything older or odd, so the same site is never two rows. */
export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True for a host that is never named on the public page: an empty host (no
 * Referer, or one the edge could not parse), localhost, an IPv4 or IPv6
 * literal, a name on a private network (no dot, or .local, .internal, .lan and
 * the like), and anything that is not a plausible hostname at all.
 */
export function isUnknownOrLocalHost(raw: string): boolean {
  const host = normalizeHost(raw);
  if (host === "" || host === "localhost") return true;
  // A URL parser keeps the brackets of an IPv6 literal; a bare one has colons.
  if (host.startsWith("[") || host.includes(":")) return true;
  if (IPV4.test(host)) return true;
  if (!HOSTNAME.test(host)) return true;
  if (!host.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export interface RankedRow {
  label: string;
  value: number;
}

export interface EmbedSiteSummary {
  /** Named sites at or above the floor, largest first, at most EMBED_LIST_LIMIT. */
  rows: RankedRow[];
  /** localhost, IP addresses, private names and empty hosts, never listed singly. */
  unknown_or_local: number;
  /** Every other embedded load: sites under the floor and sites past the limit. */
  other_sites: number;
  /** All embedded loads in the window. */
  total: number;
  /** The floor a site needed to be named, so the page states the rule it was held to. */
  min_named_loads: number;
}

const byValueThenLabel = (a: RankedRow, b: RankedRow) =>
  b.value - a.value || a.label.localeCompare(b.label);

/**
 * Apply the public rules for embedding sites to per-host embedded load counts.
 * `total` is the window's embedded loads from a separate query, so the unnamed
 * remainder stays right when `rows` was cut short by a row cap. It is never
 * allowed to be smaller than the rows it must contain.
 */
export function summarizeEmbedSites(
  rows: readonly { host: string; loads: number }[],
  total: number,
): EmbedSiteSummary {
  const byHost = new Map<string, number>();
  let unknown = 0;
  let seen = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.loads) || row.loads <= 0) continue;
    seen += row.loads;
    if (isUnknownOrLocalHost(row.host)) {
      unknown += row.loads;
      continue;
    }
    const host = normalizeHost(row.host);
    byHost.set(host, (byHost.get(host) ?? 0) + row.loads);
  }
  const named = [...byHost.entries()]
    .filter(([, loads]) => loads >= MIN_NAMED_SITE_LOADS)
    .map(([label, value]) => ({ label, value }))
    .sort(byValueThenLabel)
    .slice(0, EMBED_LIST_LIMIT);
  const listed = named.reduce((sum, row) => sum + row.value, 0);
  const all = Math.max(total, seen);
  return {
    rows: named,
    unknown_or_local: unknown,
    other_sites: all - listed - unknown,
    total: all,
    min_named_loads: MIN_NAMED_SITE_LOADS,
  };
}

// ---------- embedded datasets ----------

export interface EmbedDatasetSummary {
  /** Public datasets only, largest first, at most EMBED_LIST_LIMIT. */
  rows: RankedRow[];
  /** Every other embedded load: private, unpublished or unknown ids, and public
   *  datasets past the limit. Deliberately one number with no names. */
  other: number;
  total: number;
}

/**
 * Keep only datasets that are public now and fold the rest into one unnamed
 * count. `publicIds` is the set nemar-db says is public; an id absent from it
 * is never shown, whatever the reason it is absent.
 */
export function summarizeEmbedDatasets(
  rows: readonly { dataset_id: string; loads: number }[],
  publicIds: ReadonlySet<string>,
  total: number,
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
    .slice(0, EMBED_LIST_LIMIT);
  const listed = named.reduce((sum, row) => sum + row.value, 0);
  const all = Math.max(total, seen);
  return { rows: named, other: all - listed, total: all };
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
 * partial answer, not a correction, so the stored value is written back (which
 * stamps the day as written, letting it settle instead of being asked for every
 * hour). The open day takes the edge's day-to-date figure.
 */
export function writableEmbedDays(
  stored: readonly EmbedDayRow[],
  fetched: readonly EmbedDayRow[],
  today: string,
): EmbedDayRow[] {
  const have = new Map(stored.map((row) => [`${row.date}|${row.kind}`, row.loads]));
  return fetched.map((row) => {
    const prior = have.get(`${row.date}|${row.kind}`);
    if (row.date < today && prior !== undefined && row.loads < prior) {
      console.error(
        `[cron] embed loads for closed day ${row.date} (${row.kind}) came back lower (${row.loads} < ${prior}); keeping the stored value`,
      );
      return { ...row, loads: prior };
    }
    return row;
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

/** Parse the per-(day, kind) answer. A row that is not a real day is dropped. */
export function parseEmbedDayRows(rows: readonly AeRow[]): EmbedDayRow[] {
  const out: EmbedDayRow[] = [];
  for (const row of rows) {
    const date = String(row.day ?? "").slice(0, 10);
    const loads = aeNum(row.loads as string | number | null);
    if (!DAY_RE.test(date) || loads < 0) continue;
    out.push({ date, kind: normalizeKind(row.kind), loads });
  }
  return out;
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

export interface EmbedLoadsBlock {
  status: EmbedSourceStatus;
  /** First and last stored day inside the range, or null when none is stored. */
  coverage: { start: string; end: string } | null;
  /** The stored days inside the range, oldest first. */
  days: EmbedLoadDay[];
  /** Sums over `days`; null when no day is stored. */
  totals: { embedded: number; direct: number; other: number } | null;
  days_recorded: number;
  days_in_range: number;
  note?: string;
}

export interface EmbedListBlock<T> {
  status: EmbedSourceStatus;
  /** The UTC days the detail covers: the selected dates inside what the edge keeps. */
  window: { start: string; end: string } | null;
  summary: T | null;
  note?: string;
}

export interface EmbedsResponse {
  start: string;
  end: string;
  observed_at: string;
  loads: EmbedLoadsBlock;
  sites: EmbedListBlock<EmbedSiteSummary>;
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

const unconfiguredList = <T>(): EmbedListBlock<T> => ({
  status: "unconfigured",
  window: null,
  summary: null,
  note: "Embed counting is not configured for this dashboard.",
});

const unavailableList = <T>(note: string): EmbedListBlock<T> => ({
  status: "unavailable",
  window: null,
  summary: null,
  note,
});

/** The sites and datasets for the selected dates, read from the edge's records. */
export async function loadEmbedLists(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
): Promise<{
  sites: EmbedListBlock<EmbedSiteSummary>;
  datasets: EmbedListBlock<EmbedDatasetSummary>;
}> {
  if (!isEmbedConfigured(env)) return { sites: unconfiguredList(), datasets: unconfiguredList() };
  const window = detailWindow(start, end, now);
  if (!window) {
    const note =
      "Per-site and per-dataset detail covers about the last three months, and none of the selected dates fall inside it.";
    return { sites: unavailableList(note), datasets: unavailableList(note) };
  }
  const until = shiftDay(window.end, 1);
  let siteRows: AeRow[];
  let datasetRows: AeRow[];
  let totalRows: AeRow[];
  try {
    const dataset = datasetName(env);
    [siteRows, datasetRows, totalRows] = await Promise.all([
      queryAe(env, embedSitesSql(dataset, window.start, until)),
      queryAe(env, embedDatasetsSql(dataset, window.start, until)),
      queryAe(env, embedTotalSql(dataset, window.start, until)),
    ]);
  } catch (err) {
    console.error("[embeds] edge query failed:", err);
    const note = "Embed detail is currently unavailable.";
    return { sites: unavailableList(note), datasets: unavailableList(note) };
  }
  const total = aeNum(totalRows[0]?.loads as string | number | null | undefined);
  const today = dayOf(now.getTime());
  const status: EmbedSourceStatus = window.clipped || window.end >= today ? "partial" : "available";
  const notes: string[] = [];
  if (window.clipped) {
    notes.push(
      "Detail covers only the part of the selected dates from the last three months that is still kept.",
    );
  }
  if (window.end >= today) notes.push("The current UTC day is still in progress.");

  const sites = summarizeEmbedSites(
    siteRows.map((row) => ({
      host: String(row.host ?? ""),
      loads: aeNum(row.loads as string | number | null),
    })),
    total,
  );
  const sitesBlock: EmbedListBlock<EmbedSiteSummary> = {
    status,
    window: { start: window.start, end: window.end },
    summary: sites,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };

  // The public check is the privacy boundary: if nemar-db cannot answer, no
  // dataset is named, rather than every dataset.
  let datasetsBlock: EmbedListBlock<EmbedDatasetSummary>;
  try {
    const ids = datasetRows.map((row) => String(row.dataset_id ?? "")).filter(Boolean);
    const publicIds = await publicDatasetIds(env.NEMAR_DB, ids);
    datasetsBlock = {
      status,
      window: { start: window.start, end: window.end },
      summary: summarizeEmbedDatasets(
        datasetRows.map((row) => ({
          dataset_id: String(row.dataset_id ?? ""),
          loads: aeNum(row.loads as string | number | null),
        })),
        publicIds,
        total,
      ),
      ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  } catch (err) {
    console.error("[embeds] public dataset check failed:", err);
    datasetsBlock = unavailableList("Embedded datasets are currently unavailable.");
  }
  return { sites: sitesBlock, datasets: datasetsBlock };
}

/** The accumulated daily totals for the selected dates, from this Worker's own D1. */
export function buildLoadsBlock(
  rows: readonly EmbedDayRow[],
  start: string,
  end: string,
  now: Date,
  configured: boolean,
): EmbedLoadsBlock {
  const days = groupEmbedDays(rows);
  const daysInRange = rangeDays(start, end);
  if (days.length === 0) {
    return {
      status: configured ? "available" : "unconfigured",
      coverage: null,
      days: [],
      totals: null,
      days_recorded: 0,
      days_in_range: daysInRange,
      note: configured
        ? "No embed loads are recorded for these dates."
        : "Embed counting is not configured for this dashboard.",
    };
  }
  const totals = { embedded: 0, direct: 0, other: 0 };
  for (const day of days) {
    totals.embedded += day.embedded;
    totals.direct += day.direct;
    totals.other += day.other;
  }
  const today = dayOf(now.getTime());
  const notes: string[] = [];
  if (days.length < daysInRange) {
    notes.push(
      `Recorded for ${days.length} of ${daysInRange} days; days before counting began or not yet collected are unknown, not zero.`,
    );
  }
  if (end >= today)
    notes.push("The current UTC day is still in progress, so its totals may be incomplete.");
  return {
    status: notes.length ? "partial" : "available",
    coverage: { start: days[0].date, end: days[days.length - 1].date },
    days,
    totals,
    days_recorded: days.length,
    days_in_range: daysInRange,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
