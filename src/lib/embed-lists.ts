// Loading the Signal viewer's third-party figures for the public /embeds answer
// and the admin site list: the daily totals from this Worker's own D1 (with the
// health of the sync that fills them), and the per-site and per-dataset detail
// from the edge, shaped for a public page (see the header of embeds.ts).
//
// The detail is an outbound call to a quota-limited API on a public request
// path, with a date range the caller chooses. There is no edge cache in front of
// Worker responses, so three things bound it: a short per-isolate memo with
// concurrent identical requests sharing one load; the page's own preset windows
// shared across isolates through D1 for a minute; and a shared per-minute budget
// in D1, in two pools (preset and custom), that every uncached load must claim
// first (embed-store.ts). ADR 0002 has the numbers.

import type { Bindings } from "../types";
import { queryAe } from "./access";
import {
  type BudgetPool,
  claimQueryBudget,
  loadEmbedDays,
  loadEmbedSync,
  loadFirstEmbedDay,
  readPresetAnswer,
  releasePresetClaim,
  tryClaimPreset,
  writePresetAnswer,
} from "./embed-store";
import {
  AE_ROW_LIMIT,
  EMBED_QUERY_TIMEOUT_MS,
  type EmbedDatasetSummary,
  type EmbedListBlock,
  type EmbedLoadsBlock,
  type EmbedSiteAdminRow,
  type EmbedSiteCounts,
  type EmbedSourceStatus,
  LIST_QUERIES_PER_MINUTE,
  LIST_QUERY_COST,
  buildLoadsBlock,
  datasetName,
  dayOf,
  detailWindow,
  embedDatasetsSql,
  embedSiteKindsSql,
  embedSitesSql,
  embedTotalSql,
  isEmbedConfigured,
  isPresetRange,
  parseDatasetRows,
  parseHostKindRows,
  parseHostRows,
  parseTotalRow,
  rangeDays,
  shiftDay,
  summarizeEmbedDatasets,
  summarizeEmbedSites,
  summarizeSitesForAdmin,
  websiteBase,
} from "./embeds";
import { publicDatasetIds } from "./sql";

const nextDay = (day: string) => shiftDay(day, 1);

export interface EmbedLists {
  sites: EmbedListBlock<EmbedSiteCounts>;
  datasets: EmbedListBlock<EmbedDatasetSummary>;
}

export const BUSY_NOTE = "Embed detail is busy. Try again in a minute.";
const FUTURE_NOTE = "These dates are in the future, so nothing has been counted yet.";
const EXPIRED_NOTE =
  "Per-site and per-dataset detail covers about the last three months, and none of the selected dates fall inside it.";

/** The stored daily totals for the selected dates, shaped for the API. A store
 *  that cannot answer (the migration not applied, a D1 fault) is reported as
 *  unavailable, never as zero loads. */
export async function readEmbedLoads(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
): Promise<EmbedLoadsBlock> {
  try {
    const [rows, firstDay, sync] = await Promise.all([
      loadEmbedDays(env.OBS_DB, start, end),
      loadFirstEmbedDay(env.OBS_DB),
      loadEmbedSync(env.OBS_DB),
    ]);
    return buildLoadsBlock(rows, start, end, now, {
      configured: isEmbedConfigured(env),
      firstDay,
      sync,
    });
  } catch (err) {
    console.error("[embeds] stored daily totals could not be read:", err);
    return {
      status: "unavailable",
      coverage: null,
      days: [],
      totals: null,
      days_recorded: 0,
      days_in_range: rangeDays(start, end),
      counting_began: null,
      empty_reason: null,
      last_synced_at: null,
      note: "Embed totals are currently unavailable.",
    };
  }
}

type EmptyReason = "future" | "expired" | "before_counting";

