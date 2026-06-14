// src/db.ts
// D1 database helpers — schema initialization

import type { Env } from './types';

const SCHEMA_STATEMENTS = [
	'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
	`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)`,
	'CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))',
	'CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date)',
	'CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_daily(provider_id)',
	'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)',
	'CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1)',
	'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON call_logs(timestamp)',
	'CREATE INDEX IF NOT EXISTS idx_logs_provider ON call_logs(provider_id)',
];

/**
 * Initialize database schema. Safe to call on every cold start — uses IF NOT EXISTS.
 * Uses prepare().run() for each statement individually for D1 emulation compatibility.
 */
export async function initSchema(env: Env): Promise<void> {
	for (const stmt of SCHEMA_STATEMENTS) {
		await env.DB.prepare(stmt).run();
	}

	// Run schema migrations for columns added after initial table creation.
	// CREATE TABLE IF NOT EXISTS won't add columns to existing tables, so we
	// ALTER TABLE with try/catch (D1/SQLite doesn't support IF NOT EXISTS for ALTER).
	const MIGRATIONS = [
		'ALTER TABLE rate_limits ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0',   // 0004
		'ALTER TABLE call_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0',       // 0003
	];
	for (const stmt of MIGRATIONS) {
		try {
			await env.DB.prepare(stmt).run();
		} catch {
			// Column already exists — safe to ignore
		}
	}
}
