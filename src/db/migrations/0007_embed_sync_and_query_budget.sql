-- Health of the embed loads sync (nemar-observability#97), one row, like
-- cron_status. embed_daily_loads alone cannot say whether the sync is working:
-- with no embeds a healthy sync writes nothing, so an empty table looks the same
-- as a sync that has never succeeded. The public /embeds answer reads this to say
-- "last updated <time>", to downgrade a card whose sync has gone stale, and to
-- avoid saying "none recorded yet" on a deploy whose first sync failed.
CREATE TABLE IF NOT EXISTS embed_sync_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_ok_at TEXT,                  -- ISO-8601 UTC of the last successful sync (rows written or none to write)
  last_error TEXT,                  -- stage and message of the last failure; NULL after a success; never served
  last_run_at TEXT                  -- ISO-8601 UTC of the last attempt
);
INSERT OR IGNORE INTO embed_sync_status (id) VALUES (1);

-- A shared per-minute budget of Analytics Engine queries for the public /embeds
-- endpoint. Cloudflare's global API limit is 1,200 requests per five minutes per
-- user and, when exceeded, blocks ALL API calls for five minutes; the analytics
-- token is shared with the access section. The endpoint is public and its date
-- range is a free parameter, so nothing in front of the Worker can bound the
-- queries. Each uncached list load claims its queries here first (embed-lists.ts),
-- across every isolate, and is refused when its pool for the minute is spent.
-- There are two pools, "preset" (the windows the page offers) and "custom" (every
-- other window), so a flood of custom windows cannot starve the presets. The hourly
-- cron deletes rows older than ten minutes (pruneQueryBudget); a claim never does.
CREATE TABLE IF NOT EXISTS embed_query_budget (
  minute TEXT PRIMARY KEY,          -- UTC minute and pool, "2026-10-05T14:47|preset" or "|custom"
  used INTEGER NOT NULL             -- queries claimed in that minute and pool
);
