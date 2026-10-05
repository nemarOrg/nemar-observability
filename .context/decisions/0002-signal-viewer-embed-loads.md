# ADR 0002: Signal viewer embed loads, and what the public page may name

**Status:** accepted
**Date:** 2026-10-05
**Owner:** Seyed Yahya Shirazi

## Context

The website's embeddable signal viewer (website ADR 0023) puts a NEMAR page inside other sites.
Its edge middleware writes one Analytics Engine point per embed load (website ADR 0024): the dataset id, the embedding site's hostname from `Referer`, and a request kind (`iframe`, `document`, `none`, `other`).
The dashboard page is public with no auth, so anything it prints is public.
An embed of an unpublished or private dataset still records its id.
`Referer` and `Sec-Fetch-Dest` are set by the client, so anyone can write any hostname and any kind into the dataset with a single `curl`.
Analytics Engine keeps about three months, and the dashboard's date ranges reach back further.

## Decision

A "Signal viewer" section of its own, apart from the generic Umami event list, with a First-party and a Third-party filter.

- **First-party** is viewer opens and viewer interactions on nemar.org, read from the website event metrics the `/audience` answer already carries. The embed sends nothing to Umami, so these are first-party by construction, and `UMAMI_EVENT_NAMES` does not change. Events are recorded unless the visitor has opted out (website ADR 0019: analytics default on, `hasConsent()` is `readCookieConsent() !== "strict"`), so the figures undercount.
- **Third-party** is embed page loads on partner pages. The headline is `iframe` loads ("embedded"). `document` loads are "opened directly", and `none` plus `other` are "other requests".
- The two filters measure different things, viewer mounts on our pages and embed page loads on partner pages. The page labels them that way and never adds them into one number.

Where each figure is read:

| Figure | Source | Kept |
|---|---|---|
| Loads per UTC day and kind | `embed_daily_loads` in the Worker's own D1 (migration 0006), filled by the hourly cron from `EMBED_AE_DATASET` | Forever, never pruned |
| Sync health | `embed_sync_status` (migration 0007), one row, written by every sync attempt | Latest only |
| Embedding site counts | Analytics Engine, per request | Only what the edge keeps, about three months |
| Top embedded datasets | Analytics Engine, per request, then checked against `nemar-db` | Only what the edge keeps |
| Embedding site list | Analytics Engine, per request, admin drill-down only | Only what the edge keeps |

Hostnames and dataset ids are never stored in D1, so a hostname does not outlive the edge's own retention and a dataset that was private when embedded is not remembered.
Only `iframe` loads feed the site counts and the dataset ranking: the `Referer` of a direct open is where a person came from, not a site that embeds the viewer.

### Embedding sites are never named on the public page

The owner decided this on 2026-10-05, replacing an earlier design that named a site at 10 or more embedded loads.
The public sites block is counts only: loads from "unknown or local" hosts, loads from every other host, and the number of distinct other hosts (with `www.` folded).
It carries no hostname and no floor.

Why:

- **The hostname is spoofable.** `Referer` is set by the client, so ten `curl` requests put any name on a public page, as a floor of ten loads is no barrier at all. A name on this page would read as NEMAR vouching for a partner. The distinct count can be inflated the same way, which is why it is a count of claimed hosts and is labelled so.
- **Defacement.** An offensive, defamatory or impersonating name would be shown on the dashboard until the data aged out of the edge.
- **Probing.** Any floor lets a reader learn counts below it by comparing ranges that differ by a day, and invites writing requests to see when a name appears.
- **Identification.** A personal site's hostname is named after its owner.

Admins get the full host list, with loads by kind (embedded, opened directly, other) and whether each host counts as unknown or local, through the existing admin drill-down: `GET /observability/api/drilldown/embed-sites?start=&end=`, bearer admin (delegated to nemar-cli `/users/me`), `Cache-Control: no-store`, default the last 30 UTC days.
The page cannot call it (it holds no credential, `test/no-write-surface.test.ts`), so the sites card says the list is available to administrators through the API and does not link to the admin portal: the portal has no screen for this list, and the other tiles' links lead to screens that exist. Until nemarOrg/website#425 adds one, an admin reads the endpoint with their API key.

