# nemar-observability Research Notes

## Data sources (nemar-cli `nemar-db.datasets`, all indexed)
- `visibility` (public|private), `status` (active|archived|deleted), `is_sandbox`, `owner_user_id` (=-1 = folded catalog sentinel, exclude).
- `concept_doi`, `latest_version_doi`; `dataset_versions` table for published version count.
- `zarr_status` (pending|ready|failed|NULL), `zarr_store_count` (migration 0035).
- `archive_status` (pending|ready|failed|NULL), `archive_size`, `archive_checked_at` (migration 0036, this epic).
- `nemar_sync_status` (synced|pending|failed) — legacy nemar.org dataexplorer sync.
- `license_tier` (public|attribution|sharealike|noncommercial|noderiv|unknown), `modalities` (csv), `file_size`, `last_activity_at`.
- `publication_requests` (status requested|approving|published|denied|blocked; `prescreen_status`).
- `users` (status pending|verified|approved|revoked; role), `tokens` (revoked_at).

## Canonical predicates (match nemar-cli so counts agree)
- managed (exclude catalog): `owner_user_id != -1`
- exclude sandbox: `(is_sandbox = 0 OR is_sandbox IS NULL)`
- public: `status = 'active' AND visibility = 'public'`
- `/admin/stats` counts ALL non-catalog rows regardless of status/visibility (headline differs from the public count by design).

