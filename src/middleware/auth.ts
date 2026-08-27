// src/middleware/auth.ts
// Client and admin authentication middleware

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { getClientApiKey, getAdminPasswordHash, findApiKeyNameByHash, hasAnyApiKeys } from '../config';
import { hashKey } from '../crypto';

// ---- In-memory cache for hot-path auth lookups ----
// Avoids D1 reads on every request. TTL balances freshness vs latency.

const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { name: string; expiresAt: number }>();
let anyKeysCached: boolean | null = null;
let anyKeysExpiresAt = 0;

// Request-scoped key attribution: middleware stores the matched key name keyed by
// the raw Request, so the route handlers can read it without mutating the shared
// `env` object (which would leak values across concurrent requests on one isolate).
const clientKeyNames = new WeakMap<Request, string>();

/** Read the client key name attributed to this request ('' if public/unknown). */
export function getClientKeyName(request: Request): string {
	return clientKeyNames.get(request) ?? '';
}

function getCachedKeyName(hash: string): string | null {
	const entry = authCache.get(hash);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		authCache.delete(hash);
		return null;
	}
	return entry.name;
}

/**
 * Invalidate the in-memory auth caches. Called by admin routes after any
 * client API key mutation (create/delete/rename/migrate) so that:
 *   - deleted keys stop authenticating immediately (no 60s stale window)
 *   - newly created first key takes effect immediately (no 60s public-mode window)
 */
export function invalidateAuthCache(): void {
	authCache.clear();
	anyKeysCached = null;
	anyKeysExpiresAt = 0;
}

function setCachedKeyName(hash: string, name: string) {
	// Probabilistic eviction: ~5% chance of cleaning expired entries on write
	if (Math.random() < 0.05) {
		const now = Date.now();
		for (const [k, v] of authCache) {
			if (now > v.expiresAt) authCache.delete(k);
		}
	}
	authCache.set(hash, { name, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
	// Keep cache from growing unbounded (max 5000 entries ~= ~500KB)
	if (authCache.size > 5000) {
		const oldest = [...authCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
		for (let i = 0; i < 1000; i++) {
			if (oldest[i]) authCache.delete(oldest[i][0]);
		}
	}
}

async function cachedFindApiKeyNameByHash(env: Env, keyHash: string): Promise<{ id: number; name: string } | null> {
	const cached = getCachedKeyName(keyHash);
	if (cached !== null) return { id: 0, name: cached };

	const result = await findApiKeyNameByHash(env, keyHash);
	if (result) setCachedKeyName(keyHash, result.name);
	return result;
}

async function cachedHasAnyApiKeys(env: Env): Promise<boolean> {
	if (anyKeysCached !== null && Date.now() < anyKeysExpiresAt) return anyKeysCached;
	const result = await hasAnyApiKeys(env);
	anyKeysCached = result;
	anyKeysExpiresAt = Date.now() + AUTH_CACHE_TTL_MS;
	return result;
}

/** Validate client API key for all API routes.
 * Checks Authorization: Bearer, x-api-key (Anthropic), x-goog-api-key (Google), and ?key= query parameter.
 * Falls back to env.OPENAI_API_KEY. If neither is set, all requests pass.
 * Supports legacy single key (config.client_api_key) and multi-key (api_keys table).
 *
 * @returns the matched key name ('' in public mode) on success, or null when auth fails.
 * NOTE: never mutates `env` — the name is returned and stored request-scoped by the
 * middleware (mutating `env` leaks values across requests sharing the same isolate). */
export async function checkClientAuth(c: Context<{ Bindings: Env }>): Promise<string | null> {
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
		return '(默认密钥)';
	}

	// 2. Check multi-key table (api_keys) — hash-based lookup
	if (providedKey) {
		const keyHash = await hashKey(providedKey);
		const match = await cachedFindApiKeyNameByHash(env, keyHash);
		if (match) {
			return match.name;
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
			return '(环境变量密钥)';
		}
		return null;
	}

	// 5. No keys configured — public mode (no key attribution)
	return '';
}

/** Validate admin token (SHA-256 hash) for /admin/* routes. */
export async function requireAdminAuth(c: Context<any>): Promise<boolean> {
	const auth = c.req.header('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!token) return false;
	const storedHash = await getAdminPasswordHash(c.env);
	return !!(storedHash && token === storedHash);
}

/** Hono middleware: returns 401 if client auth fails. Stores the matched key
 * name keyed by the raw Request (WeakMap) — never on the shared env object. */
export function clientAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		const keyName = await checkClientAuth(c);
		if (keyName === null) {
			return c.json({ error: { message: 'Unauthorized' } }, 401);
		}
		clientKeyNames.set(c.req.raw, keyName);
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
