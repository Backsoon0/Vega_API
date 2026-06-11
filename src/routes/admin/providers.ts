// src/routes/admin/providers.ts
// Admin provider CRUD routes

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import {
	listProvidersMasked,
	getProvider,
	saveProvider,
	deleteProvider,
} from '../../config';

export const adminProviderRoutes = new Hono<{ Bindings: Env }>();

// GET /admin/providers — List all providers (masked)
adminProviderRoutes.get('/providers', async (c: Context<{ Bindings: Env }>) => {
	const providers = await listProvidersMasked(c.env);
	return c.json(providers);
});

// POST /admin/providers — Create provider
adminProviderRoutes.post('/providers', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => null);
	if (!body) return c.json({ error: 'Invalid JSON' }, 400);
	try {
		const record = await saveProvider(c.env, body);
		return c.json(record, 201);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 400);
	}
});

// GET /admin/providers/:id — Get single provider
adminProviderRoutes.get('/providers/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = c.req.param('id');
	if (!id) return c.json({ error: 'Provider ID required' }, 400);
	const provider = await getProvider(c.env, id);
	if (!provider) return c.json({ error: 'Not found' }, 404);
	return c.json(provider);
});

// PUT /admin/providers/:id — Update provider
adminProviderRoutes.put('/providers/:id', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => null);
	if (!body) return c.json({ error: 'Invalid JSON' }, 400);
	body.id = c.req.param('id');
	try {
		const record = await saveProvider(c.env, body);
		return c.json(record);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 400);
	}
});

// DELETE /admin/providers/:id — Delete provider
adminProviderRoutes.delete('/providers/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = c.req.param('id');
	if (!id) return c.json({ error: 'Provider ID required' }, 400);
	await deleteProvider(c.env, id);
	return c.json({ ok: true });
});
