// src/db.ts
// Database helpers — schema initialization.
//
// The runtime can be backed by two engines:
//   - Cloudflare D1 (SQLite)          → `detectDatabase(env) === 'd1'`
//   - Vercel Neon (PostgreSQL)        → `detectDatabase(env) === 'neon'`
// Schema DDL is engine-specific (AUTOINCREMENT vs SERIAL, ALTER ... IF NOT EXISTS).
// Runtime queries use a D1-shaped client (`env.DB.prepare().bind().all()/.first()/.run()`)
// which is satisfied by Cloudflare's real D1 binding on Workers and by the Neon
// adapter on Vercel, so data-access code stays identical across platforms.

import type { Env } from './types.js';
import { detectDatabase } from './runtime.js';

// ---------------------------------------------------------------------------
// D1 (SQLite) schema — original single-line statements.
// ---------------------------------------------------------------------------
const D1_SCHEMA_STATEMENTS = [
	'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
	`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)`,
	'CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))',
	'CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date)',
	'CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_daily(provider_id)',
	'CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)',
	'CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1)',
	'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON call_logs(timestamp)',
	'CREATE INDEX IF NOT EXISTS idx_logs_provider ON call_logs(provider_id)',
	'CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)',
];

// ALTER TABLE ... ADD COLUMN (SQLite has no IF NOT EXISTS — wrapped in try/catch).
const D1_MIGRATIONS = [
	'ALTER TABLE rate_limits ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0',   // 0004
	'ALTER TABLE call_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0',       // 0003
	'ALTER TABLE call_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT \'\'',          // 0005
	'ALTER TABLE call_logs ADD COLUMN is_stream INTEGER NOT NULL DEFAULT 0',          // 0005
	'ALTER TABLE call_logs ADD COLUMN extra TEXT NOT NULL DEFAULT \'{}\'',             // 0005
	'ALTER TABLE call_logs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0',    // 0008
	'ALTER TABLE call_logs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0', // 0008
	'ALTER TABLE call_logs ADD COLUMN api_key_name TEXT NOT NULL DEFAULT \'\'',               // 0008
];

// ---------------------------------------------------------------------------
// Neon (PostgreSQL) schema. Column names match D1 so runtime queries are shared.
// `SERIAL` provides the auto-increment integer id; `ALTER ... ADD COLUMN IF NOT EXISTS`
// is used for the additive migrations (Postgres does support IF NOT EXISTS).
// ---------------------------------------------------------------------------
const NEON_SCHEMA_STATEMENTS = [
	'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
	`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)`,
	`CREATE TABLE IF NOT EXISTS usage_daily (id SERIAL PRIMARY KEY, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))`,
	'CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date)',
	'CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_daily(provider_id)',
	`CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS call_logs (id SERIAL PRIMARY KEY, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}', cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, api_key_name TEXT NOT NULL DEFAULT '')`,
	'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON call_logs(timestamp)',
	'CREATE INDEX IF NOT EXISTS idx_logs_provider ON call_logs(provider_id)',
	'CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)',
];

const NEON_MIGRATIONS = [
	'ALTER TABLE rate_limits ADD COLUMN IF NOT EXISTS banned_until INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT \'\'',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS is_stream INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS extra TEXT NOT NULL DEFAULT \'{}\'',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0',
	'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS api_key_name TEXT NOT NULL DEFAULT \'\'',
];

/**
 * Initialize the database schema for the active engine. Safe to call on every
 * cold start — uses IF NOT EXISTS (and IF NOT EXISTS / try-catch for ALTERs).
 */
export async function initSchema(env: Env): Promise<void> {
	if (detectDatabase(env) === 'neon') {
		await initNeonSchema(env);
		return;
	}
	await initD1Schema(env);
}

async function initD1Schema(env: Env): Promise<void> {
	for (const stmt of D1_SCHEMA_STATEMENTS) {
		await env.DB.prepare(stmt).run();
	}
	// ALTER on existing tables: CREATE TABLE IF NOT EXISTS won't add columns, so
	// ALTER with try/catch (D1/SQLite doesn't support IF NOT EXISTS for ALTER).
	for (const stmt of D1_MIGRATIONS) {
		try {
			await env.DB.prepare(stmt).run();
		} catch {
			// Column already exists — safe to ignore
		}
	}
}

async function initNeonSchema(env: Env): Promise<void> {
	for (const stmt of NEON_SCHEMA_STATEMENTS) {
		await env.DB.prepare(stmt).run();
	}
	// Postgres supports IF NOT EXISTS on ADD COLUMN, but keep try/catch to be safe.
	for (const stmt of NEON_MIGRATIONS) {
		try {
			await env.DB.prepare(stmt).run();
		} catch {
			// Column already exists — safe to ignore
		}
	}
}
