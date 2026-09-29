# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

## NEMAR observability dashboard epic (#52)

Last reconciled with GitHub and production on 2026-09-28. The dashboard
implementation phases and direct Umami API connection are deployed. Epic #52
remains open for production default-on/opt-out and event acceptance, a full UTC
day of audience coverage, and the remaining Umami operations. S3 egress issue
#59 is a separate, non-blocking follow-up.

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
  `nemarOrg/website#345` remain open for production acceptance and operations.
  On 2026-09-28, Umami and its public tunnel connector were started
  on nemaring; Cloudflare reports both `nemar-umami` and `nemar-infisical`
  tunnels healthy. The active zone rule `umami-infisical-browser-managed-challenge`
  challenges requests to non-API paths on both hosts, while leaving `/api` and
  `/api/*` unchallenged and exempting Umami's `/nmr-analytics.js` tracker. The
  Umami Access policy is now Bypass Everyone, removing Cloudflare's email gate;
  Umami's own login remains. The `nemar-observability` reporter has NEMAR-team
  View Only access. The API key, website ID, and section-scoped ingest token are
  stored under `nemar/prod:/observability/website`; the API key is installed
  as a production Worker secret. Observability PR #81 merged as
  `3cdf1f0` and its production deploy succeeded. Website PR #367 configured the
  production site ID; release `0.2.20` at `02ae7c9b` is live. Cloudflare's
  automatic Pages build did not appear for that main commit, so it was built
  from a detached worktree and deployed with the documented Wrangler Pages
  command. The direct build must receive `CF_PAGES_COMMIT_SHA` and
  `PUBLIC_UMAMI_WEBSITE_ID`; omitting them reports commit `dev` and leaves the
  tracker ID out of the browser bundle. Production `/version.json` now reports
  `0.2.20+02ae7c9b`, and `analytics.nemar.org/nmr-analytics.js` returns HTTP
  200.
  Cloudflare's Free-plan rate limiter cannot scope by host or method, so no
  `/api/send` rate limit was added: it could affect the same path on other
  hosts. That endpoint remains unchallenged and without a dedicated rate
  limit. Chrome passed Cloudflare's Managed Challenge on both public hosts and
  displayed the Umami and Infisical login pages; no credentials were entered.
  The production homepage now serves the versioned tracker bundle. After a
  real-browser reload, the audience endpoint returned Umami
  `visitors=2`, `visits=2`, and `pageviews=2` for 2026-09-28; this was a
  partial UTC day and the aggregate cannot attribute those records to one
  browser. Event metrics remain unconfigured and country coverage is not yet
  available. Website PR #365 merged the default-on/opt-out implementation into
  `staging`; release `0.2.20` is now live in production. Issue #345 remains
  open for explicit opt-out and consented-event acceptance, plus completed-day
  audience/country verification. Keep event coverage unset until one complete
  UTC day of event collection is verified. The canonical policy update is
  `nemarOrg/docs#46`; align its effective date with the production rollout and
  complete its review. The direct Worker-to-Umami API remains the source for
  range-aware audience, country, and consented-event summaries. Keep the
  separate D1 pusher unscheduled unless daily browser-activity series are
  explicitly needed; do not duplicate these source totals in D1. The initial
  epic reconciliation is PR #78. See `.context/research.md` for exact routing
  and verification details.
- S3 `BytesDownloaded` collection is the separate deferred follow-up in issue
  #59; it does not block Umami integration. The egress collector and daily
  dashboard series merged in PRs #61 and #60. PR #82 extracted shared
  CloudWatch collector code and added the separate storage-gauge section; its
  Worker changes are deployed. The historical read-only CloudWatch query
  succeeded.
  On 2026-09-28 the section ingest tokens (`egress`, `storage`, `website`)
  were added to the Worker secret `OBS_INGEST_TOKENS_JSON`, the checkout at
  `/opt/nemar-observability` on nemaring was updated to `main`, and both
  daily timers (egress 08:17 UTC, storage 08:47 UTC) were installed and
  enabled. Each service ran once and posted: egress 14 daily points through
  2026-09-27, storage 121.65 TB and about 1.35 billion objects for
  2026-09-28. Confirm the first unattended runs on 2026-09-29 (see
  `.context/phase4-plan.md`). The dashboard redesign is PR #80 and the
  matching admin portal redesign is website PR #366 (release 0.2.21).

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
      required. The production API key and website ID are configured; the
      public site is live at `0.2.20+02ae7c9b`, and the observability endpoint
      has returned nonzero audience totals for the in-progress UTC day.
      Complete explicit opt-out and consented-event checks, verify a full
      completed UTC day (including country coverage), and finish the remaining
      backup/retention operations in `nemarOrg/nemar-umami#1` and
      `nemarOrg/website#345`.
      `/api/send` remains
      unchallenged and has no dedicated rate limit: the Free-plan rate limiter
      lacks host and method fields, and a zone-wide path rule has not been
      verified safe. Keep visitor/session, page-view, and event measures
      separate from requests and response bytes. Set event coverage to the
      first complete UTC day after production instrumentation is verified.
- [ ] **S3 response-byte collection (issue #59):** the collector, secrets,
      and daily timer are installed on nemaring (2026-09-28) and the first
      manual run posted 14 daily points. Query is `AWS/S3:BytesDownloaded`,
      `Stat=Sum`, `Period=86400`, dimensions `BucketName=nemar` and
      `FilterId=EntireBucket`, in `us-east-2`: a bucket-wide byte total that
      includes conversion reads, with no caller, machine, or location
      attribution. Keep it separate from Cloudflare and Worker measures.
      Remaining: confirm the unattended 2026-09-29 run and chart coverage,
      then close issue #59.
- [ ] **S3 storage size section (`storage`):** collector
      `scripts/push-s3-storage.ts` merged in PR #82 and installed on nemaring
      with its own daily timer. It reuses the egress CloudWatch key from
      `prod:/observability/egress` and pushes gauges only (no daily series;
      trend via `/snapshot/history`). The first push succeeded; remaining is
      confirming `storage.bucket_bytes` in the public snapshot after the next
      hourly cron and on the website admin Storage card.

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
