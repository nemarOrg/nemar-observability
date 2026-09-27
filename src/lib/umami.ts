import type { Bindings } from "../types";
import type { AudienceCoverage, AudienceSourceStatus, CountryRow } from "./audience";

const REQUEST_TIMEOUT_MS = 8_000;

export interface UmamiAudience {
  status: AudienceSourceStatus;
  coverage: AudienceCoverage | null;
  visitors: number | null;
  visits: number | null;
  pageviews: number | null;
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
    visitors: null,
    visits: null,
    pageviews: null,
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

function parseDateRange(value: unknown): UmamiDateRange | null {
  if (!isRecord(value) || !isCount(value.startAt) || !isCount(value.endAt)) return null;
  if (value.startAt > value.endAt) return null;
  return { startAt: value.startAt, endAt: value.endAt };
}

function parseStats(value: unknown): UmamiStats | null {
  if (!isRecord(value)) return null;
  const { visitors, visits, pageviews } = value;
  if (!isCount(visitors) || !isCount(visits) || !isCount(pageviews)) return null;
  return { visitors, visits, pageviews };
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

  const coverage = { start: isoDateAt(startAt), end: isoDateAt(endAt) };
  const clipped = startAt > requestedStartAt || endAt < requestedEndAt;
  const params = { startAt: String(startAt), endAt: String(endAt) };
  const [statsResult, countryResult] = await Promise.allSettled([
    fetchJson(endpoint(base, `${websitePath}/stats`, params), apiKey),
    fetchJson(endpoint(base, `${websitePath}/metrics`, { ...params, type: "country" }), apiKey),
  ]);

  const stats = statsResult.status === "fulfilled" ? parseStats(statsResult.value) : null;
  const countries =
    countryResult.status === "fulfilled" ? parseCountryRows(countryResult.value) : null;
  const statsAvailable = stats !== null;
  const countriesAvailable = countries !== null;
  if (!statsAvailable) console.error("[audience] Umami summary request failed or was invalid");
  if (!countriesAvailable) console.error("[audience] Umami country request failed or was invalid");

  if (!statsAvailable && !countriesAvailable) {
    return emptyAudience("unavailable", "Umami data is currently unavailable.", coverage);
  }

  const status: AudienceSourceStatus =
    clipped || !statsAvailable || !countriesAvailable ? "partial" : "available";
  const notes: string[] = [];
  if (clipped) notes.push("Umami data covers only part of the selected range.");
  if (!statsAvailable) notes.push("Umami summary values are unavailable.");
  if (!countriesAvailable) notes.push("Umami country values are unavailable.");
  if (countriesAvailable) {
    notes.push(
      "Country values omit sessions without a reported country and are not an exclusive partition.",
    );
  }

  return {
    status,
    coverage,
    visitors: stats?.visitors ?? null,
    visits: stats?.visits ?? null,
    pageviews: stats?.pageviews ?? null,
    countries: countries ?? [],
    note: notes.join(" "),
  };
}
