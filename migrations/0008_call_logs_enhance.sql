-- 0008_call_logs_enhance.sql
-- Cache hit tracking, API key name, column display preferences
ALTER TABLE call_logs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_logs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_logs ADD COLUMN api_key_name TEXT NOT NULL DEFAULT '';
