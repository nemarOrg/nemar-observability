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
