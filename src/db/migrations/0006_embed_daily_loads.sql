-- Embed loads of the signal viewer on other sites, one row per UTC day and
-- request kind (nemar-observability#97; website ADR 0024).
--
-- Why this table exists: the edge's Analytics Engine keeps about three months,
-- and the dashboard's ranges reach back further than that. The cron reads the
-- per-(day, kind) totals and stores them here, so history outlives the source.
-- Like daily_series_points it is never pruned.
--
-- Only totals are kept. Hostnames and dataset ids are NOT stored: the per-site
-- and per-dataset lists are read from the edge for the days it still holds, so
-- a hostname never outlives the edge's own retention, and a dataset that was
-- private when it was embedded is not remembered here.
--
-- Rules, shared with the other daily stores:
--   - A settled day is written once. updated_at is when the row was last
--     written; a day written after it closed plus the collectors' grace is
--     settled and is not asked for again (src/lib/embeds.ts planEmbedPull).
--   - A closed day never goes down. The upsert in src/lib/embed-store.ts keeps
--     the stored value when a later write for a closed day is lower, so a
--     partial or empty re-read cannot erase history. A real downward correction
--     needs a manual SQL fix.
--   - All four kinds are written together for every day from the first day an
--     embed was ever counted, with 0 for a kind the edge had nothing for. A day
--     with rows is a day that was measured; a day with none is unknown.
CREATE TABLE IF NOT EXISTS embed_daily_loads (
  date TEXT NOT NULL,                       -- ISO date (UTC), e.g. "2026-10-05"
  kind TEXT NOT NULL CHECK (kind IN ('iframe', 'document', 'none', 'other')),
  loads INTEGER NOT NULL CHECK (loads >= 0),
  updated_at TEXT NOT NULL,                 -- ISO-8601 UTC of the write that last touched this row
  PRIMARY KEY (date, kind)
);
