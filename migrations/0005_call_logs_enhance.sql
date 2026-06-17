-- Migration: 0005_call_logs_enhance
-- Add request_id, is_stream, and extra columns to call_logs for enhanced logging
-- NOTE: Columns are managed by db.ts runtime migration (ALTER TABLE with try/catch).
-- The migration file preserves the CREATE INDEX statement.
CREATE INDEX IF NOT EXISTS idx_call_logs_request_id ON call_logs(request_id);
