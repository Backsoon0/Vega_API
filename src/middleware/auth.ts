// src/middleware/auth.ts
// Client and admin authentication middleware

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { getClientApiKey, getAdminPasswordHash, findApiKeyNameByHash, hasAnyApiKeys } from '../config';
import { hashKey } from '../crypto';

/** Validate client API key for all API routes.
 * Checks Authorization: Bearer, x-api-key (Anthropic), x-goog-api-key (Google), and ?key= query parameter.
 * Falls back to env.OPENAI_API_KEY. If neither is set, all requests pass.
 * Supports legacy single key (config.client_api_key) and multi-key (api_keys table).
 * Sets c.env.clientKeyName on match for logging. */
export async function checkClientAuth(c: Context<{ Bindings: Env }>): Promise<boolean> {
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
		env.clientKeyName = '(默认密钥)';
		return true;
	}

	// 2. Check multi-key table (api_keys) — hash-based lookup
	if (providedKey) {
		const keyHash = await hashKey(providedKey);
		const match = await findApiKeyNameByHash(env, keyHash);
		if (match) {
			env.clientKeyName = match.name;
			return true;
		}
	}

	// 3. If a legacy key is set and the provided key doesn't match, deny access
	if (kvKey) return false;

	// 3b. If the multi-key table has any rows, deny access — auth is configured,
	//     the provided key didn't match any of them, so this is NOT public mode.
	if (await hasAnyApiKeys(env)) return false;

	// 4. Fall back to env.OPENAI_API_KEY
	if (env.OPENAI_API_KEY) {
		const auth = c.req.header('Authorization') || '';
		if (auth === `Bearer ${env.OPENAI_API_KEY}`) {
			env.clientKeyName = '(环境变量密钥)';
			return true;
		}
		return false;
	}

	// 5. No keys configured — public mode
	return true;
}

/** Validate admin token (SHA-256 hash) for /admin/* routes. */
export async function requireAdminAuth(c: Context<{ Bindings: Env }>): Promise<boolean> {
	const auth = c.req.header('Authorization') || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!token) return false;
	const storedHash = await getAdminPasswordHash(c.env);
	return !!(storedHash && token === storedHash);
}

/** Hono middleware: returns 401 if client auth fails. */
export function clientAuthMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
	return async (c, next) => {
		if (!(await checkClientAuth(c))) {
			return c.json({ error: { message: 'Unauthorized' } }, 401);
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
