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
