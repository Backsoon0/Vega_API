-- Migration: 0005_call_logs_enhance
-- Add request_id, is_stream, and extra columns to call_logs for enhanced logging

ALTER TABLE call_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
ALTER TABLE call_logs ADD COLUMN is_stream INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_logs ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_call_logs_request_id ON call_logs(request_id);
