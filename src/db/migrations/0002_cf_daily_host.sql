-- Per-host, per-day Cloudflare zone traffic, accumulated by the hourly cron.
--
-- Why this table exists: the only zone dataset with a host dimension
-- (httpRequestsAdaptiveGroups) rejects any query window wider than 1 day, so a
-- 30-day per-host view cannot be fetched on demand. The cron pulls one day at a
-- time and upserts here; the section aggregates from this table.
--
-- (date, host) is the natural key. Re-running the cron for a day it already has
-- REPLACES that day's row rather than adding to it: the current day is re-pulled
-- every hour as it accumulates, and summing those partial pulls would multiply
-- today's traffic by the number of cron runs so far.
CREATE TABLE IF NOT EXISTS cf_daily_host (
  date TEXT NOT NULL,               -- ISO date (UTC), e.g. "2026-07-29"
  host TEXT NOT NULL,               -- clientRequestHTTPHost
  requests INTEGER NOT NULL,
  visits INTEGER NOT NULL,          -- CF "visits" (session starts), not unique IPs
  bytes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,         -- ISO-8601 UTC of the pull that wrote this row
  PRIMARY KEY (date, host)
);
CREATE INDEX IF NOT EXISTS idx_cf_daily_host_date ON cf_daily_host(date);
