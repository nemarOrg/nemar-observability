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

## Daily-series browser grouping

Calendar-week/month boundaries and partial-period labels are rendered by the
inline browser client. The previous `ui-render.test.ts` harness ran the script
against a fake DOM and supplied invented daily values through a fake `fetch`
response; that harness was removed to comply with `.rules/testing.md`. Its
replacement checks only real server-rendered markup. Do not add another mocked
browser surface or fabricated time-series response.

On 2026-09-27, the production `/observability/api/timeseries` query for
2026-08-01 through 2026-09-26 returned no reporting series, and the Umami host
setup was still incomplete. A real browser check therefore cannot exercise the
grouping until a source publishes actual daily points. After the Umami or another
authorized real source is active, use Chrome on the dashboard with a range that
starts and ends midweek and midmonth. Verify calendar-aligned period labels,
partial-period boundaries, totals against the returned daily points, unknown
gaps, and stale-source metadata. Record the source, selected UTC dates, deployed
revision, and observed results; do not claim CI covers this behavior before that
acceptance is complete.