## Analytics Engine (`nemar_access_metrics`)
- Written by nemar-cli data-plane (`recordAccess`): `index1/blob1 = dataset_id`, `blob2 = source` (archive|zarr|file), `blob3 = detail` (version | index|metadata|chunk), `double1 = bytes`.
- Read via account-scoped SQL API: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql` with a Bearer token (Account Analytics Read). Account id `da8d7a2a8680dab01592bbbc6f67f12c`.
- **Sampling:** use `SUM(_sample_interval)` for counts, never `COUNT(*)`. `double1` for bytes (archive bytes are 0 — Worker 302s to S3).

## Cloudflare specifics
- SCCN account; cfman gotchas: `env -u CLOUDFLARE_API_TOKEN`, pass `CLOUDFLARE_ACCOUNT_ID` if account won't resolve.
- A separate Worker can bind the same D1 by `database_id` (read-only by discipline). AE reads need no binding (SQL API + token).
- Worker route over Pages: `dashboard.nemar.org` is the `nemar-dashboard` Pages project; a Worker route on `/observability*` takes precedence per-path.

## Data-egress coverage

Keep these three byte measures separate:

- **Cloudflare edge response bytes** — `cf.bytes` / `cf.bytes_by_host` from zone
  analytics. The GraphQL metric is `sum.edgeResponseBytes`; it covers HTTP responses that
  traverse the Cloudflare zone and excludes direct S3-hosted presigned downloads. Cloudflare
  provides aggregated usage data
  ([API limitations](https://developers.cloudflare.com/analytics/graphql-api/),
  [edge byte field](https://developers.cloudflare.com/analytics/graphql-api/migration-guides/graphql-api-analytics/)).
- **NEMAR Worker and Zarr request bytes** — the local `nemar-cli` `origin/dev` ref at
  `d9dc21c0` (2026-09-25) records archive redirects as events with zero body bytes. Zarr
  responses proxied through the Worker record response `content-length`; some cache-hit events
  can still have zero bytes if that header is unavailable. Some Zarr chunks return a 302 to
  public S3: their `chunk-redirect` event stores the requested Range length, or zero when no
  Range was requested. That is download intent, not confirmed S3 delivery, and must not be
  summed as served bytes. This checkout's `dev` branch is 38 commits behind that local
  `origin/dev` ref, and production deployment state was not checked.
- **Direct S3 response bytes** — S3 request metrics include `BytesDownloaded`, the response
  body bytes for requests to a bucket. Metrics are scoped by a configured bucket metrics filter
  (such as prefix, tag, or access point). AWS describes request-metric delivery as best-effort,
  with no guarantee of completeness or timeliness
  ([metrics and dimensions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html)).
  For this dashboard, collect the bucket-wide total at daily resolution; derive week, month, and
  custom-range views from the daily points. It includes conversion reads and is not per-client,
  location, or website/API access data. This is the S3 download amount for the observability
  chart.

No request-level S3 caller, machine, or location attribution is needed for this observability
goal. Keep source/location analysis in the Umami, Cloudflare, and API analytics planes. If
request logging or job-level attribution becomes a separate future requirement, it needs its own
privacy and cost review; it is not a dependency for the daily S3 total.

The AWS audit on 2026-09-26 confirmed that `nemar` is in `us-east-2` and already has the
`EntireBucket` request-metrics configuration. `AWS/S3:BytesDownloaded` returned
172,308,121,634,005 bytes (172.3 TB decimal / 156.7 TiB) over the trailing ten days ending
2026-09-26 06:59 UTC. This is bucket-wide response-body volume across all requesters; it includes
conversion reads and does not identify a machine. The metric is best-effort. The query returned
14,398 minute datapoints, ending a few minutes before query time.

S3 server access logging is disabled (`GetBucketLogging` returned no target). The available
historical sources do not establish whether the reported ~40 TB came from one machine. Enabling
logging now cannot recreate missing per-request history, but machine-specific history is outside
the requested dashboard metric.

### AWS audit and forward collection

The live bucket and region are verified as `nemar` in `us-east-2`. The IAM user
`nemar-hallu-readonly` exists with one active access key, last used for S3 on 2026-09-26. Its
inline policy grants read access to objects and metadata in `nemar`, but no CloudWatch
permissions. Do not reuse or broaden this credential; it may be in active use.

Read-only checks verified the bucket region, disabled server logging, and the existing
`EntireBucket` request-metrics filter. The collector can query `AWS/S3:BytesDownloaded` with
`Sum` and dimensions `BucketName=nemar`, `FilterId=EntireBucket` for a selected UTC range. S3
request metrics are opt-in, become available after a short setup delay, and are best-effort. They
covered the historical ten-day interval only because the filter was already enabled, and they do
not identify a source machine. AWS
references:
[metric definition and dimensions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html),
[request-metric setup and delay](https://docs.aws.amazon.com/AmazonS3/latest/userguide/configure-request-metrics-bucket.html),
[configuration filters](https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-configurations.html).

On 2026-09-26, a dedicated IAM user `nemar-observability-cw-reader` was created using the
authenticated **default** AWS profile. Its inline policy `CloudWatchMetricsReadOnlyUsEast2`
allows only `cloudwatch:GetMetricData`, with `aws:RequestedRegion` restricted to `us-east-2`.
It has no console password, S3 object permissions, or `cloudwatch:ListMetrics` permission. AWS
requires `Resource: "*"` for this CloudWatch read, so IAM cannot limit it to the one S3 metric;
the collector must query only `AWS/S3:BytesDownloaded` with the verified dimensions. The default
profile was verified as `arn:aws:iam::191754232783:user/yahya`. One key was created on
2026-09-26 and is active. IAM simulation allows `cloudwatch:GetMetricData` in `us-east-2` and
denies `cloudwatch:ListMetrics` and `s3:GetObject`; `cloudwatch:GetMetricStatistics` is also not
granted, so use `GetMetricData` in the collector. The key was streamed directly to nemaring for
Infisical storage; its values were not written to the local checkout or command output.

On nemaring, the bare-metal host is Ubuntu 24.04 x86_64 with 8 cores and about 8 GB RAM. Its
Docker host runs Infisical v0.161.10, the database, Redis, and Cloudflare tunnel. Infisical is
bound to `127.0.0.1:8080`; `/api/status` returns 200 locally, while the public hostname redirects
through Cloudflare Access. The Infisical CLI v0.43.137 is installed at
`/home/yahya/.local/bin/infisical` from the official release after checksum verification. AWS CLI
v2.37.4 is installed at `/home/yahya/.local/bin/aws`. The `nemar` Infisical project has production
environment slug `prod`; `prod:/observability/egress` now contains `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and `AWS_REGION=us-east-2`. The values were stored through the CLI and
were never displayed. A 12-month read-only service token scoped to that exact path remains at
`/home/yahya/.config/infisical/nemar-observability-egress.token` (mode `0600`); the one-day
read/write bootstrap token was revoked after the write and its local file removed. No temporary
AWS key file or staging helper remains. The existing `nemar-automation` identity has Admin access
at organization scope; do not reuse it. The host does not currently run an Umami container.
The Umami Worker key has not been installed or verified in Infisical. The planned dedicated path
is `/observability/website`; do not treat the AWS egress path as an Umami secret source.

