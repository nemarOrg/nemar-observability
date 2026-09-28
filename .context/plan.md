# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

## NEMAR observability dashboard epic (#52)

Last reconciled with GitHub on 2026-09-27. Epic #52 is closed.

- Issue #51 and daily-series/API work PR #60 are closed/merged. Per-section
  ingest authorization is deployed; each producer still needs its own token
  configured.
- Issue #62 and question-led usage layout PR #64 are closed/merged at
  `91a4306`; its production deployment succeeded. Usage charts and the latest
  dataset/pipeline state remain separate.
- Issue #63 and range-aware visitor/country metrics PR #65 are closed/merged.
- Follow-up fixes PR #66 (stale-series visibility) and PR #67 (Cloudflare byte
  labels) are merged to `main`.
- Country-map and question-led clarity work issue #69 and PRs #70-#71 are
  closed/merged. The map uses vendored country boundaries and preserves small
  locations with point markers.
- Umami issue `nemarOrg/nemar-umami#1` and website issue
  `nemarOrg/website#345` remain open for owner-run service, configuration,
  privacy, and live-browser acceptance. Their implementation PRs #2-#6 and
  #363 have merged; see those issues for remaining gates.
- S3 `BytesDownloaded` collection is the separate active follow-up in issue
  #59. It does not block the closed core usage epic.

The first dashboard implementation (schema, Worker/API, UI, D1 history, cron,
deployment, and docs) is already on `main`; the old P2-P7 scaffold checklist is
not an active backlog. Recheck issue/PR, CI, deployment, and machine access
before external operations. Preserve source definitions and caveats in
`.context/research.md` and range API/coverage decisions in
`.context/phase5-plan.md`.

## Phase 2: daily usage series and dashboard (issue #51)

Implementation contract: section-keyed credentials are supplied through
`OBS_INGEST_TOKENS_JSON`; there is no legacy endpoint-wide token fallback.
Optional pushed series are additive UTC counts or bytes and are persisted in
the observability Worker's own D1, separate from hourly snapshots. Overlapping
daily observations replace prior values. The public range API returns daily
points and metadata only. The browser groups UTC daily observations by day,
week, or month; a bucket with any missing or out-of-coverage date is a chart
gap. Partial first and last buckets require only dates inside the selected
range. Unique visitors and other non-additive metrics are excluded.

The daily series contract is shipped: the API stores additive UTC counts or
bytes in the observability Worker's D1, overlapping observations replace prior
values, and the browser can group covered daily values by day, week, or month
for preset and custom UTC ranges. A date with no source observation remains a
gap. Visitor/session totals are queried for the selected range and are never
summed across buckets as unique people.

## Active follow-ups

- [ ] **Dashboard sizing, hover, and range map (issue #72)** — balance chart
      and map widths; show UTC period and exact value on hover/focus; have the
      Cloudflare map follow the selected range, suppressing small cells per
      completed day before aggregation. Keep Umami country sessions to one
      completed day because distinct sessions are not additive. S3 response
      bytes remain bucket-wide across NEMAR data planes, include internal
      conversion reads, and have no country attribution, so do not place them
      on the map.
- [ ] **S3 response-byte collection (issue #59)** — the collector and systemd
      units from PR #61 are in the repo, but the timer is not installed or
      enabled. Query `AWS/S3:BytesDownloaded`, `Stat=Sum`, `Period=86400`,
      `BucketName=nemar`, `FilterId=EntireBucket`, in `us-east-2`. These are
      bucket-wide response bytes, including conversion reads; they cannot
      identify a caller, machine, or location. Keep them separate from
      Cloudflare edge bytes and Worker-observed bytes. There is no billing
      reconciliation requirement.
      The 2026-08-01 through 2026-09-26 UTC CloudWatch backfill returned all 57
      expected daily points, totaling 394,926,061,470,340 bytes (394.926 TB
      decimal); this is a source query, not yet a dashboard series.
      Nemaring now reads AWS secrets from `https://infisical.nemar.org` through
      the existing tunnel. The exact-host Cloudflare Access app is
      `Bypass / Everyone`; the public API status check returned HTTP 200 with
      no redirect. Infisical still authenticates its scoped service token;
      public signup is disabled and administrator passkey MFA is enabled. Do
      not route this collector through loopback or claim Cloudflare Access
      continues to protect the Infisical hostname.
      Activation is gated on an `egress` section token in Infisical and the
      corresponding `OBS_INGEST_TOKENS_JSON` production Worker secret, then a
      real section push and chart verification. Both are currently missing;
      keep the timer disabled until these gates pass. Details and verification
      receipts are in `.context/phase4-plan.md` and `.context/research.md`.
- [ ] **Website and viewer interaction analytics** — website issue #345 is
      still open. PR #363 is merged; the consent-gated tracker emits generic
      page categories and fixed citation/viewer/upload events without
      identifiers, URLs, or event properties. Umami deployment issue
      `nemarOrg/nemar-umami#1` also remains open for owner-run service setup,
      Access/rate-limit checks, credentials, backup, and live ingestion. Keep
      these anonymous browser/event metrics separate from S3 bytes, server
      requests, and distinct visitors. Follow both issues for their acceptance
      gates.

## v1 metric catalog (all derivable now)

| Section | Tiles | Drill-down (admin) |
|---|---|---|
| datasets | total/catalog, public%, private, with-DOI%, by-license, by-modality, total bytes | — |
| archive | with-archive%, pending, failed | missing / failed |
| zarr | ready%, pending (processing), failed, total stores | pending / failed |
| sync | reserved; retired with nemar-cli migration 0053 | — |
| publication | open requests, prescreen-failed | requests / failed |
| access (30d) | downloads, zarr reads, bytes, top-N | top-N |
| users (admin) | pending, approved, active tokens | pending |
