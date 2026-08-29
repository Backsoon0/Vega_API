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
//
// BOTH platforms self-heal at cold start (no manual migration needed):
//   - tables  : `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
//   - columns : Postgres `ADD COLUMN IF NOT EXISTS`; SQLite has no IF NOT EXISTS,
//               so D1 checks `PRAGMA table_info()` first and only ALTERs missing columns.
// This keeps the schema in sync with the deployed code automatically.

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
	'CREATE TABLE IF NOT EXISTS key_usage_daily (key_name TEXT NOT NULL, date TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(key_name, date))',
	'CREATE TABLE IF NOT EXISTS model_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL UNIQUE, target TEXT NOT NULL, provider_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT \'\', created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), updated_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
];

// Additive column migrations — engine-specific SQL for each platform. D1 runs
// the SQLite form only after a PRAGMA existence check; Neon runs the Postgres
// `IF NOT EXISTS` form directly. Keep the two forms in sync column-wise.
type ColumnMigration = {
	table: string;
	column: string;
	d1: string;    // SQLite ALTER (no IF NOT EXISTS support)
	neon: string;  // Postgres ALTER (supports IF NOT EXISTS)
};

const COLUMN_MIGRATIONS: ColumnMigration[] = [
	{ table: 'rate_limits', column: 'banned_until', d1: 'ALTER TABLE rate_limits ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0', neon: 'ALTER TABLE rate_limits ADD COLUMN IF NOT EXISTS banned_until INTEGER NOT NULL DEFAULT 0' },                                        // 0004
	{ table: 'call_logs', column: 'duration_ms', d1: 'ALTER TABLE call_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0', neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0' },                                                    // 0003
	{ table: 'call_logs', column: 'request_id', d1: "ALTER TABLE call_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT ''", neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS request_id TEXT NOT NULL DEFAULT \'\'' },                                                            // 0005
	{ table: 'call_logs', column: 'is_stream', d1: 'ALTER TABLE call_logs ADD COLUMN is_stream INTEGER NOT NULL DEFAULT 0', neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS is_stream INTEGER NOT NULL DEFAULT 0' },                                                              // 0005
	{ table: 'call_logs', column: 'extra', d1: "ALTER TABLE call_logs ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'", neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS extra TEXT NOT NULL DEFAULT \'{}\'' },                                                                        // 0005
	{ table: 'call_logs', column: 'cache_read_input_tokens', d1: 'ALTER TABLE call_logs ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0', neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER NOT NULL DEFAULT 0' },                        // 0008
	{ table: 'call_logs', column: 'cache_creation_input_tokens', d1: 'ALTER TABLE call_logs ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0', neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0' },            // 0008
	{ table: 'call_logs', column: 'api_key_name', d1: "ALTER TABLE call_logs ADD COLUMN api_key_name TEXT NOT NULL DEFAULT ''", neon: 'ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS api_key_name TEXT NOT NULL DEFAULT \'\'' },                                                          // 0008
	{ table: 'api_keys', column: 'quota_calls', d1: 'ALTER TABLE api_keys ADD COLUMN quota_calls INTEGER', neon: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS quota_calls INTEGER' },                                    // 0009
	{ table: 'api_keys', column: 'quota_tokens', d1: 'ALTER TABLE api_keys ADD COLUMN quota_tokens INTEGER', neon: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS quota_tokens INTEGER' },                                  // 0009
	{ table: 'api_keys', column: 'quota_period', d1: "ALTER TABLE api_keys ADD COLUMN quota_period TEXT NOT NULL DEFAULT 'day'", neon: 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS quota_period TEXT NOT NULL DEFAULT \'day\'' },                                                        // 0009
	{ table: 'providers', column: 'hidden_models', d1: "ALTER TABLE providers ADD COLUMN hidden_models TEXT NOT NULL DEFAULT '[]'", neon: "ALTER TABLE providers ADD COLUMN IF NOT EXISTS hidden_models TEXT NOT NULL DEFAULT '[]'" },                                             // aliases/hidden feature
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
	'CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, quota_calls INTEGER, quota_tokens INTEGER, quota_period TEXT NOT NULL DEFAULT \'day\')',
	'CREATE TABLE IF NOT EXISTS key_usage_daily (key_name TEXT NOT NULL, date TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(key_name, date))',
	`CREATE TABLE IF NOT EXISTS model_aliases (id SERIAL PRIMARY KEY, alias TEXT NOT NULL UNIQUE, target TEXT NOT NULL, provider_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (now()), updated_at TEXT NOT NULL DEFAULT (now()))`,
];

/**
 * Initialize the database schema for the active engine. Safe to call on every
 * cold start — creates missing tables/indexes and adds missing columns.
 *
 * D1 (SQLite): `CREATE ... IF NOT EXISTS` for tables/indexes + `PRAGMA
 * table_info()` existence check before each ALTER (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`). Exactly the same "self-heal" semantics as Neon.
 * Neon (Postgres): `IF NOT EXISTS` everywhere, including `ADD COLUMN`.
 */
export async function initSchema(env: Env): Promise<void> {
	if (detectDatabase(env) === 'neon') {
		await initNeonSchema(env);
		return;
	}
	await initD1Schema(env);
}

// ---- D1 (SQLite) ----

async function initD1Schema(env: Env): Promise<void> {
	for (const stmt of D1_SCHEMA_STATEMENTS) {
		await env.DB.prepare(stmt).run();
	}
	for (const mig of COLUMN_MIGRATIONS) {
		if (await d1ColumnExists(env, mig.table, mig.column)) continue;
		await env.DB.prepare(mig.d1).run();
	}
}

/** SQLite has no `ADD COLUMN IF NOT EXISTS` — check `PRAGMA table_info` instead. */
async function d1ColumnExists(env: Env, table: string, column: string): Promise<boolean> {
	try {
		const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
		return res.results.some((r) => r.name === column);
	} catch {
		// Table missing (shouldn't happen — CREATE IF NOT EXISTS ran above).
		return false;
	}
}

// ---- Neon (Postgres) ----

async function initNeonSchema(env: Env): Promise<void> {
	for (const stmt of NEON_SCHEMA_STATEMENTS) {
		await env.DB.prepare(stmt).run();
	}
	// Postgres supports IF NOT EXISTS on ADD COLUMN.
	for (const mig of COLUMN_MIGRATIONS) {
		await env.DB.prepare(mig.neon).run();
	}
}