On 2026-09-26, the read-only Infisical token loaded the stored AWS credential into a CloudWatch
`GetMetricData` query for `AWS/S3:BytesDownloaded`, bucket `nemar`, filter `EntireBucket`, region
`us-east-2`. The trailing ten-day, hourly-sum query returned 172,752,276,164,103 bytes (~172.75
TB decimal). This confirms the read path works. The production collector still needs to persist
daily totals and expose a date-range chart. The metric is best-effort and bucket-wide, including
conversion reads; it does not attribute bytes to a source.

### Current implementation verification (2026-09-26)

The earlier audit above is a historical record and is not a current acceptance result. During
the S3-egress collector implementation, the scoped token file on nemaring was used with the
installed Infisical CLI against `https://infisical.nemar.org`, project `nemar`, environment
`prod`, and path `/observability/egress`. Both `infisical run` and `infisical export` reported or
returned zero variables, including when the token and domain were passed explicitly. A names-only
check found `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` absent from the child
process. No AWS query was made in that attempt, no credentials were printed, and no AWS profile
was substituted. A read-only inspection of the Infisical UI at
`https://infisical.nemar.org` confirms project `nemar` (ID
`817f7473-a318-4e99-9cf4-a89db057f5fc`), a service token named
`nemaring-observability-egress-readonly` scoped to `prod` and
`/observability/egress`, and the three AWS secret names in the Production
environment. The public API returned HTTP 302 through Cloudflare Access while
`http://127.0.0.1:8080/api/status` returned 200. With the local origin, the CLI
injected exactly `AWS_ACCESS_KEY_ID`, `AWS_REGION`, and
`AWS_SECRET_ACCESS_KEY`; values were never printed. The verified run used:

```bash
INFISICAL_TOKEN="$(<"$HOME/.config/infisical/nemar-observability-egress.token")" \
INFISICAL_DISABLE_UPDATE_CHECK=true \
  "$HOME/.local/bin/infisical" run \
  --domain http://127.0.0.1:8080 \
  --projectId 817f7473-a318-4e99-9cf4-a89db057f5fc \
  --env prod --path /observability/egress --include-imports=false --silent -- \
  sh -c 'env | awk -F= '\''/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION)=/ {print $1}'\'' | sort'
```

The CloudWatch `GetMetricData` query for `AWS/S3:BytesDownloaded`, dimensions
`BucketName=nemar` and `FilterId=EntireBucket`, region `us-east-2`, period
86400, `Sum`, and the complete UTC window 2026-09-16 through 2026-09-25
returned ten daily points with status `Complete`: 172,303,899,209,715 bytes
(172.304 TB decimal, about 156.7 TiB). The exclusive end timestamp was
2026-09-26 00:00 UTC. This bucket-wide response-byte metric includes conversion
reads and does not attribute bytes to callers. The section-ingest token is not
among the three secrets currently shown, so no push or scheduled collector
run has been accepted yet.

To confirm the requested initial backfill window, the same read-only query ran
from 2026-08-01 00:00 UTC inclusive through 2026-09-26 00:00 UTC exclusive.
CloudWatch returned status `Complete`, all 56 expected daily points, and no
missing UTC dates, totaling 386,294,472,966,476 bytes (386.294 TB decimal).
This confirms source coverage for the planned baseline; the 56 points have not
yet been posted to the dashboard.

