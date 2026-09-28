# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

## NEMAR observability dashboard epic (#52)

Last reconciled with GitHub on 2026-09-28. Core epic #52 is closed; the
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
  `nemarOrg/website#345` remain open for owner-run configuration and
  acceptance. On 2026-09-28, Umami and its public tunnel connector were started
  on nemaring; Cloudflare reports both `nemar-umami` and `nemar-infisical`
  tunnels healthy. The active zone rule `umami-infisical-browser-managed-challenge`
  challenges requests to non-API paths on both hosts, while leaving `/api` and
  `/api/*` unchallenged and exempting Umami's `/nmr-analytics.js` tracker. The
  Umami Access policy is now Bypass Everyone, removing Cloudflare's email gate;
  Umami's own login remains. Infisical already had Bypass Everyone, and the
  local Infisical CLI successfully queried the self-hosted instance.
  Cloudflare's Free-plan rate limiter cannot scope by host or method, so no
  `/api/send` rate limit was added: it could affect the same path on other
  hosts. That endpoint remains unchallenged and without a dedicated rate
  limit. Chrome passed Cloudflare's Managed Challenge on both public hosts and
  displayed the Umami and Infisical login pages; no credentials were entered.
  The website tracker still needs real-browser acceptance under the default-on
  anonymous analytics policy in `nemarOrg/website#345`: no saved preference
  enables tracking only on configured production hosts and allowlisted pages,
  including the signed-in upload flow; the saved opt-out disables it. The
  implementation PR `nemarOrg/website#365` merged into `staging` on 2026-09-28
  as `b6a1489`. The staging deploy workflow (#36449749794) succeeded, and
  `test.nemar.org` returned HTTP 200 with the updated notice. This is staging
  only; production Umami property setup and real-browser acceptance remain
  open in issue #345. The canonical policy update is draft
  `nemarOrg/docs#46`, targeting `main`; hold it until the matching production
  website behavior ships, and update its effective date if rollout slips. The
  initial epic reconciliation is PR #78. See `.context/research.md` for exact
  routing and verification details.
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

- [ ] **Live Umami and website acceptance** — Umami and both Cloudflare tunnel
      connectors are running; `analytics.nemar.org` and `infisical.nemar.org`
      have host-scoped Managed Challenge on non-API paths. Umami's
      Cloudflare Access policy is Bypass Everyone, with Umami's own login still
      required. The default-on/opt-out website code is merged to `staging` and
      deployed to `test.nemar.org`; complete initial-admin/signup setup,
      website provisioning, backup/retention schedules, and the production
      real-browser default-on/opt-out and event checks in
      `nemarOrg/nemar-umami#1` and `nemarOrg/website#345`.
      `/api/send` remains
      unchallenged and has no dedicated rate limit: the Free-plan rate limiter
      lacks host and method fields, and a zone-wide path rule has not been
      verified safe. Keep visitor/session, page-view, and event measures
      separate from requests and response bytes. Set event coverage to the
      first complete UTC day after production instrumentation is verified.
- [ ] **S3 response-byte collection (issue #59)** — after the core browser
      analytics gates, install and enable the existing collector. Query
      `AWS/S3:BytesDownloaded`, `Stat=Sum`, `Period=86400`, dimensions
      `BucketName=nemar` and `FilterId=EntireBucket`, in `us-east-2`. This is a
      bucket-wide byte total that includes conversion reads; it has no caller,
      machine, or location attribution. Keep it separate from Cloudflare and
      Worker measures. The collector must inject the scoped secrets, push a
      real section, and pass API/chart coverage checks before its timer is
      enabled. See `.context/phase4-plan.md` and issue #59.
- [ ] **S3 storage size section (`storage`):** collector
      `scripts/push-s3-storage.ts`, units, and tests are on branch
      `feat/s3-storage-section`. It reuses the egress CloudWatch key from
      `prod:/observability/egress` and pushes gauges only (no daily series;
      trend via `/snapshot/history`). Operator steps still open: add
      `OBS_STORAGE_INGEST_TOKEN` to that Infisical path, add the same value as
      `storage` in `OBS_INGEST_TOKENS_JSON`, then run the combined nemaring
      install block in the README and confirm `storage.bucket_bytes` in the
      snapshot.

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
