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
`test/fixtures/embeds-api-*.json` were captured on 2026-10-05 from the dev Worker (dataset
`nemar_website_embeds_dev`, the website's staging and preview test traffic). The Analytics Engine
answers were read through a temporary diagnostic route that was never merged; the `/embeds` answer
is the dev Worker's public endpoint. `test/helpers/ae-fixtures.ts` serves them over HTTP keyed on the
shape of the SQL, so `loadEmbedLists`, `syncEmbedDays` and the page run end to end over real answers;
only the transport is stood in for.

Not covered by a real capture, and why:

- **The admin site list query** (`GROUP BY host, kind`). Its answer in the tests is summed from the
  captured per-dataset, per-host, per-kind rows over the same traffic, because that exact grouping was
  not captured. Capture it with an admin key against `/drilldown/embed-sites` on dev and replace the
  derivation.
- **A public dataset being named on live data.** `nemar-db-dev` has no public managed dataset
  (`xx099901` is a public sandbox dataset, `on007753` and `nm000292` are not in it), so the named path
  runs on the captured rows against a catalog table that lists the dataset, and the public predicate
  runs as real SQL. Re-capture once a public dataset is embedded.
- **Measured First-party figures.** The captured audience answers have `event_metrics` unconfigured
  (`UMAMI_EVENTS_COVERAGE_START` is unset in production, and dev has no Umami vars: nemar-observability#99).
  The extraction is tested on type-correct numbers and nulls shaped like the API's, not on a capture.
  Capture a measured `/audience` answer once coverage is set.
- **The identity check of the admin drill-down.** A local HTTP server answers the one request the Worker
  makes of nemar-cli (`/users/me`); the refusals (no header, wrong scheme, unknown key, non-admin key)
  are what is tested, and a real admin key was not used.
