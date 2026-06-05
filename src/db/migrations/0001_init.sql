-- nemar-observability's own D1 (NOT nemar-db). Holds only data this dashboard
-- owns: the computed snapshot history and sections pushed by external pipelines.

-- One row per hourly computed snapshot. The latest (MAX(generated_at)) is what
-- the public /api/snapshot serves; older rows back the trend sparklines.
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,       -- ISO-8601 UTC
  snapshot_json TEXT NOT NULL       -- full MetricSnapshot (public: headline numbers only)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_generated_at ON snapshots(generated_at);

-- Latest pushed section per key (push mode). The cron merges these into the
-- computed snapshot. Replaced wholesale on each POST /api/sections/:key.
CREATE TABLE IF NOT EXISTS ingested_sections (
  key TEXT PRIMARY KEY,             -- section key (e.g. "qa")
  section_json TEXT NOT NULL,       -- a Section conforming to the schema
  source TEXT NOT NULL,             -- producer id
  received_at TEXT NOT NULL         -- ISO-8601 UTC
);

-- Single-row cron health, so /health can expose snapshot staleness and an
-- external monitor can alert when last_success_at falls behind (the cron's
-- failures otherwise live only in Workers logs).
CREATE TABLE IF NOT EXISTS cron_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at TEXT,             -- ISO-8601 UTC of the last successful snapshot
  last_error TEXT,                  -- last failure message (NULL after a success)
  last_run_at TEXT                  -- ISO-8601 UTC of the last attempt
);
INSERT OR IGNORE INTO cron_status (id) VALUES (1);
