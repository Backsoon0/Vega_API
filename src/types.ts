// src/types.ts
// Shared TypeScript interfaces for Vega API

export interface Provider {
  id: string;
  type: 'vertex_ai' | 'google_ai_studio' | 'openai' | 'anthropic';
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  models: string[];
  weight: number;
}

export interface ProviderRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  config: string;  // JSON string
  models: string;  // JSON string
  weight: number;
}

export interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  _providerId?: string;
  _providerIds?: string[];
}

export interface UsageRecord {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface LogEntry {
	id: number;
	timestamp: string;
	ip: string;
	providerId: string;
	model: string;
	promptTokens: number;
	completionTokens: number;
	durationMs: number;
	success: boolean;
	requestId: string;
	isStream: boolean;
	extra: Record<string, string>;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	apiKeyName: string;
}

export interface ApiKeyRecord {
	id: number;
	name: string;
	key_hash: string;
	encrypted_key: string;
	created_at: string;
	last_used_at: string | null;
	quota_calls: number | null;
	quota_tokens: number | null;
	quota_period: string;
}

export interface ApiKeyInfo {
	id: number;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
	/** Max calls per quota period (null = unlimited). */
	quotaCalls: number | null;
	/** Max tokens (prompt + completion) per quota period (null = unlimited). */
	quotaTokens: number | null;
	/** "day" | "month" */
	quotaPeriod: 'day' | 'month';
	/** Calls recorded in the current quota period (for the admin panel). */
	usageCalls: number;
	/** Tokens recorded in the current quota period. */
	usageTokens: number;
}

export interface ApiKeyQuota {
	quotaCalls: number | null;
	quotaTokens: number | null;
	quotaPeriod: 'day' | 'month';
}

/**
 * The client key record attributed to a request (auth middleware). Backs the
 * per-key quota enforcement and key-name attribution for usage recording.
 */
export interface ClientKeyRecord {
	id: number;
	name: string;
	quotaCalls: number | null;
	quotaTokens: number | null;
	quotaPeriod: 'day' | 'month';
}

/**
 * A minimal, D1-shaped database client abstraction so the same data-access code
 * runs on Cloudflare Workers (D1) and Vercel (Neon Postgres). Cloudflare's real
 * `D1Database` satisfies this structurally; `@neondatabase/serverless` is wrapped
 * by a Neon adapter in the Vercel entry point.
 */
export interface DBMeta {
	changes: number;
	last_row_id: number;
}

export interface DBResult<T> {
	results: T[];
	success: boolean;
	meta: DBMeta;
}

export interface DBPrepared {
	/** Bind positional/parameterized values. Returns this for chaining. */
	bind(...values: unknown[]): DBPrepared;
	/** Run and return all rows. */
	all<T = Record<string, unknown>>(): Promise<DBResult<T>>;
	/** Run and return the first row, or null. */
	first<T = Record<string, unknown>>(): Promise<T | null>;
	/** Run the statement (e.g. INSERT/UPDATE/DELETE) and return affected-row metadata. */
	run(): Promise<DBResult<Record<string, unknown>>>;
}

export interface DBClient {
	prepare(sql: string): DBPrepared;
}

export interface Env {
	/** Database + config/usage storage. D1 on Cloudflare, Neon on Vercel. */
	DB: DBClient;
	// Cloudflare static assets binding. On Vercel this is an inert fallback stub.
	ASSETS: { fetch: (request: Request) => Promise<Response> };
	ENCRYPTION_KEY?: string;
	OPENAI_API_KEY?: string;
	/** Optional: "ai-sdk" (default) or "direct" — Google tool-call routing mode. */
	VEGA_GOOGLE_TOOL_MODE?: string;
	/** Optional: "neon" or "d1" — overrides automatic database platform detection. */
	DATABASE_PROVIDER?: string;
	/** Optional: Waline-style engine selector — "neon"/"postgres" → Neon, "d1"/"sqlite" → D1. */
	DATABASE?: string;
	/** Optional: Neon Postgres connection string (sets database to "neon"). */
	DATABASE_URL?: string;
	/** Optional: Waline-style Postgres connection string (alias of DATABASE_URL). */
	PGURL?: string;
	/** Optional: Postgres connection string alias (commonly injected by Neon/Vercel integrations). */
	POSTGRES_URL?: string;
	/** Optional: "vercel" or "cloudflare" — overrides automatic deployment detection. */
	DEPLOYMENT_PLATFORM?: string;
}

export interface ProviderHandler {
  proxyRequest(
    request: Request,
    env: Env,
    provider: Provider,
    suffix: string
  ): Promise<Response>;
  fetchModelList(
    env: Env,
    config: Record<string, string>
  ): Promise<Model[]>;
}
