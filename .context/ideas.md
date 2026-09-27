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

## Question-led dashboard direction (proposal, 2026-09-27)

The public dashboard should answer four questions in a clear progression:

1. **What research data can I use?** Public catalog size, modalities, and
   links to discovery. Modality categories overlap; do not present them as a
   partition.
2. **How accessible and citable is it?** DOI coverage, eligible archive
   coverage, and Zarr availability with their actual denominators. Readiness
   does not establish scientific quality.
3. **How is NEMAR being used, and where does activity come from?** Keep
   browser sessions/events, server requests, Cloudflare edge requests, and S3
   response bytes in separate source panels. A country label describes the
   source's anonymous estimate or request geography, not researchers or
   beneficiaries.
4. **How are these numbers measured?** Show definitions, units, selected UTC
   range, measured coverage, freshness, and unknown/partial states beside the
   charts.

This single public report can serve dataset providers, curious users, scientific
peers, and funders; audience-specific tabs are not recommended. Keep publication
status for an individual provider in the authenticated user dashboard. Any
participant totals are sums across datasets, not distinct people. Resource
growth charts require a durable daily history; hourly snapshots with roughly
five-week retention cannot support annual growth claims.

The private website admin overview should first answer **“What needs attention
now?”** and link each count to its exact actionable queue: upload-access
requests, publication decisions, failed/stuck imports, archive/Zarr failures,
and stale observability collection. Follow with separate People, Publications,
Dataset readiness, Imports, and Usage/transfers workspaces. Do not add queue
counts into a distinct overall issue total unless the backend computes a true
deduplicated union. Anonymous browser analytics must remain separate from
authenticated account identity.

Before redesigning admin user counts, reconcile two different definitions:
`src/lib/metrics.ts` currently labels all email-verified accounts
(`status='verified'`) as “Awaiting approval,” while the website's open
upload-access request predicate requires both `upload_access_requested_at` and
`service_access === 0`. These describe different queues and should not share a
label or denominator without confirming the intended admin action.

Suggested sequence after Phase 5 is to reconcile Umami and website live
acceptance, define citation/viewer action events, improve public resource
hierarchy, correct admin approval predicates, then build the question-led admin
queues and longer-term resource history. S3 daily collection remains the
independent follow-up in issue #59. These are design recommendations from a
read-only review, not implementation or production-acceptance claims.