A host is "unknown or local" when it is empty, `localhost`, an IPv4 or IPv6 literal, a name whose last label is all digits, a name with no dot, a private suffix (`.local`, `.internal`, `.lan`, `.corp`, `.home`, `.home.arpa`, `.intranet`, `.private`, `.localhost`, `.localdomain`), or an RFC 2606 reserved name that never resolves (`.test`, `.invalid`, `.example`; production's `smoke.invalid` release-check row is therefore counted as unknown or local, not as a site), or wildcard DNS that embeds an IP address (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`, `traefik.me`).
Every trailing dot is dropped before comparing.
This only sorts a claimed host into a bucket.

### Datasets

Only datasets that are public now in `nemar-db` (`status='active' AND visibility='public'`, excluding folded and sandbox rows, the `PUBLIC_MANAGED` predicate) are named, and each links to the dataset's page on the website of the same environment (`WEBSITE_BASE_URL`: nemar.org, and test.nemar.org for dev).
Every other embedded load is folded into one unnamed "Other datasets" count, and if `nemar-db` cannot answer, no dataset is named.
The check runs on every uncached answer. The Worker reuses an answer for 60 seconds and a browser may keep it for another 30 (`private, max-age=30`; no shared cache may hold it), so a dataset made private can stay named for up to about 90 seconds. There is no edge cache in front of these Worker responses: none of `/embeds`, `/audience`, `/snapshot` and `/timeseries` carries `cf-cache-status` or `age`.

### The boundary of the distinct count

`distinct_sites` can be inflated by anyone, and probed for membership: injecting a single load with a guessed `Referer` and watching the count move answers "was this host already counted", a yes or no, never a name or a count of loads.
That is accepted: the answer reveals nothing the prober did not already supply, it names no one, and a count of claimed hosts cannot be made unspoofable while `Referer` is client-controlled; the only alternative is to drop the figure.
The page labels it as claimed.

### The daily store

It follows the repo's existing rules.
A settled day (written after it closed plus the collectors' six hour grace) is written once and not asked for again.
A closed day never goes down, in the planner and in the upsert.
A row that came back lower is not written at all, so a read that was not trusted cannot stamp the day as settled.
All four kinds are written together for every day from the first day an embed was counted.
A kind with nothing from the edge is a measured 0 only under a condition: the same answer must have a row for some day, because an answer that proves the dataset is live is what makes a quiet day a real zero.
The sync reads the whole retention window for that reason, though it writes only the days the planner asks for.
Days before the first counted embed stay absent, because the counting may not have existed yet, and absent means unknown, not zero.

What an answer with no row for any day means depends on what is stored (`judgeEmptyAnswer`, `syncEmbedDays`):

- **Stored loads inside the window the edge was asked about** (D1 holds a nonzero day on or after the start of the 85-day retention window): the answer contradicts stored data. It is a wrong or typo'd dataset or an edge fault, not a quiet stretch. The sync is treated as failed: it warns with the dataset and the window, writes nothing, and does not advance `last_ok_at`, so the card goes stale after three hours and says so (partial or unavailable, "last updated <time>").
- **History whose last nonzero day is older than the window** (a lull longer than the edge keeps): the empty answer is a real quiet stretch. The planner's days are written as zeros and one info line is logged.
- **No history at all** (nothing nonzero was ever stored): nothing is written. Production before its first embed, or a typo'd name before any embed, reads "none recorded yet" from the successful sync status, not from stored zeros, and correcting the name fills the history it missed.

Consequences: an empty answer never settles a zero over data that exists, and a lull of more than 85 days is the one case where a zero is written without a row in the answer.
A quiet stretch shorter than that is filled with zeros only once a later embed gives the answer a row; until then those days are unknown, not zero.
A dataset that goes silent right after history therefore shows as stale after three hours rather than as zeros, which is the safe direction.

An answer that is not a real answer is never settled as zero.
`queryAe` throws on a 200 whose body has no `data` array (an `errors` body, an empty object); `data: []` is a real empty answer.
A row whose count does not parse fails the pull instead of becoming 0.
Analytics Engine answers a query on a dataset nothing was written to with HTTP 200 and no rows (captured 2026-10-05), so `nemar_website_embeds` before the website ships reads as "none recorded yet", not as a fault.
That is also why `test/wrangler-datasets.test.ts` pins `EMBED_AE_DATASET` to the website's two dataset names: a typo would read an empty dataset forever without failing.

### Sync health on the card

Every sync attempt is recorded in `embed_sync_status`, including one that found nothing to write.
The loads card shows `last_synced_at`, and:

- a deploy whose first sync has not succeeded is unavailable ("not collected yet", or "has failed"), never "none recorded yet";
- a sync that has not succeeded for three hours downgrades the card to partial (unavailable when no day is stored), with "last updated <time>";
- dates before the first counted day read unknown ("before counting began"), not "none recorded"; dates in the future say so.

A failed sync is also logged with its stage, dataset and range, and the cron runs it after the snapshot and its status are saved, so a slow edge cannot delay either.
No health rule is added: zero embeds is a normal state, and the card, not `/health`, is where a stalled sync shows.

### Quota

Cloudflare's documentation publishes no Analytics Engine SQL API rate limit (the Analytics Engine limits page covers data points, blobs, indexes and three month retention only).
The general limit applies: 1,200 requests per five minutes per user, and exceeding it blocks all API calls for the next five minutes.
The analytics token is shared with the access section (and its owner's other API use), so a flood of uncached `/embeds` requests with distinct date ranges could lock them all out.

What an uncached public request costs: two Analytics Engine queries (sites, datasets; a third for the total only when a 5,000 row cap is hit), plus D1 reads of the stored totals and `nemar-db` for the public check.
The hourly cron adds one query.

There is no edge cache in front of these Worker responses (probed 2026-10-05: no `cf-cache-status` or `age` on `/embeds`, `/audience`, `/snapshot` or `/timeseries`), so every request that is not a memo hit reaches the Worker, and the bounds are the memo and the budget.
Caching with `caches.default` was considered and rejected: it is per colo and keyed by URL, so it helps repeated identical requests but not a flood of distinct windows, which is the risk, and it would add a second place a dataset's visibility could go stale.

Bounds:

- the Worker memoizes a window for 60 seconds per isolate, and concurrent identical requests in one isolate share one load; a failure or a refusal is not memoized; `/embeds` answers `Cache-Control: private, max-age=30`, so only the requesting browser may keep one, for 30 seconds, and no shared proxy can hold a stale answer; an answer with an unreadable block is `no-store`;
- every uncached load first claims its two queries from a shared per-UTC-minute budget in `embed_query_budget` (D1, so it holds across isolates), and is refused ("busy") without asking the edge when its pool is spent; the rare third query (a capped read) claims one more and is skipped when the pool is spent. The budget is 60 queries a minute, 300 in five minutes, a quarter of the global limit, so a flood can never take more than that from the token;
- the 60 are two pools of 30. The windows the page itself offers (7, 30, 90 and 365 days ending yesterday or today) draw on a "preset" pool; every other window draws on a "custom" pool. A flood of distinct custom windows exhausts only the custom pool, so the presets the page opens with keep loading for everyone. 30 queries a minute is 15 loads, so about 0.25 requests per second of distinct custom windows is enough to drain it;
- **preset answers are shared across isolates.** The per-isolate memo alone bounds an isolate, not the Worker: three cold isolates each loading the page's eight presets (six distinct windows after clipping) used 56 of the pool in a measurement. A preset window's answer is therefore also stored in D1 (`embed_preset_answers`, migration 0008) for the same 60 seconds, and any isolate answers a preset from a fresh row with no query and no budget. The preset pool's demand is then the number of distinct preset windows a minute, six, at 12 queries, not that times the isolates; a race between two isolates computing at once is still bounded by the pool. The stored row is only the answer the public endpoint already serves (counts for sites, dataset names that were public when computed), is never stored when it is not a good answer, and the cron deletes rows older than ten minutes. The alternative was precomputing the presets in the cron, which adds a daily window problem (the presets slide with the date) and serves up to an hour old; the short-TTL row keeps the data as fresh as the memo and adds one small table. Custom windows are not shared;
- a budget that cannot be claimed fails closed, with its own note ("currently unavailable"), not "busy";
- old budget rows are deleted by the cron, not on the request path.

The remaining exposure is to the custom pool: a flood can make custom ranges read "busy", never the presets and never the whole token.
The per-site list for admins is not budgeted, because it needs a bearer.

## Consequences

The third-party view needs `CF_ANALYTICS_TOKEN` and `EMBED_AE_DATASET` on the Worker.
Production reads `nemar_website_embeds` and `env.dev` reads `nemar_website_embeds_dev`, which also takes staging and website preview traffic.
Without them the view says "Not configured" instead of showing zeros.

A range wider than three months shows daily totals for all of it (from D1, from the day counting began) but dataset and site counts only for the part the edge still holds, and the page says so.

Counts are estimated from sampled records when the edge samples at volume (`rows_before_limit_at_least` was 233 against a weighted 332 on 2026-10-05), and the page says so.
Every load of the embed route counts, including its two message pages and cache hits, and a browser may reuse the page for a minute (website ADR 0024).
The kinds are what the request claims, not proof, so the figures are for usage reporting.

The public endpoint now writes to D1 on a public GET: one counter row per uncached list load, and a one-minute copy of the already-public answer for a preset window.
That is a write on a public GET; it holds no credential and mutates no NEMAR state, and AGENTS.md's privacy-boundary paragraph now names it.

Changing what the page names, or showing a hostname publicly again, is a privacy decision and needs a new ADR.

## Alternatives considered

- **Name sites at a floor of 10 loads, like the country rule.** The first design. Rejected by the owner: the floor does not stop spoofing, defacement or probing (above).
- **Name sites that appear in a partner allowlist.** Would need a list to keep, and says nothing about spoofed requests for an allowed name. Not needed once nothing is named.
- **Keep per-site and per-dataset rows in D1 too.** Gives a full year of lists, but keeps hostnames past the edge's retention and remembers ids of datasets that were private when embedded. Rejected; the daily totals are the durable record.
- **Precompute fixed windows in the cron so the endpoint never calls the edge.** Removes the quota risk entirely, but only the preset ranges would have lists. The shared budget keeps every range and bounds the cost.
- **Add the first-party and third-party counts into one "viewer count".** Rejected: a viewer mount and an embed page load are different events, and the sum describes neither.
- **A health rule for a stalled embed series.** Rejected by the owner: zero embeds is normal, and the card says when the sync is stale.
- **Reuse `daily_series_points`.** It would put the embed series into the generic Usage charts as an "additional source" next to this entry. A dedicated table keeps the entry separate and lets the four raw kinds be stored.

## Receipts

- nemarOrg/nemar-observability#97 and PR #98, part of nemarOrg/website#410 (phase 4).
- website ADR 0024 (the data point), ADR 0023 (the embed route), ADR 0019 (analytics default on, opt-out).
- Cloudflare: [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
- `src/lib/embeds.ts`, `src/lib/embed-lists.ts`, `src/lib/embed-store.ts`, `src/db/migrations/0006_embed_daily_loads.sql`, `src/db/migrations/0007_embed_sync_and_query_budget.sql`, `src/routes/dashboard/viewer.ts`.