| UTC day | `BytesDownloaded` sum (bytes) |
|---|---:|
| 2026-09-16 | 8,053,428,080,289 |
| 2026-09-17 | 10,461,047,784,377 |
| 2026-09-18 | 7,313,552,117,828 |
| 2026-09-19 | 11,775,700,721,952 |
| 2026-09-20 | 25,488,230,354,921 |
| 2026-09-21 | 24,641,868,722,543 |
| 2026-09-22 | 39,300,541,973,860 |
| 2026-09-23 | 16,992,424,893,398 |
| 2026-09-24 | 17,489,575,046,853 |
| 2026-09-25 | 10,787,529,513,694 |

Do not grant write permissions to inspect or collect the metric. Add log-destination
`s3:ListBucket` and `s3:GetObject` only if a retained access-log destination is later configured
and needs querying. AWS references:
[S3 API-to-IAM action mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html),
[CloudWatch IAM action mapping](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html).

### Usage measures and time-range charts

The existing access section queries a fixed 30-day Analytics Engine window. It counts archive
redirects issued (download intent, not confirmed completion), Zarr `index.json` opens, and
Worker-served chunk requests. The producer uses a separate `chunk-redirect` detail for Zarr
requests redirected to S3; `double1` on those events is only the requested Range length. The
current access section does not count `chunk-redirect` events, so new usage charts should show
those requests separately and never sum their requested bytes into a delivered-byte metric. It
ranks the most-used public datasets by Worker-served Zarr chunk bytes and uses
`SUM(_sample_interval)` because Analytics Engine samples writes. These are request/event counts,
not unique people, and the event schema has no client dimension to deduplicate bots or sessions.

The dashboard's current history endpoint extracts at most 168 hourly snapshots (about one week)
for a metric. It cannot serve arbitrary date ranges or true per-day/week/month bins from the
current access summary, and the page has no range selector or charts. Query each source for daily
points over the selected range, then let the browser group additive values into days, weeks, or
months and plot them. This applies to Analytics Engine archive/Zarr events, Umami page and custom
events, and CloudWatch S3 response bytes. Use the website/API analytics planes for access
patterns and location. Do not sum daily unique-session counts to claim a range-wide unique count;
fetch non-additive measures for the selected range from their source or show them as daily values.
Include a custom start/end range, timezone, coverage, and freshness. The current page is
Worker-rendered with a small client script; select a chart library/framework during implementation
planning to fit that architecture.

The live 2026-09-26 snapshot shows another comparability issue: its Cloudflare 30-day headline
is 730,918,057,075 bytes (~731 GB), while the accumulated host query assigns
113,823,062,762,250 bytes (~113.8 TB) to `nemar.s3.us-east-2.amazonaws.com`. The host query uses
`httpRequestsAdaptiveGroups` and `sum(edgeResponseBytes)`, but has no `requestSource` filter; the
zone headline comes from `httpRequests1dGroups.sum.bytes`. Cloudflare documents
`requestSource: "eyeball"` as the filter for end-user requests, while the adaptive dataset can
include Cloudflare product requests. This is a likely source of the mismatch, but the two series
need a same-window/same-source comparison before either is used for a Cloudflare-vs-S3 share.
The host history is persisted daily, so changing its query also requires a backfill or an explicit
coverage boundary; otherwise one chart would mix old and corrected semantics.

Instrument citation links with an Umami custom event on user activation. Report citation-click
events and anonymous sessions that clicked; Umami's visitor/session estimate is not a count of
identified people. Instrument viewer-open and meaningful viewer-control events in the frontend.
Visible time may be added as optional context, but should not be the success KPI. Do not send
dataset URLs with query strings, raw search terms, presigned URLs, or identifying session data.

The existing whole-bucket request-metrics filter covers the historical window in this audit;
future daily collection can use the same filter. If a future use case asks for caller-level
attribution, request logs or CloudTrail object data events would be a separate design. They are
not needed for the dashboard's bucket-wide daily byte series.

