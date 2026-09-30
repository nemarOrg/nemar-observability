-- Remember the last delivery whose collector run succeeded. A collector that
-- fails publishes an error-only status that replaces the section and refreshes
-- received_at, so received_at alone cannot show consecutive failures. last_ok_at
-- only advances on a run that did not report `<section>.collector.errors` as an
-- error, so /health can tolerate one failed run and still catch a collector
-- that has not succeeded for a day.
ALTER TABLE ingested_sections ADD COLUMN last_ok_at TEXT;

UPDATE ingested_sections SET last_ok_at = received_at
WHERE CASE WHEN json_valid(section_json) THEN NOT EXISTS (
  SELECT 1 FROM json_each(ingested_sections.section_json, '$.metrics') AS m
  WHERE json_extract(m.value, '$.key') LIKE '%.collector.errors'
    AND json_extract(m.value, '$.severity') = 'error'
) ELSE 0 END;
