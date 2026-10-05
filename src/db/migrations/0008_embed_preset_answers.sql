-- The public lists answer for the page's own preset windows, shared across
-- isolates for a short time (nemar-observability#97, ADR 0002).
--
-- The per-isolate memo bounds an isolate, not the Worker: three cold isolates
-- each loading the page's presets used 56 of the preset pool of 30 queries a
-- minute. A fresh row here lets every isolate answer a preset window without
-- asking the edge or spending budget, so the demand on the preset pool is the
-- number of distinct preset windows (six after clipping to the edge's retention)
-- per minute, not that number times the isolates.
--
-- The row holds only the answer the public endpoint already serves: counts for
-- sites, and dataset names that were public when it was computed. It is reused
-- for at most 60 seconds (the same bound as the memo) and the cron deletes rows
-- older than ten minutes. Only a good answer is stored.
CREATE TABLE IF NOT EXISTS embed_preset_answers (
  key TEXT PRIMARY KEY,              -- dataset|window start|window end|today|website base, as the memo's key
  answer TEXT NOT NULL,              -- the public lists answer as JSON
  computed_at TEXT NOT NULL          -- ISO-8601 UTC when it was computed
);
