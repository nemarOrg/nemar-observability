-- Keep section headlines and their additive daily observations in one visible
-- version. Staging writes may span batches; the commit batch publishes them
-- together only after every staged row has been written.
CREATE TABLE IF NOT EXISTS section_ingest_staging (
  ingest_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  section_json TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_section_ingest_staging_started_at
  ON section_ingest_staging(started_at);

CREATE TABLE IF NOT EXISTS daily_series_ingest_staging (
  ingest_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('count', 'bytes')),
  aggregation TEXT NOT NULL CHECK (aggregation = 'sum'),
  timezone TEXT NOT NULL CHECK (timezone = 'UTC'),
  coverage_start TEXT NOT NULL,
  coverage_end TEXT NOT NULL,
  freshness_after_hours INTEGER NOT NULL CHECK (freshness_after_hours BETWEEN 1 AND 168),
  PRIMARY KEY (ingest_id, series_key)
);
CREATE TABLE IF NOT EXISTS daily_series_point_ingest_staging (
  ingest_id TEXT NOT NULL,
  series_key TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  PRIMARY KEY (ingest_id, series_key, date)
);

-- A series key carries stable semantics. Producers must version the key if its
-- source, label, unit, aggregation, timezone, or freshness rule changes.
CREATE TRIGGER IF NOT EXISTS daily_series_semantics_immutable
BEFORE UPDATE ON daily_series
WHEN OLD.source IS NOT NEW.source
  OR OLD.label IS NOT NEW.label
  OR OLD.unit IS NOT NEW.unit
  OR OLD.aggregation IS NOT NEW.aggregation
  OR OLD.timezone IS NOT NEW.timezone
  OR OLD.freshness_after_hours IS NOT NEW.freshness_after_hours
BEGIN
  SELECT RAISE(ABORT, 'daily_series_semantics_immutable');
END;
