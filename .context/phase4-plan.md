# Phase 4: S3 egress series (issue #59)

## Context

The dashboard already accepts and stores additive daily byte series, then
renders them with UTC day, week, month, and custom-range controls. The
remaining work is to collect the existing bucket-wide CloudWatch request metric
and push it through the section-keyed ingest endpoint. The first machine-side
attempt on 2026-09-26 used the public Infisical hostname and loaded no variables.
A later run through the local listener loaded the scoped AWS credentials and a
fresh daily CloudWatch query succeeded; see `research.md` for the evidence. The
2026-08-01 UTC backfill window returned all 56 expected daily points through
2026-09-25, with no missing days and 386.294 TB decimal total. The
collector has not yet pushed a section or run on its schedule. The Infisical UI
confirms the AWS secrets exist in project `nemar` (ID
`817f7473-a318-4e99-9cf4-a89db057f5fc`), production environment `prod`
(`api.nemar.org`), and path `/observability/egress`; it also lists the scoped
read-only token. On nemaring, the public API returns HTTP 302 through Cloudflare
Access while `http://127.0.0.1:8080/api/status` returns 200. Using that loopback
domain with the token injects exactly the three AWS variables. Keep the CLI on
loopback; the separate section-ingest token is still required before a push.

## What already exists to reuse

- `src/lib/schema.ts` validates additive daily byte series, UTC dates, unique
  points, and the section payload.
- `src/routes/api.ts` authenticates `POST /sections/:key` with the token mapped
  to that section and stores overlap replacements in the observability D1.
- `GET /timeseries` and `src/routes/ui.ts` already serve and chart the stored
  daily values; missing dates stay gaps.
- Infisical path-scoped read-token material is documented in the sibling
  `nemar-umami` repository; this collector will keep its runtime token file
  separate from the AWS access keys stored in Infisical.

## Approach

Run a small Bun collector on nemaring once daily. It asks AWS CLI v2 for
`AWS/S3:BytesDownloaded`, statistic `Sum`, period `86400`, and the fixed
dimensions `BucketName=nemar` and `FilterId=EntireBucket` in `us-east-2`. Both
query bounds are UTC midnights and the end is exclusive, so only complete UTC
days are requested. The operator runs a one-time backfill from 2026-08-01 UTC,
then the daily timer re-reads a 14-day rolling window to replace late-corrected
observations without querying the full history each day. Returned dates are
published as-is: absent dates are never converted to zeros. The collector
publishes one clearly dated latest-observed-day headline plus the complete
returned daily series.

Infisical supplies only the `/observability/egress` path to the command. The
wrapper checks its own read token file and permissions; the collector requires
the expected AWS keys, region, and section-ingest token; AWS CLI profile files,
metadata credentials, and alternate regions are disabled. A systemd oneshot
and persistent daily timer provide scheduled collection. The collector does
not change the bucket metrics configuration, IAM policy, Cloudflare, or Worker.

## Decision gate

The implementation is ready for operational enablement only when one run on
nemaring proves all of the following: Infisical injects the three expected AWS
variables and the section token; `GetMetricData` returns a complete response
for the fixed metric and dimensions; the posted section is accepted; the
timeseries API shows the returned UTC days; and the dashboard preserves any
missing days as gaps. A failed query publishes an error-status metric when the
section token and dashboard are still available, without replacing daily
points; otherwise the last series ages stale and the failure is in systemd's
journal. If any acceptance condition fails, keep the timer disabled and record
the failure without publishing zeros or claiming coverage.

## Prerequisites

- Infisical must make `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
  `AWS_REGION=us-east-2` available to the scoped read token.
- After the dashboard's section-keyed ingest token map is deployed, the same
  Infisical path also needs `OBS_EGRESS_INGEST_TOKEN` for section `egress`.
- nemaring needs Bun, AWS CLI v2, and Infisical CLI installed.
- The existing `EntireBucket` CloudWatch request-metrics configuration must
  remain enabled; this phase does not create or modify it.

## Open judgment calls resolved for this phase

- Start the initial backfill at 2026-08-01 UTC using `EGRESS_START_DATE`, then
  use a 14-day repeated query instead of maintaining local collector state;
  the dashboard stores overlap replacements and remains the source of chart
  history.
- Set series freshness to 36 hours for a daily collector and label the
  headline as the latest reported UTC day so delayed or older observations
  cannot be mistaken for a rolling total.
- Run at 08:17 UTC daily with systemd `Persistent=true`; a missed host run is
  retried after the host returns.
- Keep CloudWatch S3 bytes separate from Cloudflare edge bytes, Worker request
  estimates, and Umami activity. This is an observed S3 response-body metric,
  not a deduplicated client-download or billing total.

## Verification

- Static review: Bash syntax, ShellCheck, and `git diff --check`.
- No synthetic or mocked CloudWatch results are used.
- Live query and push acceptance remain gated on resolving the current
  Infisical zero-secret response and provisioning the section token after the
  dashboard phase is deployed.
