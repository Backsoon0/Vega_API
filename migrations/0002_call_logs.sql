-- Migration: 0002_call_logs
-- Persistent call log storage with retention limit

CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    ip TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_call_logs_ts ON call_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_provider ON call_logs(provider_id);
