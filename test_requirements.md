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