const emptyBlock = <T>(
  status: EmbedSourceStatus,
  note: string,
  reason?: EmptyReason,
): EmbedListBlock<T> => ({
  status,
  window: null,
  summary: null,
  ...(reason ? { reason } : {}),
  note,
});
const bothBlocks = (status: EmbedSourceStatus, note: string, reason?: EmptyReason): EmbedLists => ({
  sites: emptyBlock(status, note, reason),
  datasets: emptyBlock(status, note, reason),
});

/**
 * The lists for a range wholly before counting began: the same answer as the
 * loads card (unknown, not zero), and no query to the edge, whose dataset holds
 * nothing for those dates because the counting did not exist.
 */
export function beforeCountingLists(note: string): EmbedLists {
  return bothBlocks("available", note, "before_counting");
}

/** How long an answer may be reused, counted from when it was COMPUTED. */
const MEMO_TTL_MS = 60_000;
const MEMO_MAX = 32;
/** How long a claim on computing a preset window holds before another isolate may take over. */
const CLAIM_TTL_MS = 10_000;
/** A waiter polls the shared row this often, this many times, before it tries the claim again. */
const DEFAULT_POLL_MS = 400;
const DEFAULT_POLLS = 5;

/**
 * What is cached and shared is DATA only: the counts and the public dataset
 * names, which are a function of the clipped window alone. Status and notes
 * depend on the range the caller asked for (a 90 day preset and an 84 day custom
 * range share a window but not a clip note), so they are derived per request
 * from the raw start and end (presentLists), never stored.
 */
export interface ListData {
  sites: EmbedSiteCounts;
  /** null when the public check could not be made: nothing named, nothing shared. */
  datasets: EmbedDatasetSummary | null;
}

type Loaded =
  | { kind: "data"; data: ListData; computedAt: number }
  /** A refusal or a fault: shown to this caller, never kept or shared. */
  | { kind: "failed"; lists: EmbedLists };

interface MemoEntry {
  /** When the answer was computed (or, while it is in flight, when it was asked for). */
  at: number;
  loaded: Promise<Loaded>;
}

/** One isolate's memo of answers. Tests make several to stand in for isolates. */
export interface ListsMemo {
  entries: Map<string, MemoEntry>;
}
export const createListsMemo = (): ListsMemo => ({ entries: new Map() });
const defaultMemo = createListsMemo();

/** Forget every memoized answer of this isolate (tests). */
export function resetEmbedListsMemo(): void {
  defaultMemo.entries.clear();
}

export interface ListOptions {
  memo?: ListsMemo;
  /** How long a waiter sleeps between reads of the shared row, and how many times. */
  pollMs?: number;
  polls?: number;
}

/**
 * The sites and datasets for the selected dates. Sites come back as counts only;
 * datasets are named only when public now.
 *
 * An answer is reused for 60 seconds counted from when it was computed, by this
 * isolate's memo and, for the page's preset windows, by a shared D1 row. An
 * isolate that reads a row aged 40 seconds reuses it for only 20 more, so the two
 * layers never stack and a name is never held longer than 60 seconds
 * server-side. A failure or a refusal is not kept. An uncached load claims its
 * queries from the shared budget before it asks the edge anything.
 */
