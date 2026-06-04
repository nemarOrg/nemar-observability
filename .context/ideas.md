# nemar-observability Design Ideas

## Core decisions (from epic planning)
- **Standalone Worker, not Pages.** The legacy `/citations` is a static Pages site (Python `nemar-citations` repo). This dashboard needs admin-gated live drill-downs, so it is an Astro-SSR Worker mounted via route `dashboard.nemar.org/observability*` over the Pages project.
- **Reader, not owner.** Metrics come from nemar-cli's `nemar-db` (read-only) + Cloudflare Analytics Engine. The only data this repo *owns* is the snapshot history + pushed pipeline sections (its own small D1).
- **Schema-first.** One versioned `MetricSnapshot` is the contract. Built-in sections are computed (pull); external pipelines push sections. This is what makes the dashboard extensible without core changes.
- **Privacy split.** Public snapshot = headline numbers only. Drill-down lists (private IDs, failures) = admin, computed on demand, never cached publicly.
- **Auth by delegation.** Validate the admin's Bearer token by calling `api.nemar.org/auth/me` rather than reproducing nemar-cli's token hashing (avoids the worst schema coupling). Bearer-only in v1 (cookie is `app.nemar.org`-scoped, not sent here).

## Severity model
Each metric carries `severity` ∈ ok|warn|error|info to color its tile. e.g. archive.failed/zarr.failed/sync.failed -> error; pending -> warn; healthy ratios -> ok. Keep the thresholds in one place (`src/lib/metrics`).

## Open / later
- Topo of access by region (CF colo) — later.
- Trend retention policy for snapshot history (start: keep hourly for 30d, daily rollup beyond).
- `.nemar.org` cookie SSO so the app.nemar.org login flows to the dashboard (backend change + security review).
