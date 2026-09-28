import type { Bindings } from "../types";
import {
  type AudienceCoverage,
  type AudienceSourceStatus,
  type CountryRow,
  UMAMI_EVENT_NAMES,
  type UmamiEventReport,
  emptyUmamiEventReport,
} from "./audience";

const REQUEST_TIMEOUT_MS = 8_000;

export interface UmamiAudience {
  status: AudienceSourceStatus;
  coverage: AudienceCoverage | null;
  country_coverage: AudienceCoverage | null;
  visitors: number | null;
  visits: number | null;
  pageviews: number | null;
  event_metrics: UmamiEventReport;
  countries: CountryRow[];
  note?: string;
}

interface UmamiDateRange {
  startAt: number;
  endAt: number;
}

interface UmamiStats {
  visitors: number;
  visits: number;
  pageviews: number;
}

function emptyAudience(
  status: AudienceSourceStatus,
  note: string,
  coverage: AudienceCoverage | null = null,
): UmamiAudience {
  return {
    status,
    coverage,
    country_coverage: null,
    visitors: null,
    visits: null,
    pageviews: null,
    event_metrics: emptyUmamiEventReport(
      status,
      status === "unconfigured"
        ? "Umami event reporting is not configured."
        : "Umami event data is unavailable because the Umami source is unavailable.",
      coverage,
    ),
    countries: [],
    note,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCount(value: unknown): number | null {
  if (isCount(value)) return value;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseIsoDateBound(value: unknown, endOfDate: boolean): number | null {
  if (typeof value !== "string") return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
      return null;
    }
    return endOfDate ? timestamp + 86_400_000 - 1 : timestamp;
  }

  const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
  if (!isoDateTime.test(value)) return null;
  const datePart = value.slice(0, 10);
  const midnight = Date.parse(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== datePart) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseDateRange(value: unknown): UmamiDateRange | null {
  if (!isRecord(value)) return null;
  let startAt: number | null = null;
  let endAt: number | null = null;
  if (isCount(value.startAt) && isCount(value.endAt)) {
    startAt = value.startAt;
    endAt = value.endAt;
  } else {
    startAt = parseIsoDateBound(value.startDate, false);
    endAt = parseIsoDateBound(value.endDate, true);
  }
  if (startAt === null || endAt === null || startAt > endAt) return null;
  return { startAt, endAt };
}

function parseStats(value: unknown): UmamiStats | null {
  if (!isRecord(value)) return null;
  const { visitors, visits, pageviews } = value;
  if (!isCount(visitors) || !isCount(visits) || !isCount(pageviews)) return null;
  return { visitors, visits, pageviews };
}

function parseEventStats(value: unknown): { events: number; visitors: number } | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const events = parseCount(value.data.events);
  const visitors = parseCount(value.data.visitors);
  return events === null || visitors === null ? null : { events, visitors };
}

function parseCountryRows(value: unknown): CountryRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: CountryRow[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isCount(item.y)) return null;
    if (item.x !== null && typeof item.x !== "string") return null;
    rows.push({ label: typeof item.x === "string" ? item.x : "", value: item.y });
  }
  return rows;
}

function dateAtUtcMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function isoDateAt(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseEventCoverageStart(value: unknown): number | null {
  const startAt = parseIsoDateBound(value, false);
  return startAt !== null && typeof value === "string" && isoDateAt(startAt) === value
    ? startAt
    : null;
}

async function fetchEventReport(
  env: Bindings,
  base: URL,
  websitePath: string,
  apiKey: string,
  requestedStartAt: number,
  requestedEndAt: number,
  available: UmamiDateRange,
): Promise<UmamiEventReport> {
  const configuredStart = env.UMAMI_EVENTS_COVERAGE_START?.trim();
  if (!configuredStart) {
    return emptyUmamiEventReport(
      "unconfigured",
      "Consent-gated event metrics need a verified coverage start date.",
    );
  }
  const eventCoverageStartAt = parseEventCoverageStart(configuredStart);
  if (eventCoverageStartAt === null) {
    console.error("[audience] Umami event coverage start configuration is invalid");
    return emptyUmamiEventReport("unavailable", "Umami event coverage is currently unavailable.");
  }

  const startAt = Math.max(requestedStartAt, available.startAt, eventCoverageStartAt);
  const endAt = Math.min(requestedEndAt, available.endAt);
  if (startAt > endAt) {
    return emptyUmamiEventReport(
      "unavailable",
      "The selected range does not overlap verified event coverage.",
    );
  }

  const coverage = { start: isoDateAt(startAt), end: isoDateAt(endAt) };
  const clipped = startAt > requestedStartAt || endAt < requestedEndAt;
  const params = { startAt: String(startAt), endAt: String(endAt) };
  const results = await Promise.allSettled(
    UMAMI_EVENT_NAMES.map(async (name) => {
      const response = await fetchJson(
        endpoint(base, `${websitePath}/events/stats`, { ...params, event: name }),
        apiKey,
      );
      return { name, stats: parseEventStats(response) };
    }),
  );

  let successful = 0;
  const metrics = results.map((result, index) => {
    const name = UMAMI_EVENT_NAMES[index];
    if (result.status === "rejected" || !result.value.stats) {
      console.error(`[audience] Umami event request failed or was invalid: ${name}`);
      return { name, events: null, visitors: null };
    }
    successful++;
    return { name, ...result.value.stats };
  });
  const status: AudienceSourceStatus =
    successful === 0
      ? "unavailable"
      : clipped || successful < UMAMI_EVENT_NAMES.length
        ? "partial"
        : "available";
  const notes: string[] = [
    "Event-associated visitors are distinct anonymous Umami sessions, not identified people.",
  ];
  if (clipped) notes.push("Event values cover only the verified portion of the selected range.");
  if (successful < UMAMI_EVENT_NAMES.length) notes.push("Some event metrics are unavailable.");
  return { status, coverage, metrics, note: notes.join(" ") };
}

function isSafeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function endpoint(base: URL, path: string, params: Record<string, string> = {}): URL {
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${prefix}${path}`, base.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function fetchJson(url: URL, apiKey: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Umami request failed");
  return (await response.json()) as unknown;
}

/** Fetch selected-range totals and country metrics without exposing the API key. */
export async function fetchUmamiAudience(
  env: Bindings,
  requestedStart: string,
  requestedEnd: string,
  includeCountryBreakdown = true,
): Promise<UmamiAudience> {
  const baseUrl = env.UMAMI_BASE_URL?.trim();
  const websiteId = env.UMAMI_WEBSITE_ID?.trim();
  const apiKey = env.UMAMI_API_KEY?.trim();
  if (!baseUrl || !websiteId || !apiKey) {
    return emptyAudience("unconfigured", "Umami audience reporting is not configured.");
  }

  const base = isSafeBaseUrl(baseUrl);
  if (!base) {
    console.error("[audience] Umami base URL configuration is invalid");
    return emptyAudience("unavailable", "Umami data is currently unavailable.");
  }

  const websitePath = `/api/websites/${encodeURIComponent(websiteId)}`;
  let available: UmamiDateRange | null;
  try {
    const range = await fetchJson(endpoint(base, `${websitePath}/daterange`), apiKey);
    available = parseDateRange(range);
  } catch {
    console.error("[audience] Umami date-range request failed");
    return emptyAudience("unavailable", "Umami data is currently unavailable.");
  }
  if (!available) {
    console.error("[audience] Umami date-range response was invalid");
    return emptyAudience("unavailable", "Umami data is currently unavailable.");
  }

  const requestedStartAt = dateAtUtcMidnight(requestedStart);
  const requestedEndAt = dateAtUtcMidnight(requestedEnd) + 86_400_000 - 1;
  const startAt = Math.max(requestedStartAt, available.startAt);
  const endAt = Math.min(requestedEndAt, available.endAt);
  if (startAt > endAt) {
    return emptyAudience("unavailable", "No Umami data overlaps the selected range.");
  }

  const eventMetricsPromise = fetchEventReport(
    env,
    base,
    websitePath,
    apiKey,
    requestedStartAt,
    requestedEndAt,
    available,
  );

  const coverage = { start: isoDateAt(startAt), end: isoDateAt(endAt) };
  const clipped = startAt > requestedStartAt || endAt < requestedEndAt;
  const canQueryCountryBreakdown =
    includeCountryBreakdown && startAt === requestedStartAt && endAt === requestedEndAt;
  const params = { startAt: String(startAt), endAt: String(endAt) };
  const [[statsResult, countryResult], eventMetrics] = await Promise.all([
    Promise.allSettled([
      fetchJson(endpoint(base, `${websitePath}/stats`, params), apiKey),
      canQueryCountryBreakdown
        ? fetchJson(
            endpoint(base, `${websitePath}/metrics`, { ...params, type: "country" }),
            apiKey,
          )
        : Promise.resolve(null),
    ]),
    eventMetricsPromise,
  ]);

  const stats = statsResult.status === "fulfilled" ? parseStats(statsResult.value) : null;
  const countries =
    canQueryCountryBreakdown && countryResult.status === "fulfilled"
      ? parseCountryRows(countryResult.value)
      : null;
  const statsAvailable = stats !== null;
  const countriesAvailable =
    !includeCountryBreakdown || (canQueryCountryBreakdown && countries !== null);
  if (!statsAvailable) console.error("[audience] Umami summary request failed or was invalid");
  if (includeCountryBreakdown && !countriesAvailable && canQueryCountryBreakdown) {
    console.error("[audience] Umami country request failed or was invalid");
  }

  if (!statsAvailable && (!includeCountryBreakdown || !countriesAvailable)) {
    return {
      ...emptyAudience("unavailable", "Umami data is currently unavailable.", coverage),
      event_metrics: eventMetrics,
    };
  }

  const status: AudienceSourceStatus =
    clipped || !statsAvailable || !countriesAvailable ? "partial" : "available";
  const notes: string[] = [];
  if (clipped) notes.push("Umami data covers only part of the selected range.");
  if (!statsAvailable) notes.push("Umami summary values are unavailable.");
  if (includeCountryBreakdown && !countriesAvailable) {
    notes.push(
      canQueryCountryBreakdown
        ? "Umami country values are unavailable."
        : "Umami country values are unavailable because source coverage does not include the full selected UTC day.",
    );
  }
  if (includeCountryBreakdown && countriesAvailable) {
    notes.push(
      "Country values omit sessions without a reported country and are not an exclusive partition.",
    );
  }

  return {
    status,
    coverage,
    country_coverage: canQueryCountryBreakdown && countriesAvailable ? coverage : null,
    visitors: stats?.visitors ?? null,
    visits: stats?.visits ?? null,
    pageviews: stats?.pageviews ?? null,
    event_metrics: eventMetrics,
    countries: countries ?? [],
    note: notes.join(" "),
  };
}
