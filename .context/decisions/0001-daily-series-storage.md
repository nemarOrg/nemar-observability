# ADR 0001: Store source-backed daily series separately

**Status:** accepted

**Date:** 2026-09-26

**Owner:** NEMAR Observability maintainers

## Context

Hourly snapshots cannot provide durable daily points or arbitrary date ranges,
and copying daily values into every snapshot would multiply storage while
preserving the wrong aggregation semantics. The dashboard is public and has no
credential, so it cannot query Umami or AWS directly. Missing telemetry must
remain distinguishable from a measured zero.

## Decision

Collectors push additive UTC daily series with their section, authenticated by
a token map keyed to that section. The Worker stores series and coverage
metadata in its own D1, exposes a read-only aggregate endpoint, and lets the
browser group known daily values into weeks or months. Missing values remain
unknown; non-additive unique-visitor counts are excluded from rollups.

## Consequences

The dashboard needs a D1 migration and rotating per-section credentials.
Collectors must send replacement values for overlapping days and declare
coverage. Ingest is bounded to a 1 MB body, 16 series, and 5,000 daily points
per section push; a series can contain at most 3,660 points. Persisted coverage
is the union of observed source-window bounds, so
an incremental or rolling-window push cannot hide older stored observations.
The series endpoint remains public but returns aggregate data only;
source API keys, identities, and dataset IDs never enter the page. Series are
not embedded in hourly snapshots, so callers use the dedicated endpoint.

## Alternatives considered

- **Embed series in snapshots:** rejected because hourly copies inflate storage
  and cannot accurately represent source coverage or arbitrary ranges.
- **Query Umami or AWS from the browser:** rejected because it would expose
  source credentials and couple the dashboard to source-specific APIs.
- **Fill absent days with zero:** rejected because an absent point may indicate
  delayed or failed telemetry rather than no usage.

## Receipts

- Epic requirements captured in `.context/plan.md` and `.context/research.md`.
- Umami supports date-bounded daily pageview/session time series:
  https://docs.umami.is/docs/api-reference/get-website-pageviews
- Cloudflare recommends remotely managed tunnels for most deployments:
  https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/
