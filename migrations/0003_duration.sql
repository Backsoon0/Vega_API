-- Migration: 0003_duration
-- Track API call duration in call_logs

ALTER TABLE call_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
