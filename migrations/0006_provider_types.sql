-- Migration: 0006_provider_types
-- Add 'anthropic' to provider type CHECK constraint
-- SQLite doesn't support ALTER CHECK, so we recreate the table

CREATE TABLE IF NOT EXISTS providers_new (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '[]',
    weight INTEGER NOT NULL DEFAULT 1
);

INSERT INTO providers_new SELECT * FROM providers;

DROP TABLE providers;

ALTER TABLE providers_new RENAME TO providers;
