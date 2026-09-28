# nemar-observability

Operational observability dashboard for NEMAR, served at **[dashboard.nemar.org/observability](https://dashboard.nemar.org/observability)** (sibling of the legacy `/citations` dashboard).

It answers, at a glance:

- How many datasets are public vs private? How many have a DOI?
- How many are missing a downloadable archive, or have a **failed** / **pending** Zarr conversion or archive?
- How many OpenNeuro imports are stuck? How many publication requests are open?
- Which public datasets are accessed the most (downloads, Zarr reads)?

Tiles show aggregate headline numbers. Built-in breakdowns such as the largest and most-read datasets include only bounded lists of public dataset IDs. Pushed sections are public too, so their producers must keep private identifiers and other sensitive details out. Administrators review item-level health lists in the website admin portal.

### How to read usage

Usage is grouped by reporting source: anonymous browser page views and action events, server-side access requests and redirects, Cloudflare edge requests and bytes, and S3 response bytes when those series are available. These are separate measures: page views and actions are events rather than people, access redirects do not confirm completed downloads, and edge traffic can include bots and repeat clients. The selected UTC date range controls every displayed additive series and total. Daily values are summed into calendar-aligned weeks or months only when the bucket has complete observations; a partial boundary bucket is labeled, and a missing observation stays **unknown**, never zero. Daily distinct visitors are not summed into a range total. Snapshot health is a separate point-in-time view labeled **latest state**, with its generated time shown.

The range-aware audience panel reports Umami visitors as anonymous unique-session estimates, not identified people. Umami visits use a separate visit identifier; sessions can be assigned to more than one country during a range. Cloudflare country counts are zone-wide HTTP requests, not visitors or completed downloads. Summary values use the selected UTC range; country breakdowns are limited to a single completed UTC day. The day/week/month selector applies only to additive daily time series.

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
│   ├── api.ts          /api/snapshot, /snapshot/history, /timeseries, /drilldown/:key, /sections/:key
│   └── ui.ts           the server-rendered dashboard page
├── lib/
│   ├── schema.ts       the MetricSnapshot standard (Zod = source of truth)
│   ├── metric-snapshot.schema.json   JSON Schema mirror for non-TS consumers
│   ├── metrics.ts      built-in sections (datasets, archive, zarr, imports, publication, users) + buildSnapshot
│   ├── access.ts       Analytics Engine access section
│   ├── drilldown.ts    admin drill-down queries
│   ├── store.ts        own-DB reads/writes (snapshot history, pushed sections)
│   ├── auth.ts         admin check via /users/me delegation
│   └── sql.ts          shared predicates (must match nemar-cli's WHERE clauses)
└── db/migrations/      own-DB schema (snapshots, ingested sections, daily series)
```

## The metrics standard (plugging in a pipeline)

The dashboard renders one versioned `MetricSnapshot`. A pipeline contributes a **section**. Two ways:

1. **Pull (built-in):** the cron computes sections it knows from `nemar-db` + Analytics Engine. To add a built-in, write a `…Section(db, now)` in `src/lib/metrics.ts` and add it to `buildSnapshot()`.
2. **Push (external pipeline):** any pipeline (e.g. a future data-processing / QA job) POSTs a schema-conformant section. No dashboard change required.

```bash
curl -X POST https://dashboard.nemar.org/observability/api/sections/qa \
  -H "Authorization: Bearer $QA_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "qa",
    "label": "QA pipeline",
    "source": "qa-pipeline",
    "metrics": [
      { "key": "qa.pass", "label": "Passing", "value": 612, "total": 700, "severity": "ok" },
      { "key": "qa.fail", "label": "Failing", "value": 12, "severity": "error", "drilldown": "qa.fail" }
    ],
    "daily_series": [{
      "key": "pageviews", "label": "Pageviews", "unit": "count",
      "aggregation": "sum", "timezone": "UTC",
      "coverage_start": "2026-09-01", "coverage_end": "2026-09-02",
      "points": [{ "date": "2026-09-01", "value": 120 }, { "date": "2026-09-02", "value": 0 }]
    }]
  }'
```

Set `OBS_INGEST_TOKENS_JSON` to a JSON object mapping section keys to distinct
bearer tokens (for example `{"website":"…","egress":"…"}`). There is no
endpoint-wide token fallback. Values must be distinct after trimming whitespace,
and a token is valid only for its matching URL key.
Daily series accept additive `count` or `bytes` values in UTC. Missing dates
remain unknown; an observed zero is stored as zero. Repeated pushes replace
overlapping dates. A series key's source, label, unit, aggregation, timezone,
and freshness rule are immutable; publish changed semantics under a new key.
Browser week/month views sum daily values only when every date in the selected
bucket has an observation and is within declared coverage.
Non-additive measures such as daily unique visitors must not be sent as series.
The JSON Schema describes field-level shape. Its `dailySeries` description
lists the three cross-field rules also enforced by the section-ingest endpoint:
ordered coverage dates, unique point dates, and points inside coverage; producers
that only validate JSON Schema must apply those rules separately.

The body must conform to `src/lib/metric-snapshot.schema.json` (`$defs/sectionIngest`), its `key` must match the URL, and its headline metrics are merged into the next snapshot. Optional daily series are stored separately. A pushed section cannot shadow a built-in key.

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
| `GET /observability/api/snapshot` | public | latest snapshot with aggregate headlines and bounded public-dataset breakdowns |
| `GET /observability/api/snapshot/history?metric=KEY` | public | trend points for a metric |
| `GET /observability/api/drilldown/:key` | **admin** Bearer | the list behind a tile |
| `POST /observability/api/sections/:key` | ingest Bearer | push a pipeline section |
| `GET /observability/api/timeseries?start=YYYY-MM-DD&end=YYYY-MM-DD` | public | daily points and metadata, inclusive UTC range (maximum 3660 days) |
| `GET /observability/api/audience?start=YYYY-MM-DD&end=YYYY-MM-DD` | public | selected-range Umami session/page-view summary and Cloudflare request totals; Umami country values for one completed day and Cloudflare country values across completed days |
| `GET /observability/health` | public | liveness |

The **public snapshot and time-series API contain aggregate measures**; built-in snapshot sections may include bounded breakdowns labeled with public dataset IDs. Pushed sections are also public, and schema validation does not check their labels against dataset visibility. Pipeline producers must keep private identifiers and credentials out of all pushed fields. The page is zero-auth and zero-write. Daily usage controls support 7/30/90/365-day presets, custom UTC dates, and day/week/month grouping. Chart gaps mean missing or out-of-coverage observations.

### Audience and country reporting

The audience endpoint accepts strict UTC `YYYY-MM-DD` dates with an inclusive end and a maximum 3,660-day range. Umami and Cloudflare are queried independently, so a source can be unavailable while the other still returns data. Each source reports `available`, `partial`, `unconfigured`, or `unavailable`, its measured coverage dates, and an observation timestamp. The response's `country_breakdown_scope` describes Umami country eligibility for the requested range. For actual map data, use each source's `country_coverage`; it is the authoritative range for that source's country rows. A numeric zero is a successful measurement over covered dates; unavailable values are `null`.

The production Worker uses `UMAMI_BASE_URL` and `UMAMI_WEBSITE_ID` for the self-hosted Umami source. Its `UMAMI_API_KEY` belongs in a Cloudflare Worker secret and is never exposed to the dashboard or browser. The source of truth is Infisical project `nemar`, environment `prod`, path `/observability/website`, which also holds the site ID and the separate `OBS_WEBSITE_INGEST_TOKEN`. The `/observability/egress` path remains separate and contains AWS egress credentials. Missing any Umami setting reports that source as `unconfigured`.

For a configured range, the Worker reads Umami `/api/websites/{id}/daterange` first and intersects the requested timestamps with Umami's reported data bounds. It reads `/stats` for visitors, visits, and page views; it queries `/metrics?type=country` only for a single completed UTC day. “Visitors” counts distinct anonymous sessions; Umami rotates the session hash monthly, so this is not an identified-person count. “Visits” is a separate distinct visit identifier. Country values may not sum to visitors because the same session can appear under different countries, and Umami omits sessions without a reported country.

The Umami card also reports the fixed consent-gated events `citation_click`, `viewer_open`, `viewer_interaction`, `upload_started`, and `upload_completed`. The Worker queries `/events/stats` separately for each event over the intersection of the selected range, Umami's available dates, and verified event coverage. It returns event counts and distinct anonymous sessions associated with each event. The `event_metrics` object has its own status and measured coverage so partial ranges remain visible. Set the non-secret `UMAMI_EVENTS_COVERAGE_START` Worker variable to the first complete UTC day verified for production instrumentation; without it, event values remain unknown rather than appearing as zero. Event counts describe browser interactions, not completed data delivery or bytes.

Cloudflare uses daily `httpRequests1dGroups` country rows over the selected range's overlap with the latest 30 UTC dates. The country map and `country_requests` cover completed days only; the separate `requests` total can include the in-progress UTC day and is marked partial because those counts can still change. These are HTTP request counts, not unique visitors. Cloudflare country rows can cover multiple selected completed days: values below 10 are suppressed separately for each day before reportable country values are added. Umami country values remain available only for one fully covered, completed UTC day; distinct sessions are never summed across days. Future dates have no observations yet. Empty or unreported country labels are omitted without estimating their counts. Small daily rows are grouped as `Other / withheld` only when their combined value reaches 10; otherwise that day's small values are omitted and `suppressed_small_countries` is true. Day/week/month grouping applies to additive time series only; audience values are source-native selected-range totals.

Install the Umami key from Infisical into the production Worker using the authenticated Cloudflare CLI. Pass the value through standard input; do not put it in shell arguments, history, logs, or repository files. `wrangler secret put` creates and deploys a new Worker version immediately.

```bash
set -o pipefail
infisical --domain https://infisical.nemar.org run \
  --projectId 817f7473-a318-4e99-9cf4-a89db057f5fc \
  --env prod --path /observability/website --silent -- \
  sh -c 'printf "%s" "$UMAMI_API_KEY"' |
  env -u CLOUDFLARE_API_TOKEN npx cfman wrangler --account sccn \
    secret put UMAMI_API_KEY -c wrangler.toml
```

After installing the secret, verify `/observability/api/audience` reports the Umami source status and coverage. Keep `UMAMI_EVENTS_COVERAGE_START` unset until production browser event instrumentation has passed real-browser acceptance; unknown event values must not be displayed as zero.

## Daily S3 egress series

`scripts/push-s3-egress.ts` reads the existing CloudWatch `AWS/S3:BytesDownloaded`
metric for bucket `nemar`, filter `EntireBucket`, in `us-east-2`. It requests
daily `Sum` values with an 86,400-second period and UTC-midnight bounds. Run
the initial collector once with `EGRESS_START_DATE=2026-08-01` to backfill from
August 1, 2026 UTC through the last complete UTC day. Its default daily run
re-reads the latest 14 days so late-corrected observations replace earlier
values without repeating the full backfill. Set either `EGRESS_START_DATE` or
`EGRESS_LOOKBACK_DAYS`, not both; the daily timer sets neither.
Missing CloudWatch datapoints stay missing; the collector never fills them with
zero. The chart keeps S3 response bytes separate from Cloudflare, Worker, and
Umami measures. This bucket-wide metric includes conversion reads and does not
identify a caller or prove a completed human download. AWS describes the metric
as response-body bytes and S3 request metrics as best-effort, opt-in telemetry
billed at standard CloudWatch rates ([metric definition](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html),
[best-effort delivery](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-configurations.html),
[request-metric behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/configure-request-metrics-bucket.html)).
The collector only reads the existing metrics configuration; it does not
enable or change it.

On nemaring, install Bun, AWS CLI v2, and Infisical CLI. The read-only Infisical
token file belongs at
`$HOME/.config/infisical/nemar-observability-egress.token` with owner-only
permissions (`0600`). The Infisical target is project `nemar` (ID
`817f7473-a318-4e99-9cf4-a89db057f5fc`), production environment `prod`
(displayed as `Production - api.nemar.org`), path `/observability/egress`;
it must expose `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_REGION=us-east-2`. Once section-keyed ingest is deployed, add
`OBS_EGRESS_INGEST_TOKEN` to that same path, with a token authorized only for
section key `egress`. Do not put AWS values or the ingest token in this repo,
shell history, systemd files, or logs.

On nemaring, use `https://infisical.nemar.org` through the existing
`nemar-infisical` Cloudflare Tunnel. The exact-host Cloudflare Access app is
`Bypass / Everyone`, so CLI requests do not need the Cloudflare email challenge;
Infisical still authenticates the scoped service token. Public signups are
disabled and the administrator has passkey two-factor authentication. On
2026-09-27, the read-only token successfully loaded the three AWS variables
through this public hostname. The same check found `OBS_EGRESS_INGEST_TOKEN`
missing, so the collector cannot push its section yet. The `prod` environment
supplies production `api.nemar.org` credentials; the `dev` environment targets
`api-test.nemar.org`, and local development uses `.dev.vars`.

For the initial backfill and acceptance run from `/opt/nemar-observability`:

```bash
EGRESS_START_DATE=2026-08-01 ops/with-egress-secrets.sh /opt/nemar-observability/scripts/push-s3-egress.ts
```

The collector publishes a red `Latest collector run errors` status metric when
AWS collection or freshness validation fails but the section token and
dashboard are available; it leaves stored daily points unchanged. If a section
POST has an ambiguous outcome, the collector does not send a second status
write that might replace a committed success. If it cannot reach the dashboard
or has no ingest token, the systemd journal records the failure and the last
series eventually ages stale. Check the service logs and
`GET /observability/api/timeseries` for the returned dates.

Install the units and run the collector once for acceptance:

```bash
sudo install -m 0644 ops/systemd/nemar-observability-egress.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/nemar-observability-egress.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start nemar-observability-egress.service
sudo journalctl -u nemar-observability-egress.service -n 100 --no-pager
```

After the real section is accepted, appears in the time-series API, and the
dashboard shows the expected dates and gaps, enable the schedule:

```bash
sudo systemctl enable --now nemar-observability-egress.timer
```

The timer is scheduled daily at 08:17 UTC with up to 15 minutes of randomized
delay. `Persistent=true` catches up a missed timer activation after downtime;
it does not retry a collector process that ran and failed. Failures remain in
the journal and, when possible, as a collector error metric. The next scheduled
run re-reads the 14-day overlap, replacing corrected observations. CloudWatch's
`GetMetricData` API uses an exclusive end timestamp; the collector ends each
query at today's UTC midnight so it requests only complete UTC days
([API reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html)).

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
npx cfman wrangler --account sccn secret put CF_ZONE_ANALYTICS_TOKEN -c wrangler.toml --env dev   # Zone Analytics Read (nemar.org)
npx cfman wrangler --account sccn secret put OBS_INGEST_TOKENS_JSON -c wrangler.toml --env dev
npx cfman wrangler --account sccn deploy -c wrangler.toml --env dev
```

Prereqs in nemar-cli (epic nemarOrg/nemar-cli#695): the `nemar_access_metrics` Analytics Engine dataset (written by the data-plane) and the `archive_status` columns. Both ship dark in nemar-cli ahead of this dashboard.

## License

Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International (CC BY-NC-ND 4.0). See [LICENSE](LICENSE). Same license as the rest of the NEMAR product suite (nemar-cli, website).

---
Part of epic **nemarOrg/nemar-cli#695**. See `AGENTS.md` for full development instructions.