Umami answers website-use questions (page views, visitors, sessions, events, and visit duration),
not completed file-transfer byte counts. Its built-in visit duration is the time between the
first and last event in a visit and is only calculated for visitors with more than one page. For
a single-page dataset viewer, add privacy-preserving custom events for opening the viewer,
interacting with its controls, and visible engagement time. Umami's tracker supports custom event
names and data; its self-hosted stats API accepts `startAt` / `endAt` timestamps and a timezone,
so day/week/month selectors can use consistent explicit windows
([self-host install](https://docs.umami.is/docs/install),
[website stats API](https://docs.umami.is/docs/api-reference/get-website-stats),
[metric definitions](https://docs.umami.is/docs/metric-definitions),
[custom tracker events](https://docs.umami.is/docs/tracker-functions)). A browser “download
started” event can help explain activity, but it does not prove the S3 response completed or
measure its body bytes. Keep individual session views in Umami's authenticated admin dashboard;
only send aggregate, anonymous section data to the public observability snapshot. Do not track
distinct IDs, emails, raw search terms, object keys, query-string signatures, or presigned URLs.

Use explicit rolling windows (24 hours, 7 days, 30 days) or clearly labeled UTC calendar windows
across sources. Include each source's coverage start, last successful collection time, and
quality state. Missing or expired source coverage is `unknown`, never a numeric zero. A response
proxied through a Worker can appear in S3 origin bytes and Cloudflare edge bytes. Keep the source
measures separate; do not add them into a deduplicated client-delivered total.

### Range visitors and geography source contract (2026-09-27)

Umami's `GET /api/websites/{websiteId}/stats` returns `pageviews`, `visitors`,
and `visits` for the selected range. Its `GET /metrics?type=country` returns
ranked values for the country dimension; visitor dimensions count unique
visitors. Query country values only for one completed UTC day. Use explicit UTC
millisecond bounds and keep the API key server-side.
The public labels should say **Umami visitors (unique-session estimate)** and
**visits**, not identified people. Umami's visitor estimate is derived from a
session hash whose salt rotates monthly, and a visit hash has a finer hourly
rotation. Counts across time buckets therefore must not be added into a
distinct-person total. The country endpoint omits empty country values; a
country breakdown may not sum to that day's visitor total. Suppress small
country groups before publishing. Multi-day ranges and the current/future day
do not return country values, so overlapping queries and changing live counts
cannot be used to subtract withheld daily cells.

The Phase 5 country map uses Cloudflare's zone rollup
`httpRequests1dGroups.sum.countryMap` and shows HTTP request counts by country.
One request is one HTTP resource/API call; one page view can create multiple
requests. Repeat clients, bots, and other automated traffic can be included, so
this is not a count of people, sessions, or page views. Keep the public label
plain ("Requests to NEMAR" / "requests by country") and explain this in the
location details; never convert request counts into an estimated number of
visitors or sessions.

Cloudflare also exposes a separate `visits` measure on
`httpRequestsAdaptiveGroups`; Cloudflare defines a visit by a page view that
originated from another site or a direct link, and one visit can contain
multiple page views. This is not Umami's anonymous unique-session estimate and
is not available in the existing country-map rollup, so it must not be used to
reinterpret these country request counts. Use Umami page views and
unique-session estimates for website audience measures when configured. The
current UTC day is omitted from the country map because its counts can change
between requests; future dates have no observations yet. The existing
integration queries a 30-day window; Cloudflare dataset query limits and
retention are specific to each zone/account, so the dashboard should report the
actual covered subrange and avoid assuming arbitrary historical coverage. A
source outage, unconfigured secret, or range outside its data window is
unavailable/partial rather than zero.

### Dashboard range map and hover behavior (issue #72, 2026-09-27)

The Cloudflare map follows the selected usage range. The API carries separate
`country_coverage` and `country_requests` values: map coverage includes only
completed UTC days, while the request total may include the in-progress day and
is explicitly marked partial. For each completed day, apply the existing
minimum-10 country rule first. Add only those daily published rows across the
selected range; keep each day's `Other / withheld` aggregate pooled and omit it
when that day's combined small rows do not reach 10. This ensures that a long
range cannot make an otherwise suppressed daily country row appear. Cloudflare
range coverage remains bounded by its current 30-day query window, and the map
shows the actual country coverage dates.

Umami country values remain a source-native anonymous unique-session estimate
for exactly one completed UTC day. They are never summed across days. When a
multi-day range is selected, the map's website-session source is unavailable
for that range; the Cloudflare request map remains available independently.
S3 byte egress is bucket-wide across NEMAR data planes, includes internal
conversion reads, and has no country attribution.

Time-series points and map regions expose the UTC period and exact measure on
pointer hover and keyboard focus. The chart tooltip also shows a human-readable
byte amount alongside the exact byte count. The dashboard main content, series
cards, and map have capped desktop widths; the map stacks its summary under the
map on narrow screens.

Current primary references checked against official docs on 2026-09-27:

- Umami [website summary stats API](https://docs.umami.is/docs/api-reference/get-website-stats)
- Umami [ranked metrics API](https://docs.umami.is/docs/api-reference/get-website-metrics)
- Umami [metric definitions](https://docs.umami.is/docs/metric-definitions)
- Umami [self-hosted API overview](https://docs.umami.is/docs/api)
- Cloudflare [GraphQL limits and per-dataset range constraints](https://developers.cloudflare.com/analytics/graphql-api/limits/)
- Cloudflare [filtering and date bounds](https://developers.cloudflare.com/analytics/graphql-api/features/filtering/)
- Cloudflare [HTTP request and visit measures](https://developers.cloudflare.com/analytics/graphql-api/migration-guides/graphql-api-analytics/)
- Cloudflare [what Analytics counts and how it differs from browser analytics](https://developers.cloudflare.com/analytics/faq/about-analytics/)

### Infisical public-host access and current S3 egress receipt (2026-09-27)

The 2026-09-26 notes above record the state before the Cloudflare Access
change: `infisical.nemar.org` redirected unauthenticated CLI requests to the
email challenge. On 2026-09-27, the Cloudflare Access policy for the exact
`infisical.nemar.org` application was changed to `Bypass / Everyone`; the
Cloudflare Tunnel's hostname-to-origin route did not change. A public
`GET https://infisical.nemar.org/api/status` then returned HTTP 200 with zero
redirects. Nemaring's Infisical CLI authenticated through the public HTTPS
hostname using its existing path-scoped read-only service token and injected
the expected names `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_REGION`. It did not expose their values. `OBS_EGRESS_INGEST_TOKEN` was
absent from the path. Infisical native authentication remains enabled; public
signups are disabled and the administrator's passkey MFA was verified. The
Cloudflare Access email challenge is gone for this hostname, but Cloudflare
Access policy enforcement and its request logging no longer protect it.

The corrected collector wrapper now targets `https://infisical.nemar.org`
directly. Do not switch it to `127.0.0.1`; that would hide the Access-policy
configuration problem and make automation depend on a local listener. The
historical loopback commands above explain the earlier successful test only.

A fresh read-only AWS CloudWatch `GetMetricData` query used metric
`AWS/S3:BytesDownloaded`, `Stat=Sum`, `Period=86400`, dimensions
`BucketName=nemar` and `FilterId=EntireBucket`, region `us-east-2`, and the UTC
range 2026-08-01 inclusive to 2026-09-27 exclusive. The response was complete
with 57 expected daily points and no missing dates, totaling
394,926,061,470,340 bytes (394.926 TB decimal). This is the entire bucket's
response-byte total, so Zarr conversion reads and other internal reads are
included. It is not an estimate of one person's client-side download volume.
On nemaring, AWS CLI serialized the UTC-midnight timestamps with its local
`-07:00` offset: the first was `2026-07-31T17:00:00-07:00` (2026-08-01 UTC),
and the last was `2026-09-25T17:00:00-07:00` (2026-09-26 UTC). Do not assign
the UTC date by taking the raw timestamp's first ten characters. The collector
parses the timestamp and converts it with `toISOString()` before choosing its
UTC day; the captured-offset parser test covers this behavior.
The points have not yet been pushed to the observability API. Production also
does not yet have the `OBS_INGEST_TOKENS_JSON` Worker secret map, so the
section-keyed `egress` push and systemd timer remain disabled pending secure
provisioning and live API/chart acceptance.