export async function loadEmbedLists(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
  options: ListOptions = {},
): Promise<EmbedLists> {
  if (!isEmbedConfigured(env)) {
    return bothBlocks("unconfigured", "Embed counting is not configured for this dashboard.");
  }
  try {
    datasetName(env);
  } catch (err) {
    // A bad name is a deployment fault: say so, spend no budget, ask nothing.
    console.error("[embeds] lists not loaded:", err);
    return bothBlocks("unavailable", "Embed detail is currently unavailable.");
  }
  const today = dayOf(now.getTime());
  if (start > today) return bothBlocks("available", FUTURE_NOTE, "future");
  const window = detailWindow(start, end, now);
  if (!window) return bothBlocks("unavailable", EXPIRED_NOTE, "expired");

  const memo = options.memo ?? defaultMemo;
  const key = windowKey(env, window, now);
  let entry = memo.entries.get(key);
  if (!entry || now.getTime() - entry.at >= MEMO_TTL_MS) {
    const loaded = isPresetRange(start, end, now)
      ? loadSharedPreset(env, start, end, window, now, options)
      : computeLists(env, start, end, window, now);
    entry = { at: now.getTime(), loaded };
    if (memo.entries.size >= MEMO_MAX)
      memo.entries.delete(memo.entries.keys().next().value as string);
    memo.entries.set(key, entry);
  }
  const mine = entry;
  const settled = await mine.loaded;
  if (settled.kind === "data" && settled.data.datasets !== null) {
    // Count the minute from when it was computed, not from when this isolate read it.
    mine.at = settled.computedAt;
  } else if (memo.entries.get(key) === mine) {
    memo.entries.delete(key);
  }
  return settled.kind === "failed"
    ? settled.lists
    : presentLists(settled.data, start, end, window, now);
}

const windowKey = (env: Bindings, window: { start: string; end: string }, now: Date): string =>
  `${env.EMBED_AE_DATASET}|${window.start}|${window.end}|${dayOf(now.getTime())}|${websiteBase(env)}`;

/**
 * The status and notes of the lists for THIS range, from cached data. The clip
 * notes come from how the raw start and end differ from the window the data
 * covers, so two ranges that share a window never share each other's notes.
 */
