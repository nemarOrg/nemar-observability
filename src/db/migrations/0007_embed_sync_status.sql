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
