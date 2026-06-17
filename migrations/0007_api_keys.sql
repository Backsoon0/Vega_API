-- 0007_api_keys.sql
-- Multi-key client API key management
CREATE TABLE IF NOT EXISTS api_keys (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	encrypted_key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT
);
