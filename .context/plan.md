# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

## NEMAR observability dashboard epic (#52)

Last reconciled with GitHub on 2026-09-27. Core epic #52 is closed; the
remaining Umami and website items are live owner-acceptance gates, not unfinished
dashboard implementation phases.

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
- Dashboard sizing, hover, and range-map work issue #72 / PR #73 are
  closed/merged and deployed. The layout has balanced desktop widths, stacks
  on small screens, and shows date plus exact value on chart and map hover or
  keyboard focus. Cloudflare country values follow the selected range after
  per-day small-cell suppression; Umami country sessions remain one completed
  UTC day.
- Umami issue `nemarOrg/nemar-umami#1` and website issue
  `nemarOrg/website#345` remain open for owner-run service, configuration,
  privacy, and live-browser acceptance. Their implementation PRs are merged,
  but Umami is not yet running and the website tracker has not passed real-
  browser acceptance. Keep the public tunnel connector stopped until the exact
  `POST analytics.nemar.org/api/send` rate limit is verified; the available
  Cloudflare API token currently receives 403 for that rule. See those issues
  for the owner gates.
- S3 `BytesDownloaded` collection is the separate deferred follow-up in issue
  #59; it does not block the closed core usage epic. Collector and dashboard
  support are merged, and the historical read-only CloudWatch query succeeded.
  The egress token/Worker secret, live section push, timer installation, and
  end-to-end chart acceptance remain outstanding. Keep the timer disabled
  until those gates pass; see `.context/phase4-plan.md`.

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

- [ ] **Live Umami and website acceptance** — complete the owner-run service,
      privacy, backup, and credential setup in `nemarOrg/nemar-umami#1`, then
      run the real-browser consent and event checks in `nemarOrg/website#345`.
      The website tracker implementation is merged, but production website
      configuration and live acceptance remain open. Keep visitor/session,
      page-view, and event measures separate from requests and response bytes.
      Set event coverage to the first complete UTC day after production
      instrumentation is verified.
- [ ] **S3 response-byte collection (issue #59)** — after the core browser
      analytics gates, install and enable the existing collector. Query
      `AWS/S3:BytesDownloaded`, `Stat=Sum`, `Period=86400`, dimensions
      `BucketName=nemar` and `FilterId=EntireBucket`, in `us-east-2`. This is a
      bucket-wide byte total that includes conversion reads; it has no caller,
      machine, or location attribution. Keep it separate from Cloudflare and
      Worker measures. The collector must inject the scoped secrets, push a
      real section, and pass API/chart coverage checks before its timer is
      enabled. See `.context/phase4-plan.md` and issue #59.

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