export function presentLists(
  data: ListData,
  start: string,
  end: string,
  window: { start: string; end: string },
  now: Date,
): EmbedLists {
  const today = dayOf(now.getTime());
  const clipped = window.start !== start || window.end !== end;
  const status: EmbedSourceStatus = clipped || window.end >= today ? "partial" : "available";
  const notes: string[] = [];
  if (window.start !== start) {
    notes.push(
      "Detail covers only the part of the selected dates from the last three months that is still kept.",
    );
  }
  if (window.end !== end) notes.push("Dates after today are not counted yet.");
  if (window.end >= today) notes.push("The current UTC day is still in progress.");
  const shared = {
    status,
    window: { start: window.start, end: window.end },
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
  return {
    sites: { ...shared, summary: data.sites },
    datasets: data.datasets
      ? { ...shared, summary: data.datasets }
      : emptyBlock("unavailable", "Embedded datasets are currently unavailable."),
  };
}

/** True for data that is whole enough to share: the public check was made. */
const shareable = (loaded: Loaded): loaded is Extract<Loaded, { kind: "data" }> =>
  loaded.kind === "data" && loaded.data.datasets !== null;

/**
 * A preset window's data, shared across isolates through D1 for the memo's 60
 * seconds, with one claimant computing it.
 *
 * A fresh row answers it with no budget and no query. On a miss the isolate
 * inserts a claim for about ten seconds and computes it; an isolate that finds a
 * live claim polls the row a few times and reads what the claimant stored. So a
 * herd of cold isolates at expiry computes a window once, and only the claimant
 * spends budget. A claimant that fails releases the claim. A D1 read, claim or
 * write that fails is logged and skipped: it costs a recomputation, which the
 * budget still bounds.
 */
async function loadSharedPreset(
  env: Bindings,
  start: string,
  end: string,
  window: { start: string; end: string; clipped: boolean },
  now: Date,
  options: ListOptions,
): Promise<Loaded> {
  const key = windowKey(env, window, now);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const polls = options.polls ?? DEFAULT_POLLS;
  const readShared = async (at: Date): Promise<Loaded | null> => {
    try {
      const shared = await readPresetAnswer(env.OBS_DB, key, at, MEMO_TTL_MS);
      if (!shared) return null;
      const data = JSON.parse(shared.answer) as ListData;
      if (typeof data?.sites?.total !== "number" || !data.datasets) return null;
      return { kind: "data", data, computedAt: shared.computedAt };
    } catch (err) {
      console.error("[embeds] shared preset answer could not be read:", String(err).slice(0, 120));
      return null;
    }
  };
  const claim = async (): Promise<boolean> => {
    try {
      return await tryClaimPreset(env.OBS_DB, key, now, CLAIM_TTL_MS);
    } catch (err) {
      // Cannot claim: compute anyway, as before claims existed. The budget bounds it.
      console.error("[embeds] preset claim could not be taken:", String(err).slice(0, 120));
      return true;
    }
  };
  const computeAndShare = async (): Promise<Loaded> => {
    try {
      const loaded = await computeLists(env, start, end, window, now);
      if (shareable(loaded)) {
        try {
          await writePresetAnswer(env.OBS_DB, key, JSON.stringify(loaded.data), now);
        } catch (err) {
          console.error(
            "[embeds] shared preset answer could not be stored:",
            String(err).slice(0, 120),
          );
        }
      }
      return loaded;
    } finally {
      // Whether it worked or not, the claim is given back: a waiter reads the
      // answer, or takes over, without waiting for the claim to expire.
      await releasePresetClaim(env.OBS_DB, key).catch((err) =>
        console.error("[embeds] preset claim could not be released:", String(err).slice(0, 120)),
      );
    }
  };

  const fresh = await readShared(now);
  if (fresh) return fresh;
  if (await claim()) return computeAndShare();
  // Another isolate is computing this window: wait for its answer.
  for (let i = 1; i <= polls; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const shared = await readShared(new Date(now.getTime() + i * pollMs));
    if (shared) return shared;
  }
  // It did not arrive: take over if the claim was released or expired, else give up.
  if (await claim()) return computeAndShare();
  return { kind: "failed", lists: bothBlocks("unavailable", BUSY_NOTE) };
}

/** One more query, only when a row cap was hit; if the budget is spent the rows' own sum stands in. */
async function claimExtraQuery(env: Bindings, now: Date, pool: BudgetPool): Promise<boolean> {
  try {
    return await claimQueryBudget(env.OBS_DB, now, 1, LIST_QUERIES_PER_MINUTE[pool], pool);
  } catch (err) {
    // Cannot claim: skip the extra query, and say why without any value.
    console.error(
      "[embeds] extra query budget could not be claimed:",
      err instanceof Error ? err.message.slice(0, 120) : "unknown error",
    );
    return false;
  }
}

async function computeLists(
  env: Bindings,
  start: string,
  end: string,
  window: { start: string; end: string; clipped: boolean },
  now: Date,
): Promise<Loaded> {
  const failed = (note: string): Loaded => ({
    kind: "failed",
    lists: bothBlocks("unavailable", note),
  });
  const pool = isPresetRange(start, end, now) ? "preset" : "custom";
  let claimed: boolean;
  try {
    claimed = await claimQueryBudget(
      env.OBS_DB,
      now,
      LIST_QUERY_COST,
      LIST_QUERIES_PER_MINUTE[pool],
      pool,
    );
  } catch (err) {
    // Without the budget the quota cannot be protected, so the edge is not asked.
    // That is a fault, not load: it does not say "busy".
    console.error("[embeds] query budget could not be claimed:", err);
    return failed("Embed detail is currently unavailable.");
  }
  if (!claimed) return failed(BUSY_NOTE);

  const until = nextDay(window.end);
  let siteRows: ReturnType<typeof parseHostRows>;
  let datasetRows: ReturnType<typeof parseDatasetRows>;
  let total: number;
  let capped: boolean;
  try {
    const dataset = datasetName(env);
    const [rawSites, rawDatasets] = await Promise.all([
      queryAe(env, embedSitesSql(dataset, window.start, until), EMBED_QUERY_TIMEOUT_MS),
      queryAe(env, embedDatasetsSql(dataset, window.start, until), EMBED_QUERY_TIMEOUT_MS),
    ]);
    siteRows = parseHostRows(rawSites);
    datasetRows = parseDatasetRows(rawDatasets);
    capped = rawSites.length >= AE_ROW_LIMIT || rawDatasets.length >= AE_ROW_LIMIT;
    // The rows add up to the total unless a row cap cut them short.
    total = siteRows.reduce((n, r) => n + r.loads, 0);
    if (capped && (await claimExtraQuery(env, now, pool))) {
      const queried = parseTotalRow(
        await queryAe(env, embedTotalSql(dataset, window.start, until), EMBED_QUERY_TIMEOUT_MS),
      );
      total = Math.max(total, queried ?? 0);
    }
  } catch (err) {
    console.error("[embeds] edge query failed:", err);
    return failed("Embed detail is currently unavailable.");
  }

  // The public check is the privacy boundary: if nemar-db cannot answer, no
  // dataset is named, rather than every dataset.
  let datasets: EmbedDatasetSummary | null = null;
  try {
    const publicIds = await publicDatasetIds(
      env.NEMAR_DB,
      datasetRows.map((r) => r.dataset_id).filter(Boolean),
    );
    datasets = summarizeEmbedDatasets(datasetRows, publicIds, total, websiteBase(env));
  } catch (err) {
    console.error("[embeds] public dataset check failed:", err);
  }
  return {
    kind: "data",
    data: { sites: summarizeEmbedSites(siteRows, total, capped), datasets },
    computedAt: now.getTime(),
  };
}

export const EMBED_SITES_DRILLDOWN = "embed-sites" as const;
const ADMIN_ITEM_LIMIT = 500;

/** The admin drill-down: every embedding host with its loads by kind. */
export interface EmbedSitesDrilldown {
  key: typeof EMBED_SITES_DRILLDOWN;
  label: string;
  kind: "embed_site";
  count: number;
  items: EmbedSiteAdminRow[];
  window: { start: string; end: string } | null;
  note?: string;
}

/**
 * The full host list for admins, for the part of `start` to `end` the edge still
 * holds. This is the only place hostnames leave the Worker, and only through the
 * bearer-gated drill-down route. Throws when the edge cannot answer, so an
 * admin never mistakes a failed read for an empty list.
 */
export async function loadEmbedSitesAdmin(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
): Promise<EmbedSitesDrilldown> {
  const base = {
    key: EMBED_SITES_DRILLDOWN as typeof EMBED_SITES_DRILLDOWN,
    label: "Embedding sites (loads by kind, hosts as claimed by the Referer header)",
    kind: "embed_site" as const,
  };
  if (!isEmbedConfigured(env)) throw new Error("embed counting is not configured");
  const window = detailWindow(start, end, now);
  if (!window) {
    return {
      ...base,
      count: 0,
      items: [],
      window: null,
      note: start > dayOf(now.getTime()) ? FUTURE_NOTE : EXPIRED_NOTE,
    };
  }
  const dataset = datasetName(env);
  const raw = await queryAe(
    env,
    embedSiteKindsSql(dataset, window.start, nextDay(window.end)),
    EMBED_QUERY_TIMEOUT_MS,
  );
  const items = summarizeSitesForAdmin(parseHostKindRows(raw));
  const notes: string[] = [
    "Hosts come from the Referer header, which the client sets, so treat them as claims.",
  ];
  if (window.clipped)
    notes.push("Covers only the part of the selected dates the edge still keeps.");
  if (raw.length >= AE_ROW_LIMIT)
    notes.push("The edge row cap was reached; the list is incomplete.");
  if (items.length > ADMIN_ITEM_LIMIT) notes.push(`Showing the top ${ADMIN_ITEM_LIMIT} hosts.`);
  return {
    ...base,
    count: items.length,
    items: items.slice(0, ADMIN_ITEM_LIMIT),
    window: { start: window.start, end: window.end },
    note: notes.join(" "),
  };
}
