-- Migration: 0001_init
-- Initial D1 schema for Vega API

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '[]',
    weight INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usage_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, provider_id, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_daily(provider_id);

CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL DEFAULT 0
);
