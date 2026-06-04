# nemar-observability Development Plan

Epic: nemarOrg/nemar-cli#695. This repo covers Phases 2-7.

## Phases

- [x] **P1 (nemar-cli, separate repo):** instrumentation — Analytics Engine access counters + archive-status D1 columns/webhook/sweep (nemar-cli PR #697, issue #696). Ships dark.
- [ ] **P2 Scaffold** — repo + init-project conventions + Bun/Biome/Astro-Workers stack skeleton.
- [ ] **P3 Schema** — versioned `MetricSnapshot` (JSON Schema + TS types); pull + push contribution modes. The standard.
- [ ] **P4 Worker** — snapshot compute (D1 aggregates + AE SQL), hourly cron, own D1 (`nemar-observability-db`) for history + pushed sections, API: `/api/snapshot`, `/api/snapshot/history`, `/api/drilldown/:key` (admin via `/auth/me`), `/api/sections/:key` (push).
- [ ] **P5 UI** — `/observability` page: section cards, metric tiles (number + % + severity), tile -> drill-down (admin API key in localStorage), access table, sparkline trends. Reuse website Base layout + tokens.
- [ ] **P6 Deploy** — SCCN dev then prod; `nemar-observability-db` migrations; route `dashboard.nemar.org/observability*`; verify counts vs `/admin/stats`, drilldown auth, access metrics, hourly cron.
- [ ] **P7 Docs** — README (schema + how to plug in a pipeline); cross-repo follow-up: nemarDatasets/.github `run-generate-archive.yml` archive-ready callback.

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
