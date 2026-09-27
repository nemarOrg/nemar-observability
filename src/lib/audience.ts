export type AudienceSourceStatus = "available" | "partial" | "unconfigured" | "unavailable";

export interface AudienceCoverage {
  start: string;
  end: string;
}

export interface CountryRow {
  label: string;
  value: number;
}

export interface AudienceResponse {
  start: string;
  end: string;
  observed_at: string;
  country_breakdown_scope: "single_completed_day" | "multi_day" | "in_progress_day" | "future_day";
  umami: {
    status: AudienceSourceStatus;
    coverage: AudienceCoverage | null;
    visitors: number | null;
    visits: number | null;
    pageviews: number | null;
    countries: CountryRow[];
    suppressed_small_countries: boolean;
    note?: string;
  };
  cloudflare: {
    status: AudienceSourceStatus;
    coverage: AudienceCoverage | null;
    requests: number | null;
    countries: CountryRow[];
    suppressed_small_countries: boolean;
    note?: string;
  };
}

export interface CountrySummary {
  countries: CountryRow[];
  suppressedSmallCountries: boolean;
  omittedUnreportedCountries: boolean;
}

/** Apply the public small-cell rule after combining duplicate source labels. */
export function summarizeCountries(rows: readonly CountryRow[]): CountrySummary {
  const totals = new Map<string, number>();
  let omittedUnreportedCountries = false;

  for (const row of rows) {
    if (!Number.isFinite(row.value) || row.value < 0) continue;
    if (row.value === 0) continue;
    const label = row.label.trim();
    if (!label) {
      omittedUnreportedCountries = true;
      continue;
    }
    totals.set(label, (totals.get(label) ?? 0) + row.value);
  }

  const countries: CountryRow[] = [];
  let smallTotal = 0;
  for (const [label, value] of totals) {
    if (value >= 10) countries.push({ label, value });
    else if (value > 0) smallTotal += value;
  }

  if (smallTotal >= 10) countries.push({ label: "Other / withheld", value: smallTotal });
  countries.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

  return {
    countries,
    suppressedSmallCountries: smallTotal > 0,
    omittedUnreportedCountries,
  };
}
