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

The range-aware audience panel reports Umami visitors as anonymous unique-session estimates, not identified people. Umami visits use a separate visit identifier; sessions can be assigned to more than one country during a range. Cloudflare country counts are zone-wide HTTP requests, not visitors or completed downloads. Summary values use the selected UTC range; website country breakdowns are limited to a single completed UTC day, so for a longer range the website map shows the newest completed day inside it and says which day. The day/week/month selector applies only to additive daily time series.

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
bearer tokens (for example `{"website":"…","egress":"…","storage":"…"}`). There is no
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

A section may also carry one optional `channel_hours` object: recorded hours by exact channel count per modality, with per-modality dataset peaks, over public datasets only (see `$defs/channelHours`).
Its rules go beyond field shapes (bins ascending with matching totals, every dataset peak backed by a bin), so producers that only validate JSON Schema must apply them separately.
Like `daily_series`, and unlike the rest of a section, its objects are strict: an unknown key is rejected with 422 instead of dropped, because an unknown key could be a dataset identifier.
A producer that adds a field to it needs the Worker deployed first.

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

The one-time backfill (`EGRESS_START_DATE=2026-08-01`), unit installation, and
first runs are part of the combined block in
[Installing the collectors on nemaring](#installing-the-collectors-on-nemaring).

The collector publishes a red `Latest collector run errors` status metric when
AWS collection or freshness validation fails but the section token and
dashboard are available; it leaves stored daily points unchanged. If a section
POST has an ambiguous outcome, the collector does not send a second status
write that might replace a committed success. If it cannot reach the dashboard
or has no ingest token, the systemd journal records the failure and the last
series eventually ages stale. Check the service logs and
`GET /observability/api/timeseries` for the returned dates.

The timer runs hourly at :15 UTC, with up to 2 minutes of randomized delay.
The first run after midnight publishes the UTC day that just closed, a failed run retries itself an hour later, and CloudWatch data that arrives late replaces the earlier value (S3 request metrics are best-effort).
Every run is an idempotent re-read of the same 14-day window.
`Persistent=true` catches up a missed timer activation after downtime.
Failures remain in the journal and, when possible, as a collector error metric.
If a closed UTC day is still missing six hours after midnight, or a collector has had no successful run for 26 hours, `/observability/health` turns red and the health monitor opens an issue. One failed run does not: the failure status refreshes the section but not its `last_ok_at`, which is what health judges. The same rules cover the Umami `website` section and its `pageviews` series, which the nemar-umami pusher delivers hourly.
CloudWatch's `GetMetricData` API uses an exclusive end timestamp; the collector ends each
query at today's UTC midnight so it requests only complete UTC days
([API reference](https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html)).

## Daily S3 storage size

`scripts/push-s3-storage.ts` pushes section `storage` (label "Data storage", source `aws-s3-cloudwatch`) so administrators can monitor how much data bucket `nemar` in `us-east-2` holds.
It reads the daily S3 storage metrics with one `GetMetricData` call: `AWS/S3:BucketSizeBytes` for every documented `StorageType`, and `AWS/S3:NumberOfObjects` for `StorageType=AllStorageTypes`, both `Stat=Average`, `Period=86400`, `BucketName=nemar`.
These storage metrics need no bucket metrics configuration, and the existing read-only CloudWatch key already permits the call.

| metric | unit | value |
|---|---|---|
| `storage.bucket_bytes` | `bytes` | bytes stored, summed across the storage classes that report |
| `storage.object_count` | `count` | objects stored, all storage classes |
| `storage.by_class` | `count` | number of reporting storage classes; `breakdown` gives bytes per class, largest first, under a plain label such as "Standard" or "Infrequent access" (unknown classes read "Other storage class"), `breakdown_unit: "bytes"` |
| `storage.collector.errors` | `errors` | `0` after a successful run; a failed run replaces the section with this metric alone, at `1` and severity `error`, with a generic hint; the failure detail is only in the journal |

S3 reports these values once per day, timestamped at 00:00 UTC, with roughly a one-day lag.
They cover the whole bucket, including archives, Zarr copies, and internal objects.
Each run reads the last seven UTC days and reports the newest day on which both the object count and `StandardStorage` have a value, summing every storage class reported that day.
S3 computes all storage classes in one daily job, so a class missing on that day held no data (for example, after a lifecycle move) and is omitted rather than counted as zero; a missing `StandardStorage` value or object count makes the day unknown, and the run falls back to an older day.
A run fails, and publishes the error status the same way the egress collector does, when no such day exists or the newest one is older than the previous UTC day: a value timestamped day D is accepted through the end of day D+1 UTC and rejected from D+2 00:00 UTC onward.
This is tighter than the egress 36-hour rule, so a two-day-old value is never shown as current.

These are gauges, not additive quantities, so the collector sends no `daily_series`: the week and month views would add them up.
The trend comes from snapshot history instead, for example `GET /observability/api/snapshot/history?metric=storage.bucket_bytes`.
That endpoint reads the newest 168 stored snapshots, one per hourly cron run, so about seven days (the Worker retains 850, about five weeks, but the endpoint reads only the newest 168).
It returns the value from each of those snapshots that contains the metric; a snapshot taken while the section held only a failure status is skipped, leaving a gap rather than a zero.
Because the source changes once per day, consecutive points repeat the same daily value.

## Recorded hours by channel count

`scripts/push-zarr-recordings.ts` pushes section `recordings` (label "Recorded data", source `nemar-zarr-index`).
It answers "how many hours of data exist, per modality, at each exact channel count?" over all public datasets, and fills the section's `channel_hours` payload, which the dashboard's hours-of-data explorer draws.

**What it reads.**
The public catalog, `GET https://api.nemar.org/datasets?limit=200&offset=N`, called anonymously.
For an anonymous caller that endpoint lists only active, public datasets and hides sandbox datasets other than flagged exemplars (there are none today); the collector filters again (active, public, managed), so a private dataset can never reach the totals.
The catalog is not trusted to be complete.
Paging runs to an empty page, and the run fails unless the number of distinct datasets listed equals the `total_count` the catalog reports (nemar-cli reports a total as short as one page when its count query fails).
A degraded response (`fallback` or `warning` in the body) is refused, and so is a catalog far smaller than the cache directory.
The catalog reads `nemar-db`, which nemar-cli's hourly export locks between about :10 and :40, so a failing page is retried with capped backoff for about five minutes (pauses of 2, 4, 8, 16 and 32 seconds, then 60 seconds four times).
For each dataset it then reads the public Zarr index `https://nemar.s3.us-east-2.amazonaws.com/<id>/zarr/index.json` (format `nemar-zarr-index`, readable without credentials).
The collector needs only its own ingest token: no AWS key, and nothing that is not anonymously public.
It runs on nemaring because one index (nm000229) is over 300 MB, far more than a Worker can parse.
Indexes are streamed (`scripts/lib/json-stream.ts`): each `stores[]` entry is parsed on its own and dropped, so memory per index stays at the largest single entry whatever the file size.
An entry is capped at 16 MiB (the largest real one is 5.4 MB, in nm000229) and nesting inside it at 64 levels, a repeated root key is refused, and the read of one index is limited to 15 minutes and 1 GiB however slowly its bytes arrive.
A whole run peaked at about 190 to 230 MB resident when measured, and four streams each carrying one worst-case entry (millions of tiny objects) at about 680 MB.
An index must be `format_version` 3, and its own `store_count` must match the stores it lists, since a file that was cut short can still parse.

**What counts.**

- Only raw recordings: a store flagged `derived`, or from a source tree other than `raw`, is skipped.
- Each group is attributed to its own modality (`EEG`, `MEG`, `iEEG`, `EMG`, and so on; `IEEG` is shown as `iEEG`).
  A group named `MISC` takes the uppercased datatype folder of the recording's path when that folder is one of `ecg`, `eeg`, `emg`, `eog`, `ieeg`, `meg`, `nirs` or `motion` (`ecg/` gives `ECG`); in any other folder, such as `eye_tracker/` or `mov/`, it stays `MISC`.
  The index is untrusted input and the name is published, so only the contract's plain names are accepted (a letter, then letters, digits, hyphens or underscores, at most 32 long); any other value cannot be attributed and counts as unmeasured.
  Names that differ only in case are one modality.
- Within one store and one modality the duration is the longest group's and the channel count the largest group's, never a sum, because the groups of a store are concurrent streams of one recording (the same rule as nemar-cli's `aggregateRecordingStats`).
  A store with two modalities is counted once under each, and once in the headline.
- A recording with no usable duration or channel count is **unmeasured**: it is counted in `channel_hours.recordings_unmeasured` and left out of every bin.
  Unknown is never zero.
  A channel count must be a whole number from 1 to 100,000, and a duration over 10,000 hours (the longest real store is about 158) is treated as a corrupt value, counted as unmeasured, and noted in the journal.
  A store naming more than 32 distinct modalities is one unmeasured recording, and when a section would have more than 32 modalities the smallest are not shown and their recordings count as unmeasured; neither fails the run.
- Recordings that failed or are still pending carry no duration and are not part of the hours; they only enter the total of the recordings tile.
- Datasets with no Zarr index at all (a conversion that never produced one) are not scanned and not counted as unavailable, unless the catalog says their conversion is complete (`zarr_status` `ready`), in which case a missing index is a fault.

| metric | unit | value |
|---|---|---|
| `recordings.hours` | `hours` | each converted raw recording once (its longest measured modality), so it compares with the dataset-level durations in `nemar-db`; `breakdown` gives hours per modality, which can add up to more than the headline when a recording carries two signal types; severity `warn`, with a plain-words hint, when an index could not be read |
| `recordings.recordings` | `count` | measured recordings, each store once; `total` adds unmeasured and failed or pending recordings listed by the indexes read, and is omitted when any dataset could not be read |
| `recordings.datasets` | `datasets` | public datasets with at least one measured recording; `total` is every public dataset, and the tile warns when an index could not be read |
| `recordings.collector.errors` | `errors` | `0` after a successful run; a failed run replaces the section with this metric alone, at `1` and severity `error`, with a generic hint |
| `recordings.collector.code_stale` | `errors` | present only while the checkout on nemaring has been unable to update for a day; it shows on the tile and in the journal only, because `recordings` is not judged by `/health` |

`channel_hours` carries, per modality, the exact channel-count bins (`hours` and `recordings` at each count) and `dataset_peaks` (datasets whose largest recording in that modality has exactly that many channels).
It holds no dataset identifiers, and the whole section is tens of kilobytes.
The collector checks the payload against the section contract before it posts.
It cannot load zod on a bare checkout, so `assertChannelHours` repeats every rule of the contract, and a table of eighty payloads, each changing one thing, is run through both it and the real `SectionIngestSchema` to keep them the same strictness.

**Cache.**
Each dataset's summary is cached under `<state dir>/summaries/<id>.json`, keyed by the index's ETag and the summary rules' version.
A later run sends `If-None-Match`; on `304` (or a `200` with the same ETag) the cached summary is used and no body is downloaded.
A cached summary is reused only when that ETag check itself succeeded.
If the check fails (an HTTP error, a timeout, malformed or truncated JSON, an index that belongs to another dataset, a limit broken), the dataset is counted in `datasets_unavailable` for that run and its old summary is not shown as fresh; the entry stays on disk for the next successful check.
An index that was readable on an earlier run and is missing now (S3 answers 403 or 404) is unavailable too, a regression, and not "no Zarr copy".
Only a network failure, a timeout, a 5xx or 429, or a download that ends early is retried: each index is tried up to three times, with a 2 s and then a 4 s pause.
A bad document, a broken size or time limit, and an unexpected error are final for the run (a retry would download up to 300 MB again); an unexpected error is logged with its name and stack.
The cache is only an optimization.
Deleting it, or any file in it, costs one re-download.
Files are written under a unique temporary name and renamed into place, so a partial write or a concurrent run never leaves a half-written entry, and a corrupt, outdated or foreign entry is ignored.
Entries for datasets that are no longer public are deleted, but only after a run has produced a publishable result: a run that fails, or sees a catalog far smaller than the cache, prunes nothing.
Under systemd the state directory is `/var/lib/nemar-observability-recordings` (`StateDirectory=`); by hand it is `RECORDINGS_STATE_DIR`, else `~/.cache/nemar-observability/recordings`, or `--state-dir`.

**Failure behavior.**
A run fails, and publishes the generic error status the same way the other collectors do, when the catalog cannot be read in full or looks incomplete, when no index could be read, when more than a tenth of the indexes could not be read, when the unreadable indexes held more than a tenth of the hours the cache last knew for them (one dataset can hold most of the hours, so the count alone is not enough; a first run has no cache and is judged by count only), or when nothing was measured.
A smaller number of unreadable indexes still publishes: they are counted in `datasets_unavailable`, the hours and datasets tiles turn to `warn`, and the recordings total is withheld.
The push itself is tried up to four times (pauses of 5, 15 and 45 seconds) after a network failure, a 5xx or a 429, and only those outcomes are called "the write outcome may be unknown", so a run that ends that way publishes no error status that could overwrite a stored section.
A 4xx is a definite refusal: nothing was stored, the first 500 characters of the response are logged (a 422 lists the schema issues), and the failure status is tried.
The report is built before the push and nothing after a successful push can throw, so an error can no longer replace a section that was just stored.

**Trying it.**
`--dry-run` computes everything, prints a summary (including the five datasets with the most hours in each modality), and writes the payload to the path given by `--out`.
It never reads the ingest token, never posts, and never publishes a failure status.

```bash
bun scripts/push-zarr-recordings.ts --dry-run --out /tmp/recordings.json
```

The first run reads every index (about 0.5 GB); on 2026-10-06 that took 26 to 42 seconds on a laptop, and a run against a warm cache about 14 to 18 seconds.

**Schedule and health.**
The timer fires three times a day, at 06:50, 12:50 and 18:50 UTC, all after the :40 end of the hourly `nemar-db` export, and the service restarts itself 55 minutes after a failed run (limited to three starts in five hours).
A failed run replaces the section with the error status, so one run a day would leave the explorer blank for up to a day; three runs and a retry make that a matter of hours.
`recordings` is not judged by `/observability/health` or the health monitor, so a failed run, or `recordings.collector.code_stale`, shows only on the dashboard tile and in the journal (`journalctl -u nemar-observability-recordings`).
Adding `recordings` to `EXPECTED_SECTION_MAX_AGE_MS` in `src/lib/freshness.ts` is the follow-up, once it has run successfully in production.
With successful runs every 6 to 12 hours, the 26-hour allowance the other collectors have tolerates a missed run or two (about 24 hours without a success) and goes red on a third.

## Installing the collectors on nemaring

The egress and storage collectors run through `ops/with-collector-secrets.sh`, which injects the existing read-only Infisical path `prod:/observability/egress` using the existing token file `$HOME/.config/infisical/nemar-observability-egress.token`.
The storage collector reuses that path's `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`; no new AWS key or IAM change is needed.
The wrapper removes the other collectors' ingest tokens from each child's environment.
Which collector may see which secret is one table, `ops/collector-profiles.sh`, which the wrapper sources and `test/collector-env.test.ts` runs under real bash.
The recordings collector runs through the same wrapper; it needs no AWS key and the wrapper removes it from that child as well (see "Installing the recordings collector" below).

A human must first create one new secret, in two places, with a fresh random value (for example `openssl rand -hex 32`):

1. In Infisical project `nemar` (ID `817f7473-a318-4e99-9cf4-a89db057f5fc`), environment `prod`, path `/observability/egress`, add `OBS_STORAGE_INGEST_TOKEN`. (The egress collector still needs its own `OBS_EGRESS_INGEST_TOKEN` there, with a matching `egress` entry in the Worker secret, if that is not done yet.)
2. Add the same value under key `storage` in the production Worker secret `OBS_INGEST_TOKENS_JSON`, keeping every existing entry (such as `egress`) and a distinct value per key: `npx cfman wrangler --account sccn secret put OBS_INGEST_TOKENS_JSON -c wrangler.toml`.

Then, on nemaring, install the units once.
Never run `git` as root in the checkout: the services pull as `yahya`, and root-owned objects make that pull fail.
`ops/install-units.sh` repairs the ownership, installs every collector's units, and enables every timer, the recordings timer included.
On a fresh host, create the recordings token first (steps 2 and 3 of "Installing the recordings collector" below), or its first runs fail in the journal with a missing-token error and publish nothing.

```bash
# Fresh host only: /opt is root-owned, so create the directory for yahya first.
[ -d /opt/nemar-observability/.git ] || {
  sudo install -d -o yahya -g yahya /opt/nemar-observability
  sudo -u yahya git clone https://github.com/nemarOrg/nemar-observability.git /opt/nemar-observability
}
sudo -u yahya git -C /opt/nemar-observability pull --ff-only
sudo /opt/nemar-observability/ops/install-units.sh
# First install only: the one-time egress backfill.
sudo -u yahya env HOME=/home/yahya \
  PATH=/home/yahya/.local/bin:/home/yahya/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  EGRESS_START_DATE=2026-08-01 \
  /opt/nemar-observability/ops/with-collector-secrets.sh /opt/nemar-observability/scripts/push-s3-egress.ts
sudo systemctl start nemar-observability-egress.service nemar-observability-storage.service
journalctl -u nemar-observability-egress.service -u nemar-observability-storage.service -n 100 --no-pager
```

After this, collector code updates itself: every collector run first starts `nemar-observability-update.service` (`Wants=` and `After=` in the collector units), which runs `ops/update-checkout.sh` as `yahya` and resets the checkout to `origin/main`, so merging to `main` is the deploy for the collectors as well as the Worker.
It resets rather than pulls, so a dirty tree, a stray local commit, or another branch cannot block it.
The update service is the only unit that can write to the checkout and it holds no secrets; the collectors, which hold the AWS key and the ingest tokens, cannot write to it.
A failed update does not block the collection.
It records when the failures began in `/var/lib/nemar-observability/update-failed-since` (the update service's systemd `StateDirectory`, outside the checkout), and once that is a day old each collector publishes an error metric (`egress.collector.code_stale`, `storage.collector.code_stale`, `recordings.collector.code_stale`).
For egress and storage that turns `/observability/health` red and opens a health-alert issue; `recordings` is not judged by health, so its metric shows only on the dashboard tile and in the journal.
The next successful update clears it.
Only a change under `ops/systemd/` needs `sudo /opt/nemar-observability/ops/install-units.sh` again.
The update trusts `main` with the collectors' secrets exactly as the Worker deploy does, so keep branch protection (green CI) on `main`.

Afterward, confirm `storage.bucket_bytes` in `GET /observability/api/snapshot?cb=$(date +%s)` (the snapshot picks up a push at the next hourly cron) and the egress dates in `GET /observability/api/timeseries`.
If either run failed, disable its timer with `sudo systemctl disable --now nemar-observability-<name>.timer` until the cause is fixed. `ops/install-units.sh` leaves a timer you disabled that way disabled; re-enable it with `sudo systemctl enable --now nemar-observability-<name>.timer`.
The storage timer runs at 08:45 and 14:45 UTC with up to 2 minutes of randomized delay, so a failed first run retries itself.
It is not hourly because S3 publishes a day's size some time during the next UTC day and the collector rejects a value older than the previous UTC day, so early-morning runs could report a failure that is only S3 catching up.

### Installing the recordings collector

Merging this change does not start the new collector: its service and timer exist only in the repository until a person installs them on nemaring, and the collector posts only once it has its token.
Two other things do go live on merge.
`ops/with-collector-secrets.sh` and the new `ops/collector-profiles.sh` are shared with the egress and storage collectors, which update themselves to `origin/main` before every run, so the new wrapper starts running them at their next run after the merge (egress at :15, storage at 08:45 or 14:45).
Egress and storage should see exactly the environment they saw before, which is tested under bash 3.2 and 5, but step 6 below is to check that on the host.
And the Worker deploy runs for any merge to `main`.

Do these in order.
Until steps 2 and 3 are done, the recordings timer must not be enabled, so do not run `install-units.sh` before them: it enables every timer, and a recordings run without its token fails in the journal and publishes nothing.

1. **Make sure the Worker that knows `channel_hours` is deployed first.**
   That is the Worker with the contract from #108.
   An older Worker's section schema is not strict about that field, so it answers 200 and silently drops the payload.
   Merge #108 and wait for its deploy job (it ends by checking `/health`) before the first push.
2. **Create the ingest token and store it in Infisical.**
   Generate a fresh value (for example `openssl rand -hex 32`).
   In Infisical project `nemar` (ID `817f7473-a318-4e99-9cf4-a89db057f5fc`), environment `prod`, path `/observability/egress`, add `OBS_RECORDINGS_INGEST_TOKEN`.
   The same read-only token file as the other collectors reads it; no new token file, AWS key, or IAM change is needed.
3. **Add the same value under key `recordings` in the production Worker secret `OBS_INGEST_TOKENS_JSON`.**
   The secret is one JSON object, `wrangler secret put` replaces it whole, and Cloudflare cannot read the old value back, so the command below rebuilds it from the tokens Infisical holds.
   It writes exactly four keys, `egress`, `storage`, `recordings` and `website`, and removes any other key the secret has now; if you know of another pusher with a token in it, add it to the command first.
   The values must be distinct: with a duplicate the Worker answers 503 to every pusher, so the command refuses to send duplicates or a missing token.
   Run it from the root of this repository (it reads `wrangler.toml`), and with an Infisical login that can read `/observability/website` as well as `/observability/egress`: the scoped token file on nemaring covers only the egress path, so run this on your own machine.
   It never prints a token, and `wrangler secret put` deploys a new Worker version immediately.

   ```bash
   set -o pipefail
   TOKENS_JSON="$({
     infisical --domain https://infisical.nemar.org run \
       --projectId 817f7473-a318-4e99-9cf4-a89db057f5fc --env prod \
       --path /observability/egress --silent -- \
       sh -c 'printf "%s\n%s\n%s\n" "$OBS_EGRESS_INGEST_TOKEN" "$OBS_STORAGE_INGEST_TOKEN" "$OBS_RECORDINGS_INGEST_TOKEN"'
     infisical --domain https://infisical.nemar.org run \
       --projectId 817f7473-a318-4e99-9cf4-a89db057f5fc --env prod \
       --path /observability/website --silent -- \
       sh -c 'printf "%s\n" "$OBS_WEBSITE_INGEST_TOKEN"'
   } | bun -e 'const [egress, storage, recordings, website] = (await Bun.stdin.text()).trim().split("\n"); const tokens = [egress, storage, recordings, website]; if (!tokens.every(Boolean)) throw new Error("a token is missing"); if (new Set(tokens).size !== tokens.length) throw new Error("two tokens are the same"); process.stdout.write(JSON.stringify({ egress, storage, recordings, website }))')" \
     && printf '%s' "$TOKENS_JSON" |
       env -u CLOUDFLARE_API_TOKEN npx cfman wrangler --account sccn \
         secret put OBS_INGEST_TOKENS_JSON -c wrangler.toml
   unset TOKENS_JSON
   ```

4. **Install the units on nemaring**, once this change is on `main` and steps 1 to 3 are done.
   The checkout updates itself at the next collector run, or pull it now; never run `git` as root there.
   `ops/install-units.sh` installs the recordings service and timer next to the others and enables the timer; it leaves a timer you disabled on purpose disabled.

   ```bash
   sudo -u yahya git -C /opt/nemar-observability pull --ff-only
   sudo /opt/nemar-observability/ops/install-units.sh
   ```

5. **Optional check without any secret.**
   A dry run reads the public catalog and indexes and prints the totals; it posts nothing.
   It fills its own cache under `~/.cache/nemar-observability/recordings`, not the service's.

   ```bash
   sudo -u yahya env HOME=/home/yahya \
     PATH=/home/yahya/.local/bin:/home/yahya/.bun/bin:/usr/local/bin:/usr/bin:/bin \
     /home/yahya/.bun/bin/bun /opt/nemar-observability/scripts/push-zarr-recordings.ts \
     --dry-run --out /tmp/recordings.json
   ```

6. **Start the first run** (it reads every index once, about 25 to 40 seconds with a good connection) and read the journal.
   A good run ends with `posted N modalities`.
   Then read the journals of the egress and storage services: their next runs after the merge use the new wrapper, and each must still end with its usual `posted` line.

   ```bash
   sudo systemctl start nemar-observability-recordings.service
   journalctl -u nemar-observability-recordings.service -n 80 --no-pager
   journalctl -u nemar-observability-egress.service -u nemar-observability-storage.service -n 40 --no-pager
   ```

7. **Confirm the section.**
   The snapshot picks up a push at the next hourly cron (:47).
   Look for section `recordings` with a `channel_hours` payload in `GET /observability/api/snapshot?cb=$(date +%s)`.

The timer runs three times a day, at 06:50, 12:50 and 18:50 UTC with up to 2 minutes of randomized delay, clear of the egress collector (hourly at :15), the storage collector (08:45 and 14:45), and the snapshot cron (:47), and after the hourly `nemar-db` export.
A failed run is tried again 55 minutes later, at most three starts in five hours.
If a run keeps failing, `sudo systemctl disable --now nemar-observability-recordings.timer` stops it until the cause is fixed.
Code updates need no further step: every run first starts the update service, like the other collectors, and publishes `recordings.collector.code_stale` once the checkout has been unable to update for a day.
That metric, and a failed run, show only on the dashboard tile and in the journal: `recordings` is not judged by `/health`, so nothing opens a health-alert issue for it.
Only a change under `ops/systemd/` needs `install-units.sh` again.

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
