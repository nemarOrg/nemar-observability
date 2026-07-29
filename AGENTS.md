# nemar-observability - Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Claude Code...). Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

## Project Context

**Purpose:** Operational observability dashboard for NEMAR, served at **`dashboard.nemar.org/observability`** (sibling of the legacy `/citations` dashboard). It reports dataset + pipeline health at a glance — public vs private counts, % with a downloadable archive, failed/pending Zarr conversions, OpenNeuro import backlog, staleness, edge traffic, and which datasets are actually read — and lets admins drill into the exact list of items that need attention.

**Tech Stack:** TypeScript, Bun, Hono on Cloudflare Workers, Biome (lint/format). No Python runtime. (Hono, matching the nemar-cli backend, gives a native `scheduled()` cron + D1 access; the UI is one server-rendered HTML page with a small client script — no SPA framework needed.)

**Architecture:** One Cloudflare Worker does UI + API + an hourly cron. It is a *reader*:
- binds nemar-cli's D1 (`nemar-db`) **read-only** for dataset/pipeline aggregates and admin drill-downs;
- queries the Cloudflare **Analytics Engine** `nemar_access_metrics` dataset (written by nemar-cli's data-plane) via the account-scoped AE SQL API for access metrics;
- keeps its own small D1 (`nemar-observability-db`) for snapshot history and pushed pipeline sections;
- delegates the admin check to `api.nemar.org` `GET /auth/me` (never reproduces nemar-cli's token hashing).

It is mounted via a Worker route `dashboard.nemar.org/observability*` layered over the existing `nemar-dashboard` Cloudflare **Pages** project (Worker routes take precedence per path, so `/citations` is untouched).

```
src/
├── index.ts           # worker entry: { fetch: app.fetch, scheduled } + Hono route mounting
├── lib/
│   ├── schema/        # versioned MetricSnapshot schema (JSON Schema + TS types) — the pluggable-pipeline standard
│   ├── metrics/       # snapshot compute: D1 aggregates + AE SQL queries -> sections
│   ├── auth.ts        # admin check via api.nemar.org /auth/me delegation
│   └── store.ts       # nemar-observability-db reads/writes (snapshot history, pushed sections)
├── routes/
│   ├── api.ts         # /api/snapshot, /api/snapshot/history, /api/drilldown/:key, /api/sections/:key
│   └── ui.ts          # GET /observability -> server-rendered HTML page (+ client script)
└── cron.ts            # scheduled() handler: recompute snapshot hourly
```

### The metrics standard (why this repo exists)

Every metric is a headline number (a total, or a percent like "% with archive"); each tile can drill into the list of datasets behind it. Pipelines contribute **sections** to one versioned `MetricSnapshot` schema (`src/lib/schema/`). Two contribution modes:
- **pull** — the hourly cron computes built-in sections it knows (`datasets`, `archive`, `zarr`, `imports`, `publication`, `access`, `cf`, `users`) from `nemar-db`, Analytics Engine, and Cloudflare zone analytics. (`sync` was retired with nemar-cli migration 0053 but stays reserved so a pushed section cannot recycle the key.)
- **push** — an external pipeline (future data-processing / QA) `POST`s a schema-conformant section to `/observability/api/sections/:key` (token-auth); it is stored and merged into the snapshot. Adding a pipeline never requires changing the dashboard core.

### Privacy boundary
Public snapshot (the tiles) carries **headline numbers only, no private dataset IDs**. Drill-down lists (which datasets are missing/failed) are computed on demand from `nemar-db` and require an admin (delegated `/auth/me`). v1 admin auth = the admin's `nm_…` API key (Bearer) entered in the UI (localStorage); cross-subdomain cookie SSO is a future enhancement (the prod `nemar_session` cookie is scoped to `app.nemar.org` and is not sent to `dashboard.nemar.org`).

## Key facts (NEMAR ecosystem)

- **SCCN Cloudflare account only.** Account id `da8d7a2a8680dab01592bbbc6f67f12c`. All CF ops via `npx cfman wrangler --account sccn -c wrangler.toml`. Unset `CLOUDFLARE_API_TOKEN` first (`env -u CLOUDFLARE_API_TOKEN ...`); pass `CLOUDFLARE_ACCOUNT_ID=da8d...` if wrangler can't resolve the account.
- **Shared D1 (read-only):** `nemar-db`, database_id `009b1a44-a385-4ecf-812d-ec8341587cb5`. **Never** add `migrations_dir` for it — nemar-cli owns its schema. Only `SELECT`.
- **Snapshot counts must match the rest of NEMAR.** Exclude folded catalog rows (`owner_user_id != -1`) and sandbox (`is_sandbox = 0 OR is_sandbox IS NULL`); "public" = `status='active' AND visibility='public'` (matches nemar-cli `GET /datasets` and `/admin/stats`).
- **Source columns** (in `nemar-db.datasets`, all indexed): `visibility`, `status`, `concept_doi`, `zarr_status`, `archive_status`, `license_tier`, `modalities`, `file_size`, `last_activity_at`. Archive + access instrumentation lives in nemar-cli (epic #695 / issue #696).
- **AE sampling:** aggregate access metrics with `SUM(_sample_interval)`, never `COUNT(*)`.
- **AE blob layout** is a contract with nemar-cli's `buildAccessDataPoint`: `blob1` dataset_id, `blob2` source, `blob3` detail (`index`/`metadata`/`chunk` for zarr). Never sum across `blob3` — index.json crawling dwarfs real data reads.
- **Zone analytics** needs `CF_ZONE_ANALYTICS_TOKEN` (Zone > Analytics > Read on nemar.org; account-level Analytics Read does NOT cover it). `httpRequestsAdaptiveGroups` is the only host-dimensioned dataset and rejects windows wider than 1 day, so per-host data is accumulated daily into `cf_daily_host`. Exclude `rate-limit.internal`, and never sum daily uniques into a window total.

## Environment Setup
```bash
bun install
bun run dev          # wrangler dev (local worker)
bun test             # real tests only, no mocks
bun run biome check --fix .
bun run typecheck    # tsc --noEmit
```

## Deploy (SCCN)

**Merging to `main` deploys to production** via `.github/workflows/deploy.yml`: gate (lint/typecheck/test) -> `d1 migrations apply` on `nemar-observability-db` -> `wrangler deploy` -> post-deploy verification that `/health` is `ok` and the snapshot has no `section_errors`. Manual `workflow_dispatch` targets dev. Requires repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (same names nemar-cli uses).

Hand deploy, if CI is unavailable — dev first, then prod:
```bash
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c \
  npx cfman wrangler --account sccn deploy -c wrangler.toml --env dev
```
Remember the migration; the Worker degrades but does not self-heal if `OBS_DB` is behind:
```bash
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c \
  npx cfman wrangler --account sccn d1 migrations apply nemar-observability-db --remote -c wrangler.toml
```

**Verifying a deploy:** `/observability/api/snapshot` carries `s-maxage=300`, so the bare URL can serve the PREVIOUS build's snapshot for minutes after a deploy and make a good deploy look broken. Always cache-bust (`?cb=$(date +%s)`) when checking. `/health` is `no-store` and safe to read directly.

## Monitoring

`.github/workflows/health-monitor.yml` polls `/observability/health` every 15 min, opens a single `health-alert` issue while unhealthy (commenting rather than duplicating), and closes it on recovery. The decision logic is `scripts/check-health.ts` (unit-tested), not YAML.

GitHub Actions `schedule` is best-effort and gets disabled after 60 days of repo inactivity, so this is a safety net for multi-hour outages, **not a pager**. An external monitor is still the right long-term answer.

## Development Workflow
1. Check `.context/plan.md` for current phase/tasks.
2. Branch: `gh issue develop <n>` (epic nemarOrg/nemar-cli#695).
3. Code to `.rules/` standards (Bun, Biome, no mocks).
4. Test with `bun test` (real D1 via bun:sqlite / wrangler; no mocks).
5. Atomic commits, <50 chars, no emojis, **no AI attribution**.
6. PR, then `/review-pr`; address all findings; never merge until CI is green.

## [NEVER DO THIS]
- Never use `npm`/`npx` for project deps; use Bun. (CF ops use `npx cfman wrangler` — that one exception is the documented SCCN path.)
- Never add a Python runtime/CI/install dependency (Python tooling lives in sibling repos).
- Never write to `nemar-db` or add its `migrations_dir`; it is read-only here.
- Never put private dataset IDs in the public snapshot; they belong only in admin drill-downs.
- Never use mocks, stubs, or fake data in tests.
- Never commit secrets, `.env`, or CF tokens.
- Never use emojis in commits, PRs, or code.

## Rules Reference
- `.rules/typescript.md` - TypeScript/Bun/Biome standards
- `.rules/testing.md` - NO MOCK policy
- `.rules/code_review.md` - PR review process
- `.rules/git.md` - Commit/branch standards
- `.rules/ci_cd.md` - GitHub Actions
- `.rules/documentation.md` - Docs standards

## Context Files
- `.context/plan.md` - phases and tasks
- `.context/ideas.md` - design decisions
- `.context/research.md` - investigations (data sources, CF specifics)
- `.context/scratch_history.md` - failed attempts and lessons
- `.context/decisions/` - ADRs

---
Remember: this dashboard is a thin reader + a standard. Keep the schema stable; push the heavy lifting (instrumentation) to where the data is produced.
