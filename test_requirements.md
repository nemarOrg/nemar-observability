# Test Requirements

## Phase 5 audience reporting

The current repository tests do not exercise the Umami or Cloudflare audience
HTTP paths. Do not add mocked responses or invented analytics values to fill
that gap; `.rules/testing.md` requires real data and services. The owner-managed
Umami service is not installed at `/opt/nemar-umami` on nemaring yet, and the
public analytics host is still behind Cloudflare Access, so a real provider
query is not currently available from this checkout.

When an authorized staging Umami instance and Cloudflare test source are
available, capture sanitized real provider responses and add integration
coverage for selected-range values, verified event coverage, a measured zero,
partial source coverage, and the response contract. Real upstream failure
behavior should be verified against an authorized environment that can produce
an actual endpoint failure; do not substitute a stub server or mocked `fetch`.

Until then, the relevant external acceptance gates remain nemar-umami#1 and
website#345. Static typechecking, linting, and the existing repository test
suite do not prove live audience integration.

## Dashboard browser acceptance

The previous `ui-render.test.ts` harness ran the client script against a fake
DOM and supplied invented snapshot and daily-series values through fake
`fetch` responses. That harness was removed to comply with `.rules/testing.md`.
The replacement checks only real server-rendered markup. Do not add another
mocked browser surface or fabricated snapshot or time-series response.

On 2026-09-27, the production `/observability/api/timeseries` query for
2026-08-01 through 2026-09-26 returned no reporting series, and the Umami host
setup was still incomplete. Therefore no regression test was added for a series
whose selected range starts after its coverage ends: the real-data prerequisite
is unavailable and a hand-authored `SERIES` fixture would violate the project
rule. After Umami or another authorized real source is active, use Chrome on the
dashboard to select a range after the source's reported `coverage_end`; verify
the source, latest observation, freshness status, and empty selected-range
values remain visible.

The same real-browser acceptance is required after a source publishes daily
points. Use ranges that start and end midweek and midmonth. Verify calendar
alignment and partial-period labels, displayed bucket totals against the selected
daily API points, unknown gaps, and stale-source metadata. With a real production
snapshot containing representative metrics, also verify tile rendering and
formatting, drilldown links, and the `section_errors` banner. Record the source,
selected UTC dates, snapshot/API revision, deployed revision, and observed
results. CI currently covers none of these client-side behaviors; do not claim
otherwise before the browser acceptance is complete.

## Signal viewer: captured embed answers

The rules for what the public page may name (`src/lib/embeds.ts`), the daily store
(`src/lib/embed-store.ts`) and the page are tested on explicit inputs, a real SQLite store with
the real migrations, and the real Worker. What is not covered yet is the edge's own answer to the
embed queries, because reading `nemar_website_embeds_dev` needs `CF_ANALYTICS_TOKEN` on the dev
Worker and none was set when this was written (`secret list --env dev` showed only
`CF_ZONE_ANALYTICS_TOKEN`). Do not invent those answers.

Once the secret is installed on the dev Worker and the branch is deployed there:

1. Capture the answer of each query in `embedDaysSql`, `embedSitesSql`, `embedDatasetsSql` and
   `embedTotalSql` over the 2026-10-05 09:55 to 10:30 UTC test window (hosts `localhost`,
   `127.0.0.1`, `example.org`, `after-review.invalid`; kinds `iframe`, `document`, `none`) into
   `test/fixtures/embed-*.json`, with the query text and the capture time beside the response, as
   the existing `audience-*.json` fixtures do.
2. Add tests that run `parseEmbedDayRows`, `buildEmbedDays`, `summarizeEmbedSites` and
   `summarizeEmbedDatasets` over them, including that `localhost` and `127.0.0.1` are never named
   and that no host from the `must-not-count` requests appears.
3. Capture one real `GET /observability/api/embeds` answer from the dev Worker and add a page test
   that draws it, so the ranked lists are exercised on a real payload.
4. Run the success path of `syncEmbedDays` against that capture. Until then only its not
   configured and refused-read paths are tested.
