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

const MEMO_TTL_MS = 60_000;
const MEMO_MAX = 32;
const memo = new Map<string, { at: number; lists: Promise<EmbedLists> }>();

/** Forget every memoized answer (tests). */
export function resetEmbedListsMemo(): void {
  memo.clear();
}

function isUnavailable(lists: EmbedLists): boolean {
  return lists.sites.status === "unavailable" || lists.datasets.status === "unavailable";
}

/**
 * The sites and datasets for the selected dates. Sites come back as counts only;
 * datasets are named only when public now. Answers are memoized for a minute
 * per window (a failure or a refusal is not), and an uncached load claims its
 * worst case from the shared query budget before it asks the edge anything.
 */
export async function loadEmbedLists(
  env: Bindings,
  start: string,
  end: string,
  now: Date,
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

  const key = `${env.EMBED_AE_DATASET}|${window.start}|${window.end}|${today}|${websiteBase(env)}`;
  const hit = memo.get(key);
  if (hit && now.getTime() - hit.at < MEMO_TTL_MS) return hit.lists;
  const preset = isPresetRange(start, end, now);
  const lists = preset
    ? loadSharedPreset(env, start, end, window, now)
    : computeLists(env, start, end, window, now);
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(key, { at: now.getTime(), lists });
  const settled = await lists;
  // Only a good answer is worth keeping.
  if (isUnavailable(settled) && memo.get(key)?.lists === lists) memo.delete(key);
  return settled;
}

/**
 * A preset window's answer, shared across isolates through D1 for up to the
 * memo's 60 seconds: a fresh row answers it with no budget and no query, and an
 * isolate that computes one stores it for the others. So the preset pool's demand
 * is the number of distinct preset windows a minute, not that times the isolates.
 * A read or write that fails is logged and skipped: it costs a recomputation, which
 * the budget still bounds.
 */
async function loadSharedPreset(
  env: Bindings,
  start: string,
  end: string,
  window: { start: string; end: string; clipped: boolean },
  now: Date,
): Promise<EmbedLists> {
  const key = presetKey(env, window, now);
  try {
    const shared = await readPresetAnswer(env.OBS_DB, key, now, MEMO_TTL_MS);
    if (shared) {
      const parsed = JSON.parse(shared) as EmbedLists;
      if (parsed?.sites && parsed?.datasets) return parsed;
    }
  } catch (err) {
    console.error("[embeds] shared preset answer could not be read:", String(err).slice(0, 120));
  }
  const lists = await computeLists(env, start, end, window, now);
  if (!isUnavailable(lists)) {
    try {
      await writePresetAnswer(env.OBS_DB, key, JSON.stringify(lists), now);
    } catch (err) {
      console.error(
        "[embeds] shared preset answer could not be stored:",
        String(err).slice(0, 120),
      );
    }
  }
  return lists;
}

const presetKey = (env: Bindings, window: { start: string; end: string }, now: Date): string =>
  `${env.EMBED_AE_DATASET}|${window.start}|${window.end}|${dayOf(now.getTime())}|${websiteBase(env)}`;

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
): Promise<EmbedLists> {
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
    return bothBlocks("unavailable", "Embed detail is currently unavailable.");
  }
  if (!claimed) return bothBlocks("unavailable", BUSY_NOTE);

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
    return bothBlocks("unavailable", "Embed detail is currently unavailable.");
  }

  const today = dayOf(now.getTime());
  const status: EmbedSourceStatus = window.clipped || window.end >= today ? "partial" : "available";
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

  const sites: EmbedListBlock<EmbedSiteCounts> = {
    ...shared,
    summary: summarizeEmbedSites(siteRows, total, capped),
  };
  // The public check is the privacy boundary: if nemar-db cannot answer, no
  // dataset is named, rather than every dataset.
  let datasets: EmbedListBlock<EmbedDatasetSummary>;
  try {
    const publicIds = await publicDatasetIds(
      env.NEMAR_DB,
      datasetRows.map((r) => r.dataset_id).filter(Boolean),
    );
    datasets = {
      ...shared,
      summary: summarizeEmbedDatasets(datasetRows, publicIds, total, websiteBase(env)),
    };
  } catch (err) {
    console.error("[embeds] public dataset check failed:", err);
    datasets = emptyBlock("unavailable", "Embedded datasets are currently unavailable.");
  }
  return { sites, datasets };
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
