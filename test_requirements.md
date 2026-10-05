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

## Signal viewer: embed answers

The Analytics Engine answers in `test/fixtures/embed-ae-*.json` and the `/embeds` answer in
`test/fixtures/embeds-api-2026-09-06-to-2026-10-05.json` were captured on 2026-10-05 from the dev
Worker (dataset `nemar_website_embeds_dev`, the website's staging and preview test traffic), read
through a temporary diagnostic route that was never merged. `test/embed-captured.test.ts` and
`test/viewer-entry.test.ts` run the rules and the page over them.

Still not covered by a real capture, and why:

- A site at or above the floor, and a public dataset, being named. The test traffic has no site at
  10 or more embedded loads except `localhost` and `127.0.0.1` (never named), and `nemar-db-dev`
  holds no public managed dataset (`xx099901` is a public sandbox dataset, `on007753` and
  `nm000292` are not in it). Both paths are tested on the real captured rows with a changed count
  or a catalog that lists the dataset, and the public predicate is tested as real SQL. Re-capture
  once production has real partner traffic and a public dataset is embedded.
- The success path of `syncEmbedDays` is exercised against the real dataset on the dev Worker
  (see PR 98) but not in `bun test`, which would need the network and a token. Its planning,
  zero-fill and storage rules are tested directly.
