// src/middleware/auth.ts
// Client and admin authentication middleware

import type { Context, MiddlewareHandler } from 'hono';
import type { Env, ClientKeyRecord } from '../types.js';
import { getClientApiKey, getAdminPasswordHash, findApiKeyNameByHash, hasAnyApiKeys, getKeyUsageByName } from '../config.js';
import { hashKey } from '../crypto.js';

// ---- In-memory cache for hot-path auth lookups ----
// Avoids D1 reads on every request. TTL balances freshness vs latency.

const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { record: ClientKeyRecord; expiresAt: number }>();
let anyKeysCached: boolean | null = null;
let anyKeysExpiresAt = 0;

// Request-scoped key attribution: middleware stores the matched key record keyed
// by the raw Request, so route handlers can read the name (and, for quota, the
// record) without mutating the shared `env` object (which would leak values
// across concurrent requests on one isolate).
const clientKeyRecords = new WeakMap<Request, ClientKeyRecord>();

/** Read the client key name attributed to this request ('' if public/unknown). */
export function getClientKeyName(request: Request): string {
	return clientKeyRecords.get(request)?.name ?? '';
}

/**
 * Read the full matched client key record (id, name, quota config) attributed to
 * this request. Returns null for legacy/env/public keys (no per-key quota).
 */
export function getClientKeyRecord(request: Request): ClientKeyRecord | null {
	return clientKeyRecords.get(request) ?? null;
}

function getCachedKeyRecord(hash: string): ClientKeyRecord | null {
	const entry = authCache.get(hash);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		authCache.delete(hash);
		return null;
	}
	return entry.record;
}

/**
 * Invalidate the in-memory auth caches. Called by admin routes after any
 * client API key mutation (create/delete/rename/migrate/quota) so that:
 *   - deleted keys stop authenticating immediately (no 60s stale window)
 *   - newly created first key takes effect immediately (no 60s public-mode window)
 *   - quota changes are enforced immediately
 */
export function invalidateAuthCache(): void {
	authCache.clear();
	anyKeysCached = null;
	anyKeysExpiresAt = 0;
}

