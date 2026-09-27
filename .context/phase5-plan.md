# Phase 5: Range-aware audience and country metrics

Issue: `nemarOrg/nemar-observability#63`

Epic: `nemarOrg/nemar-observability#52`

## Goal

Show selected-range totals for recorded website activity and Cloudflare zone
requests, with country breakdowns for one completed UTC day. Keep website
session estimates and edge request counts in separate source panels. This phase
adds the public **Reach** view; it does not claim identified people, completed
downloads, or caller attribution.

## Decisions

- Add public, read-only `GET /observability/api/audience?start=YYYY-MM-DD&end=YYYY-MM-DD`.
  Validate UTC dates and the existing 3,660-day maximum. Return each source's
  status, requested range, measured coverage, observation time, and values.
- The Worker queries self-hosted Umami server-side with `UMAMI_BASE_URL`,
  `UMAMI_WEBSITE_ID`, and the secret `UMAMI_API_KEY`. The browser never sees the
  API key. The dedicated Infisical path `/observability/website` is planned but
  its presence/value are not yet verified. The confirmed `prod:/observability/egress`
  path contains AWS credentials; do not assume it holds the Umami API key. Once
  the key path is verified, install the key as a Worker secret during the
  authorized deployment workflow.
- Query Umami's website date-range endpoint before treating a selected range as
  covered. Intersect the requested range with the returned available dates.
  A range with no overlap is unavailable, not zero; a partial overlap is
  labeled partial and reports the exact measured dates.
- Use Umami `/stats` for selected-range visitors, visits, and page views, and
  `/metrics?type=country` only for a single completed UTC day. Do not fetch
  country rows for multi-day, current-day, or future-day ranges: arbitrary
  overlapping ranges and a changing current day can expose suppressed country
  cells by subtraction, while future dates have no observations yet. The existing
  day/week/month grouping selector applies to
  additive time-series only; the UI says so.
- Report the fixed, consent-gated event names `citation_click`, `viewer_open`,
  `viewer_interaction`, `upload_started`, and `upload_completed`. Query
  `/events/stats` once per event over the intersection of the selected range,
  Umami's available dates, and verified event coverage; show event counts and
  event-associated anonymous sessions as separate values. The `event_metrics`
  object reports its independent status and exact covered dates. The non-secret Worker variable
  `UMAMI_EVENTS_COVERAGE_START` must be set to the first complete UTC date
  verified for production instrumentation. Until then, event values are unknown,
  not zero. Event-associated sessions are anonymous and are not people.
- Label Umami visitors as anonymous, unique-session estimates. Umami's session
  hash changes monthly, so this is not an identified-person count. Country
  estimates are not an exclusive partition: a session may be observed in more
  than one country, and the API omits unreported country values.
- Add small-cell suppression at 10 for country rows. Group smaller rows into
  `Other / withheld` only if their combined count is at least 10; otherwise omit
  that bucket and state that small values were suppressed.
- Query Cloudflare's daily zone rollup with `countryMap` only for a single
  completed UTC day within the existing 30-day range. Use a requests-only
  query for longer or in-progress ranges. Mark ranges containing the current
  UTC day partial. Label it as requests by country, not visitors. Report
  partial coverage when the selection extends beyond Cloudflare's available
  window; report unavailable when it has no overlap. Keep its request totals
  separate from Umami sessions.
- Apply the same country suppression rule to Cloudflare request counts. Do not
  include account, machine, IP, dataset, object, or caller identifiers.
- Use the existing public cache policy for the aggregate response. Missing
  configuration or an upstream failure is represented by a per-source status;
  one source failing must not hide the other.

## Response shape

```ts
type SourceStatus = "available" | "partial" | "unconfigured" | "unavailable";
type Coverage = { start: string; end: string } | null;
type CountryRow = { label: string; value: number };

interface AudienceResponse {
  start: string;
  end: string;
  observed_at: string;
  country_breakdown_scope:
    | "single_completed_day"
    | "multi_day"
    | "in_progress_day"
    | "future_day";
  umami: {
    status: SourceStatus;
    coverage: Coverage;
    visitors: number | null;
    visits: number | null;
    pageviews: number | null;
    event_metrics: {
      status: SourceStatus;
      coverage: Coverage;
      metrics: Array<{
        name: "citation_click" | "viewer_open" | "viewer_interaction" | "upload_started" | "upload_completed";
        events: number | null;
        visitors: number | null;
      }>;
      note?: string;
    };
    countries: CountryRow[];
    suppressed_small_countries: boolean;
    note?: string;
  };
  cloudflare: {
    status: SourceStatus;
    coverage: Coverage;
    requests: number | null;
    countries: CountryRow[];
    suppressed_small_countries: boolean;
    note?: string;
  };
}
```

Use stable, non-sensitive `note` values for configuration, coverage, or
upstream failures. Do not return upstream response bodies or authentication
details. Numeric `0` means the source successfully measured a covered range;
`null` means it did not.

## Acceptance

1. Custom UTC date ranges query source-native visitor/request totals;
   country breakdowns require a single completed UTC day. Day/week/month grouping
   applies only to additive time-series and never sums distinct visitor counts.
2. Umami coverage and Cloudflare's narrower range are visible in the response
   and UI. Unknown, missing, unconfigured, partial, and measured-zero states
   remain distinguishable.
3. Umami visitors/visits and single-day country estimates are separate from
   Cloudflare request/country counts. Event counts and event-associated
   anonymous sessions use verified instrumentation coverage. Country values
   appear only for a single completed UTC day; small country groups are
   suppressed.
4. The page remains credential-free and the endpoint returns aggregate values
   only.
5. The UI updates audience summaries when the selected dates change and ignores
   stale responses from older selections.

## Operational boundary

This implementation does not install or rotate Infisical/Cloudflare secrets,
deploy the Umami instance, or claim live acceptance. Those steps require the
owner-managed Umami deployment, real-browser website acceptance, verified
`UMAMI_EVENTS_COVERAGE_START`, and the existing Phase 4 Worker deployment path.
S3 egress collection remains the separate follow-up in issue #59.
