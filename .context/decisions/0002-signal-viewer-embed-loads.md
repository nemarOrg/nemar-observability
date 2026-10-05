# ADR 0002: Signal viewer embed loads, and what the public page may name

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

## Context

The website's embeddable signal viewer (website ADR 0023) puts a NEMAR page inside other sites.
Its edge middleware writes one Analytics Engine point per embed load (website ADR 0024): the dataset id, the embedding site's hostname from `Referer`, and a request kind (`iframe`, `document`, `none`, `other`).
The dashboard page is public with no auth, so anything it prints is public.
An embed of an unpublished or private dataset still records its id, and a hostname can identify a person when the site is a personal one.
Analytics Engine keeps about three months, and the dashboard's date ranges reach back further.

## Decision

A "Signal viewer" section of its own, apart from the generic Umami event list, with a First-party and a Third-party filter.

- **First-party** is viewer opens and viewer interactions on nemar.org, read from the website event metrics the `/audience` answer already carries. The embed sends nothing to Umami, so these are first-party by construction, and `UMAMI_EVENT_NAMES` does not change.
- **Third-party** is embed page loads on partner pages. The headline is `iframe` loads ("embedded"). `document` loads are "opened directly", and `none` plus `other` are "other requests".
- The two filters measure different things, viewer mounts on our pages and embed page loads on partner pages. The page labels them that way and never adds them into one number.

Where each figure is read:

| Figure | Source | Kept |
|---|---|---|
| Loads per UTC day and kind | `embed_daily_loads` in the Worker's own D1 (migration 0006), filled by the hourly cron from `EMBED_AE_DATASET` | Forever, never pruned |
| Top embedding sites | Analytics Engine, per request | Only what the edge keeps, about three months |
| Top embedded datasets | Analytics Engine, per request, then checked against `nemar-db` | Only what the edge keeps |

Hostnames and dataset ids are never stored in D1, so a hostname does not outlive the edge's own retention and a dataset that was private when embedded is not remembered.
Only `iframe` loads are ranked by site and by dataset: the `Referer` of a direct open is where a person came from, not a site that embeds the viewer.

The daily store follows the repo's existing rules.
A settled day (written after it closed plus the collectors' six hour grace) is written once and not asked for again.
A closed day never goes down, in the planner and in the upsert, so a partial or empty re-read cannot erase history.
All four kinds are written together for every day from the first day an embed was counted, with 0 where the edge had nothing, so a stored day is a measured day and a missing day is unknown, not zero.
Days before the first counted embed stay absent, because the counting may not have existed yet.

Privacy rules, applied on the server before anything reaches the page:

- **Datasets.** Only datasets that are public now in `nemar-db` (`status='active' AND visibility='public'`, excluding folded and sandbox rows, the `PUBLIC_MANAGED` predicate) are named. Every other embedded load is folded into one unnamed "Other datasets" count. If `nemar-db` cannot answer, no dataset is named.
- **Embedding sites.** A site is named only when it has at least 10 embedded loads in the selected dates. `localhost`, IPv4 and IPv6 literals, private-network names (no dot, `.local`, `.internal`, `.lan`, `.localhost`, `.home.arpa`, `.localdomain`) and empty hosts are grouped as "Unknown or local" and never named, whatever their count. Every other site is counted in "Other sites". The rows, the two groups and the total add up.
- **Why 10.** It is the small-cell floor the dashboard already applies to countries (`summarizeCountries`), so one rule explains both lists. It is applied to the selected range as a whole, not to each day as the country rule is, because a per-day floor of ten would hide every partner whose embeds are spread thin and leave the list empty. The cost is the usual small-cell caveat: two ranges that differ by one day can show that a site crossed the line, which reveals a count for a site the reader could already see by name and never a name that was withheld.
- **Why a threshold at all.** A personal site's hostname is named after its owner, so a site that has barely embedded the viewer is not named.

Embeds on NEMAR's own sites, such as docs.nemar.org, count as third-party and their domain shows in the site list (website judgment call 8).

No health rule is added.
Zero embeds is a normal state, and a failed sync is logged and shown on the page as unavailable.

## Consequences

The third-party view needs `CF_ANALYTICS_TOKEN` and `EMBED_AE_DATASET` on the Worker.
Production reads `nemar_website_embeds` and `env.dev` reads `nemar_website_embeds_dev`, which also takes staging and website preview traffic.
Without them the view says "Not configured" instead of showing zeros.

A range wider than three months shows daily totals for all of it (from D1, from the day counting began) but sites and datasets only for the part the edge still holds, and the page says so.

Every load of the embed route counts, including its two message pages and cache hits, and a browser may reuse the page for a minute (website ADR 0024).
A request with no `Referer` has an empty host and lands in "Unknown or local".
The kinds are what the request claims, not proof, so the figures are for usage reporting.

Changing what the page names (the floor, the groups, the public check) is a privacy decision and needs a new ADR.

## Alternatives considered

- **Keep per-site and per-dataset rows in D1 too.** Gives a full year of top lists, but keeps hostnames past the edge's retention and remembers ids of datasets that were private when embedded. Rejected; the daily totals are the durable record.
- **Add the first-party and third-party counts into one "viewer count".** Rejected: a viewer mount and an embed page load are different events, and the sum describes neither.
- **A per-day small-cell floor for sites, like countries.** Rejected: it would leave the list empty for the foreseeable future.
- **A health rule for a stalled embed series.** Rejected by the owner: zero embeds is normal, and an unreachable edge is already visible on the page.
- **Reuse `daily_series_points`.** It would put the embed series into the generic Usage charts as an "additional source" next to this entry. A dedicated table keeps the entry separate and lets the four raw kinds be stored.

## Receipts

- nemarOrg/nemar-observability#97, part of nemarOrg/website#410 (phase 4).
- website ADR 0024 (the data point), ADR 0023 (the embed route).
- `src/lib/embeds.ts`, `src/lib/embed-store.ts`, `src/db/migrations/0006_embed_daily_loads.sql`, `src/routes/dashboard/viewer.ts`.