function setCachedKeyRecord(hash: string, record: ClientKeyRecord) {
	// Probabilistic eviction: ~5% chance of cleaning expired entries on write
	if (Math.random() < 0.05) {
		const now = Date.now();
		for (const [k, v] of authCache) {
			if (now > v.expiresAt) authCache.delete(k);
		}
	}
	authCache.set(hash, { record, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
	// Keep cache from growing unbounded (max 5000 entries ~= ~500KB)
	if (authCache.size > 5000) {
		const oldest = [...authCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
		for (let i = 0; i < 1000; i++) {
			if (oldest[i]) authCache.delete(oldest[i][0]);
		}
	}
}

async function cachedFindApiKeyByHash(env: Env, keyHash: string): Promise<ClientKeyRecord | null> {
	const cached = getCachedKeyRecord(keyHash);
	if (cached) return cached;

	const result = await findApiKeyNameByHash(env, keyHash);
	// Note: `findApiKeyNameByHash` already refreshed `last_used_at` on a hit.
	if (result) setCachedKeyRecord(keyHash, result);
	return result;
}

async function cachedHasAnyApiKeys(env: Env): Promise<boolean> {
	if (anyKeysCached !== null && Date.now() < anyKeysExpiresAt) return anyKeysCached;
	const result = await hasAnyApiKeys(env);
	anyKeysCached = result;
	anyKeysExpiresAt = Date.now() + AUTH_CACHE_TTL_MS;
	return result;
}

/**
 * Validate client API key for all API routes.
 * Checks Authorization: Bearer, x-api-key (Anthropic), x-goog-api-key (Google), and ?key= query parameter.
 * Falls back to env.OPENAI_API_KEY. If neither is set, all requests pass.
 * Supports legacy single key (config.client_api_key) and multi-key (api_keys table).
 *
 * @returns the matched key attribution { name, record } on success, or null when auth fails.
 * NOTE: never mutates `env` — the attribution is stored request-scoped by the
 * middleware (mutating `env` leaks values across requests sharing one isolate). */
export async function checkClientAuth(c: Context<{ Bindings: Env }>): Promise<{ name: string; record: ClientKeyRecord | null } | null> {
	const env = c.env;

	// Extract the provided key from headers/query
	function extractProvidedKey(): string {
		const auth = c.req.header('Authorization') || '';
		if (auth.startsWith('Bearer ')) return auth.slice(7);
		const apiKey = c.req.header('x-api-key') || '';
		if (apiKey) return apiKey;
		const googKey = c.req.header('x-goog-api-key') || '';
		if (googKey) return googKey;
		return c.req.query('key') || '';
	}

	const providedKey = extractProvidedKey();

	// 1. Check legacy single key (config.client_api_key)
	const kvKey = await getClientApiKey(env);
	if (kvKey && providedKey === kvKey) {
		return { name: '(默认密钥)', record: null };
	}

	// 2. Check multi-key table (api_keys) — hash-based lookup
	if (providedKey) {
		const keyHash = await hashKey(providedKey);
		const match = await cachedFindApiKeyByHash(env, keyHash);
		if (match) {
			return { name: match.name, record: match };
		}
	}

	// 3. If a legacy key is set and the provided key doesn't match, deny access
	if (kvKey) return null;

	// 3b. If the multi-key table has any rows, deny access — auth is configured,
	//     the provided key didn't match any of them, so this is NOT public mode.
	if (await cachedHasAnyApiKeys(env)) return null;

	// 4. Fall back to env.OPENAI_API_KEY
	if (env.OPENAI_API_KEY) {
		const auth = c.req.header('Authorization') || '';
		if (auth === `Bearer ${env.OPENAI_API_KEY}`) {
			return { name: '(环境变量密钥)', record: null };
		}
		return null;
	}

	// 5. No keys configured — public mode (no key attribution)
	return { name: '', record: null };
}

/** Validate admin token (SHA-256 hash) for /admin/* routes. */
export async function requireAdminAuth(c: Context<any>): Promise<boolean> {
	const auth = c.req.header('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!token) return false;
	const storedHash = await getAdminPasswordHash(c.env);
	return !!(storedHash && token === storedHash);
}

/**
 * Enforce the per-key quota (if configured) for the current request.
 * Uses the same `key_usage_daily` lookup as `recordUsage` writes, so counts
 * agree. Returns a 429 Response when exceeded, null when allowed.
 */
async function checkKeyQuota(c: Context<{ Bindings: Env }>, record: ClientKeyRecord): Promise<Response | null> {
	const { quotaCalls, quotaTokens, quotaPeriod, name } = record;
	if (!quotaCalls && !quotaTokens) return null;

	const usage = await getKeyUsageByName(c.env, name, quotaPeriod);

	if (
		(quotaCalls != null && usage.calls >= quotaCalls) ||
		(quotaTokens != null && usage.tokens >= quotaTokens)
	) {
		const retryAfter = quotaPeriod === 'month' ? '2592000' : '86400';
		return c.json(
			{
				error: {
					message: `API 密钥 "${name}" 的配额已用尽（insufficient_quota）：调用 ${usage.calls}${quotaCalls != null ? `/${quotaCalls}` : ''}，Token ${usage.tokens}${quotaTokens != null ? `/${quotaTokens}` : ''}（${quotaPeriod === 'month' ? '本月' : '今日'}）。请升级配额或等待周期重置。`,
					type: 'insufficient_quota',
					quota: {
						period: quotaPeriod,
						calls: usage.calls,
						limitCalls: quotaCalls,
						tokens: usage.tokens,
						limitTokens: quotaTokens,
					},
				},
			},
			429,
			{ 'Retry-After': retryAfter, 'x-should-retry': 'false' },
		);
	}
	return null;
}

/** Hono middleware: returns 401 if client auth fails, 429 if the key's quota is
 * exceeded. Stores the matched key record keyed by the raw Request (WeakMap) —
 * never on the shared env object. */
export function clientAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		const auth = await checkClientAuth(c);
		if (auth === null) {
			return c.json({ error: { message: 'Unauthorized' } }, 401);
		}
		if (auth.record) {
			const quotaBlocked = await checkKeyQuota(c, auth.record);
			if (quotaBlocked) return quotaBlocked;
			clientKeyRecords.set(c.req.raw, auth.record);
		} else {
			clientKeyRecords.delete(c.req.raw);
		}
		return next();
	};
}

/** Hono middleware: returns 401 if admin auth fails. Respects skip list for public admin routes. */
export function adminAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
	const skipAuth = ['/admin/auth', '/admin/setup', '/admin/check', '/admin/fail2ban-config'];
	return async (c, next) => {
		if (skipAuth.includes(c.req.path)) return next();
		if (await requireAdminAuth(c)) return next();
		return c.json({ error: 'Unauthorized' }, 401);
	};
}