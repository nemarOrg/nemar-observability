# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

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

The local Phase 2 implementation is in progress on issue #51; completion is
subject to the focused and full repository gates recorded in the implementation
handoff.

## Phases

- [x] **P1 (nemar-cli, separate repo):** instrumentation — Analytics Engine access counters + archive-status D1 columns/webhook/sweep (nemar-cli PR #697, issue #696). Ships dark.
- [ ] **P2 Scaffold** — repo + init-project conventions + Bun/Biome/Astro-Workers stack skeleton.
- [ ] **P3 Schema** — versioned `MetricSnapshot` (JSON Schema + TS types); pull + push contribution modes. The standard.
- [ ] **P4 Worker** — snapshot compute (D1 aggregates + AE SQL), hourly cron, own D1 (`nemar-observability-db`) for history + pushed sections, API: `/api/snapshot`, `/api/snapshot/history`, `/api/drilldown/:key` (admin via `/auth/me`), `/api/sections/:key` (push).
- [ ] **P5 UI** — `/observability` page: section cards, metric tiles (number + % + severity), tile -> drill-down (admin API key in localStorage), access table, sparkline trends. Reuse website Base layout + tokens.
- [ ] **P6 Deploy** — SCCN dev then prod; `nemar-observability-db` migrations; route `dashboard.nemar.org/observability*`; verify counts vs `/admin/stats`, drilldown auth, access metrics, hourly cron.
- [ ] **P7 Docs** — README (schema + how to plug in a pipeline); cross-repo follow-up: nemarDatasets/.github `run-generate-archive.yml` archive-ready callback.

## Cross-project follow-ups

- [ ] **Per-section ingest authorization (issue #51)** — section-keyed tokens are
      configured with `OBS_INGEST_TOKENS_JSON`; no endpoint-wide fallback exists. Provision
      the secret map before enabling the Umami `website` or S3-egress pusher. The implementation
      is in the local Phase 2 branch and still needs review, CI, and owner approval before merge.
- [ ] **Usage time-series and dashboard substrate (issue #51)** — controls provide 7/30/90/365
      day presets, custom UTC dates, and day/week/month grouping over additive daily count or
      byte series. The browser requests daily points for the chosen range; incomplete or
      out-of-coverage buckets remain gaps. The 30-day access snapshot is not treated as a trend.
      Future browser-source work adds archive redirects; Zarr opens, Worker-served chunks, and S3
      chunk redirects as separate series; citation clicks; and viewer interactions. Label request
      counts, completed downloads, anonymous sessions, and bytes according
      to what each source measures; never present request counts as people or mix analytics
      planes on one series. Do not sum daily unique-session counts to claim range-wide uniques.
- [ ] **Storage egress accounting (issue #59; implementation in progress)** — a separate follow-up beyond the Umami setup. Collect the
      existing `AWS/S3:BytesDownloaded` metric for bucket `nemar` in `us-east-2` and chart the
      bucket-wide response bytes at daily resolution. Include conversion reads in this total and
      label it as S3 bytes downloaded. Weekly, monthly, and custom views should roll up the daily
      points. No S3 caller, machine, or location attribution is needed. Keep this series separate
      from Cloudflare edge bytes and Worker-observed bytes; use Umami, Cloudflare, and API
      analytics for website/API use and access-location questions. No billing reconciliation is
      needed. Show coverage and freshness; represent missing telemetry as unknown, not zero.
      A fresh `GetMetricData` query succeeded on nemaring on 2026-09-26 through the local
      Infisical listener: the planned 2026-08-01 UTC backfill returned all 56 expected daily
      points through 2026-09-25, totaling 386,294,472,966,476 bytes
      (386.294 TB decimal). The public Infisical host returns HTTP 302
      through Cloudflare Access; `http://127.0.0.1:8080` returns 200 and injects the scoped AWS
      secrets. The initial tracker backfill now starts at 2026-08-01 UTC; daily runs continue to
      refresh the latest 14 days. The collector wrapper uses loopback. The
      section-ingest token is not yet in the Infisical path and the scheduled
      push remains pending deployment of the section-keyed ingest
      API and completion of the live dashboard acceptance; details are in `.context/phase4-plan.md`
      and `.context/research.md`.
- [ ] **Website and viewer use** — query self-hosted Umami page/session analytics and add
      anonymous custom events for citation clicks, viewer opens, and viewer interactions.
      Prioritize usage counts and trends; treat time-on-page as optional context. Show citation
      click events and the number of anonymous sessions that clicked, not an identified-person
      count. Use Umami, Cloudflare, and API analytics for website/API access patterns and
      location; keep individual session details in Umami's admin surface. A browser download
      event is intent, not proof of completed bytes.

## v1 metric catalog (all derivable now)

| Section | Tiles | Drill-down (admin) |
|---|---|---|
| datasets | total/catalog, public%, private, with-DOI%, by-license, by-modality, total bytes | — |
| archive | with-archive%, pending, failed | missing / failed |
| zarr | ready%, pending (processing), failed, total stores | pending / failed |
| sync | synced, pending, failed | failed |
| publication | open requests, prescreen-failed | requests / failed |
| access (30d) | downloads, zarr reads, bytes, top-N | top-N |
| users (admin) | pending, approved, active tokens | pending |
