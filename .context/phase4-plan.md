# Phase 4: S3 egress series (issue #59)

## Context

The dashboard already accepts and stores additive daily byte series, then
renders them with UTC day, week, month, and custom-range controls. The remaining
work is operational collection and acceptance. On 2026-09-27, the exact-host
Cloudflare Access policy for Infisical changed to `Bypass / Everyone`, after
public signups were disabled and the administrator's passkey two-factor
authentication was verified. The public hostname now returns HTTP 200 without
an Access challenge, and the read-only service token loads the three AWS
variables through `https://infisical.nemar.org`. A fresh CloudWatch query for
2026-08-01 through 2026-09-26 UTC returned all 57 expected daily points with no
missing days, totaling 394,926,061,470,340 bytes. The Infisical path does not yet
contain `OBS_EGRESS_INGEST_TOKEN`, so no section has been pushed and the timer
must remain disabled. The earlier 2026-09-26 public-host attempt happened
before the Access policy change; do not use the local listener for this
collector. See `research.md` for the live verification receipt.

## What already exists to reuse

- `src/lib/schema.ts` validates additive daily byte series, UTC dates, unique
  points, and the section payload.
- `src/routes/api.ts` authenticates `POST /sections/:key` with the token mapped
  to that section and stores overlap replacements in the observability D1.
- `GET /timeseries` and `src/routes/ui.ts` already serve and chart the stored
  daily values; missing dates stay gaps.
- Infisical setup and the collector's separate runtime token file are
  documented in this repository's README; no separate authoritative setup
  guide has been identified.

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
- Schedule at 08:17 UTC with up to 15 minutes of randomized delay. Systemd
  `Persistent=true` catches up missed timer activations after downtime; a
  collector run that exits unsuccessfully is recorded and retried by the next
  scheduled run, which re-reads the 14-day overlap. Immediate process retries
  are omitted because the oneshot is bounded and records its failure; the
  daily overlap repairs late or missed observations.
- Keep CloudWatch S3 bytes separate from Cloudflare edge bytes, Worker request
  estimates, and Umami activity. This is an observed S3 response-body metric,
  not a deduplicated client-download or billing total.

## Verification

- Static review: Bash syntax, ShellCheck, targeted parser/window tests using an
  actual captured CloudWatch response, and `git diff --check`.
- The public Infisical hostname successfully injected the three AWS secrets and
  the read-only 57-day CloudWatch query completed with no missing daily points.
- Live section push acceptance and scheduled operation remain gated on the
  `egress` section token being stored in Infisical and configured in the
  deployed Worker, followed by a real push and verification that the API and
  chart show returned dates and gaps.
