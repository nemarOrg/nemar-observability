-- Source-backed additive daily series, owned only by nemar-observability.
CREATE TABLE IF NOT EXISTS daily_series (
  section_key TEXT NOT NULL,
  series_key TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('count', 'bytes')),
  aggregation TEXT NOT NULL CHECK (aggregation = 'sum'),
  timezone TEXT NOT NULL CHECK (timezone = 'UTC'),
  coverage_start TEXT NOT NULL,
  coverage_end TEXT NOT NULL,
  freshness_after_hours INTEGER NOT NULL CHECK (freshness_after_hours BETWEEN 1 AND 168),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section_key, series_key)
);
CREATE TABLE IF NOT EXISTS daily_series_points (
  section_key TEXT NOT NULL,
  series_key TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section_key, series_key, date),
  FOREIGN KEY (section_key, series_key) REFERENCES daily_series(section_key, series_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_daily_series_points_date ON daily_series_points(date, section_key, series_key);
