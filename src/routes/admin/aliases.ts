// src/routes/admin/aliases.ts
// Admin CRUD for model alias / redirect rules (feature 1).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types.js';
import {
	listAliases,
	getAliasById,
	upsertAlias,
	deleteAlias,
	setAliasEnabled,
} from '../../aliases.js';

export const adminAliasRoutes = new Hono<{ Bindings: Env }>();

// GET /admin/aliases — list all alias rules
adminAliasRoutes.get('/aliases', async (c: Context<{ Bindings: Env }>) => {
	const aliases = await listAliases(c.env);
	return c.json(aliases);
});

// POST /admin/aliases — create a rule
adminAliasRoutes.post('/aliases', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	try {
		const record = await upsertAlias(c.env, body);
		return c.json(record, 201);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 400);
	}
});

// PUT /admin/aliases/:id — update a rule (full replace)
adminAliasRoutes.put('/aliases/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = Number(c.req.param('id'));
	if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return c.json({ error: 'Invalid JSON' }, 400);
	}
	try {
		const record = await upsertAlias(c.env, body, id);
		return c.json(record);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 400);
	}
});

// PATCH /admin/aliases/:id/enabled — toggle enabled
adminAliasRoutes.patch('/aliases/:id/enabled', async (c: Context<{ Bindings: Env }>) => {
	const id = Number(c.req.param('id'));
	if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
	const body = await c.req.json().catch(() => null);
	const enabled = body?.enabled === true;
	const ok = await setAliasEnabled(c.env, id, enabled);
	if (!ok) return c.json({ error: '别名规则不存在' }, 404);
	return c.json({ ok: true });
});

// DELETE /admin/aliases/:id — delete a rule
adminAliasRoutes.delete('/aliases/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = Number(c.req.param('id'));
	if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
	const ok = await deleteAlias(c.env, id);
	if (!ok) return c.json({ error: '别名规则不存在' }, 404);
	return c.json({ ok: true });
});

// GET /admin/aliases/:id — single rule (helpful for editing)
adminAliasRoutes.get('/aliases/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = Number(c.req.param('id'));
	if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
	const rule = await getAliasById(c.env, id);
	if (!rule) return c.json({ error: '别名规则不存在' }, 404);
	return c.json(rule);
});
