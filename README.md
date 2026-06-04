# nemar-observability

Operational observability dashboard for NEMAR, served at **[dashboard.nemar.org/observability](https://dashboard.nemar.org/observability)** (sibling of the legacy `/citations` dashboard).

It answers, at a glance:

- How many datasets are public vs private? How many have a DOI?
- How many are missing a downloadable archive, or have a **failed** / **pending** Zarr conversion or archive?
- How many failed the legacy nemar.org sync? How many publication requests are open?
- Which public datasets are accessed the most (downloads, Zarr reads)?

Every tile is a headline number (a total, or a percent like "% with archive"). Tiles that have a list behind them drill into the exact datasets that need attention — **admin only**.

## How it works

One Cloudflare Worker (Hono) does the UI, a JSON API, and an hourly cron. It is a **reader**:

- binds nemar-cli's D1 (`nemar-db`) **read-only** for dataset/pipeline aggregates and admin drill-downs;
- reads the Cloudflare **Analytics Engine** dataset `nemar_access_metrics` (written by nemar-cli's data-plane) via the account-scoped AE SQL API for access metrics;
- stores only its own data — snapshot history + pushed pipeline sections — in its own small D1 (`nemar-observability-db`);
- checks admin auth by delegating to nemar-cli `GET /users/me` (it never reproduces nemar-cli's token hashing).

It is mounted via a Worker **route** `dashboard.nemar.org/observability*` layered over the existing `nemar-dashboard` Cloudflare Pages project, so `/citations` is untouched.

```
src/
├── index.ts            worker entry: { fetch, scheduled } + route mounting
├── cron.ts             hourly snapshot recompute
├── routes/
│   ├── api.ts          /api/snapshot, /snapshot/history, /drilldown/:key, /sections/:key
│   └── ui.ts           the server-rendered dashboard page
├── lib/
│   ├── schema.ts       the MetricSnapshot standard (Zod = source of truth)
│   ├── metric-snapshot.schema.json   JSON Schema mirror for non-TS consumers
│   ├── metrics.ts      built-in sections (datasets, archive, zarr, sync, publication, users) + buildSnapshot
│   ├── access.ts       Analytics Engine access section
│   ├── drilldown.ts    admin drill-down queries
│   ├── store.ts        own-DB reads/writes (snapshot history, pushed sections)
│   ├── auth.ts         admin check via /users/me delegation
│   └── sql.ts          shared predicates (must match nemar-cli's WHERE clauses)
└── db/migrations/      own-DB schema (snapshots, ingested_sections)
```

## The metrics standard (plugging in a pipeline)

The dashboard renders one versioned `MetricSnapshot`. A pipeline contributes a **section**. Two ways:

1. **Pull (built-in):** the cron computes sections it knows from `nemar-db` + Analytics Engine. To add a built-in, write a `…Section(db, now)` in `src/lib/metrics.ts` and add it to `buildSnapshot()`.
2. **Push (external pipeline):** any pipeline (e.g. a future data-processing / QA job) POSTs a schema-conformant section. No dashboard change required.

```bash
curl -X POST https://dashboard.nemar.org/observability/api/sections/qa \
  -H "Authorization: Bearer $OBS_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "qa",
    "label": "QA pipeline",
    "source": "qa-pipeline",
    "metrics": [
      { "key": "qa.pass", "label": "Passing", "value": 612, "total": 700, "severity": "ok" },
      { "key": "qa.fail", "label": "Failing", "value": 12, "severity": "error", "drilldown": "qa.fail" }
    ]
  }'
```

The body must conform to `src/lib/metric-snapshot.schema.json` (a `Section`), its `key` must match the URL, and it is merged into the next snapshot. A pushed section cannot shadow a built-in key.

### Metric shape

| field | meaning |
|---|---|
| `key` | stable namespaced id, e.g. `archive.missing` |
| `value` | the headline number |
| `total` | optional denominator → the UI shows `value/total` as a percent |
| `unit` | `datasets` \| `bytes` \| `percent` \| `count` \| ... |
| `severity` | `ok` \| `warn` \| `error` \| `info` → tile color |
| `drilldown` | optional key the admin drill-down endpoint resolves to a list |
| `breakdown` | optional `[{label, value}]` (e.g. by-license, by-modality, top-accessed) |

## API

| route | auth | purpose |
|---|---|---|
| `GET /observability/api/snapshot` | public | latest snapshot (headline numbers only) |
| `GET /observability/api/snapshot/history?metric=KEY` | public | trend points for a metric |
| `GET /observability/api/drilldown/:key` | **admin** Bearer | the list behind a tile |
| `POST /observability/api/sections/:key` | ingest Bearer | push a pipeline section |
| `GET /observability/health` | public | liveness |

The **public snapshot never contains private dataset ids** — those appear only in admin drill-downs, computed on demand. v1 admin auth is the admin's NEMAR API key (Bearer), entered in the UI and stored in that browser's localStorage.

## Development

```bash
bun install
bun test                 # real tests only (no mocks)
bun run typecheck
bun run biome check --fix .
bun run dev              # wrangler dev (local)
```

## Deploy (SCCN account only)

All Cloudflare ops go through cfman against the SCCN account. First deploy creates the own DB and fills the two `REPLACE_AT_DEPLOY` ids in `wrangler.toml`:

```bash
# create the own DB (dev + prod), paste ids into wrangler.toml
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c \
  npx cfman wrangler --account sccn d1 create nemar-observability-db-dev -c wrangler.toml

# apply own-DB migrations, set secrets, deploy
npx cfman wrangler --account sccn d1 migrations apply nemar-observability-db-dev -c wrangler.toml --env dev
npx cfman wrangler --account sccn secret put CF_ANALYTICS_TOKEN -c wrangler.toml --env dev   # Account Analytics Read
npx cfman wrangler --account sccn secret put OBS_INGEST_TOKEN -c wrangler.toml --env dev
npx cfman wrangler --account sccn deploy -c wrangler.toml --env dev
```

Prereqs in nemar-cli (epic nemarOrg/nemar-cli#695): the `nemar_access_metrics` Analytics Engine dataset (written by the data-plane) and the `archive_status` columns. Both ship dark in nemar-cli ahead of this dashboard.

---
Part of epic **nemarOrg/nemar-cli#695**. See `AGENTS.md` for full development instructions.
