// src/routes/admin/client-key.ts
// Admin client API key management routes

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { getClientApiKey, setClientApiKey } from '../../config';

export const adminClientKeyRoutes = new Hono<{ Bindings: Env }>();

// GET /admin/client-key — Get client key info (masked by default, ?reveal=true to show)
adminClientKeyRoutes.get('/client-key', async (c: Context<{ Bindings: Env }>) => {
	const key = await getClientApiKey(c.env);
	if (!key) {
		return c.json({ configured: false, message: 'No client API key set. /v1/* routes are public.' });
	}
	const reveal = c.req.query('reveal') === 'true';
	const masked = key.length > 8 ? '*'.repeat(key.length - 4) + key.slice(-4) : '****';
	const result: Record<string, unknown> = {
		configured: true,
		masked,
		length: key.length,
		prefix: key.substring(0, 4),
	};
	if (reveal) result.fullKey = key;
	return c.json(result);
});

// POST /admin/client-key — Set or generate client API key
adminClientKeyRoutes.post('/client-key', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	let key = String(body.key || '');
	if (body.generate || !key) {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		key = 'sk-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	if (key.length < 8) return c.json({ error: 'API key must be at least 8 characters' }, 400);
	await setClientApiKey(c.env, key);
	const masked = key.length > 8 ? '*'.repeat(key.length - 4) + key.slice(-4) : '****';
	return c.json({
		ok: true,
		message: 'Client API key set',
		masked,
		fullKey: key,
		configured: true,
	});
});

// DELETE /admin/client-key — Remove client API key (makes /v1/* public)
adminClientKeyRoutes.delete('/client-key', async (c: Context<{ Bindings: Env }>) => {
	await setClientApiKey(c.env, null);
	return c.json({ ok: true, message: 'Client API key removed. /v1/* routes are now public.' });
});
