// src/middleware/auth.ts
// Client and admin authentication middleware

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { getClientApiKey, getAdminPasswordHash } from '../config';

/** Validate client API key for /v1/* routes. Falls back to env.OPENAI_API_KEY. If neither is set, all requests pass. */
export async function checkClientAuth(c: Context<{ Bindings: Env }>): Promise<boolean> {
	const env = c.env;
	const kvKey = await getClientApiKey(env);
	if (kvKey) {
		const auth = c.req.header('Authorization') || '';
		return auth === `Bearer ${kvKey}`;
	}
	if (env.OPENAI_API_KEY) {
		const auth = c.req.header('Authorization') || '';
		return auth === `Bearer ${env.OPENAI_API_KEY}`;
	}
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
