-- A short claim on computing a preset window's answer (nemar-observability#97,
-- ADR 0002), so that a cold herd computes it once.
--
-- When a shared preset answer (embed_preset_answers) expires, every isolate that
-- asks for the window at that moment misses together. Six cold isolates times
-- the page's presets made 30 Analytics Engine calls and left some windows
-- briefly "busy". Before computing, an isolate inserts a claim here for about
-- ten seconds; an isolate that finds a live claim waits a moment and reads the
-- shared answer instead. Only the claimant spends budget. A claimant that fails
-- deletes its claim, and an expired claim is simply taken over. The cron deletes
-- claims older than ten minutes.
CREATE TABLE IF NOT EXISTS embed_preset_claims (
  key TEXT PRIMARY KEY,              -- the preset window's key, as in embed_preset_answers
  claimed_at TEXT NOT NULL           -- ISO-8601 UTC when the claim was taken
);
