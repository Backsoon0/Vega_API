// src/routes/admin/client-key.ts
// Admin API key management routes — multi-key CRUD

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types.js';
import { listApiKeys, createApiKey, deleteApiKey, renameApiKey, updateApiKeyQuota, migrateLegacyApiKey, getClientApiKey, setClientApiKey } from '../../config.js';
import { invalidateAuthCache } from '../../middleware/auth.js';

export const adminApiKeyRoutes = new Hono<{ Bindings: Env }>();

/** Parse a quota limit field: empty/undefined → null (unlimited), non-negative int otherwise. */
function parseQuotaNum(v: unknown): number | null {
	if (v === undefined || v === null || v === '') return null;
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseQuotaPeriod(v: unknown): 'day' | 'month' {
	return v === 'month' ? 'month' : 'day';
}

// GET /admin/api-keys — List all keys (info only, no secrets) + current usage
adminApiKeyRoutes.get('/api-keys', async (c: Context<{ Bindings: Env }>) => {
	const keys = await listApiKeys(c.env);
	// Also include legacy key status
	const legacyKey = await getClientApiKey(c.env);
	return c.json({
		keys,
		hasLegacyKey: !!legacyKey,
	});
});

// POST /admin/api-keys — Create a new key with a name (+ optional quota)
adminApiKeyRoutes.post('/api-keys', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const name = String(body.name || '').trim();
	if (!name) return c.json({ error: '密钥名称不能为空' }, 400);

	let key = String(body.key || '');
	if (body.generate || !key) {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		key = 'sk-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}
	if (key.length < 8) return c.json({ error: 'API key 至少需要 8 个字符' }, 400);

	const info = await createApiKey(c.env, name, key, {
		quotaCalls: parseQuotaNum(body.quotaCalls),
		quotaTokens: parseQuotaNum(body.quotaTokens),
		quotaPeriod: parseQuotaPeriod(body.quotaPeriod),
	});
	invalidateAuthCache(); // new key must be enforceable immediately
	return c.json({
		ok: true,
		message: `密钥 "${name}" 已创建`,
		key: info,
		fullKey: key,
	});
});

// PUT /admin/api-keys/:id — Rename a key and/or update its quota
adminApiKeyRoutes.put('/api-keys/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = parseInt(c.req.param('id') || '0');
	if (!id) return c.json({ error: '无效的密钥 ID' }, 400);
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

	let updated = false;

	// Rename (backwards compatible)
	const name = String(body.name || '').trim();
	if (body.name !== undefined) {
		if (!name) return c.json({ error: '密钥名称不能为空' }, 400);
		updated = await renameApiKey(c.env, id, name) || updated;
	}

	// Quota update — the admin panel always sends the full triple
	if (body.quota !== undefined) {
		updated = await updateApiKeyQuota(c.env, id, {
			quotaCalls: parseQuotaNum(body.quota?.quotaCalls),
			quotaTokens: parseQuotaNum(body.quota?.quotaTokens),
			quotaPeriod: parseQuotaPeriod(body.quota?.quotaPeriod),
		}) || updated;
	}

	if (!updated) return c.json({ error: '密钥不存在' }, 404);
	invalidateAuthCache(); // cached key→record mapping is now stale
	const fresh = await listApiKeys(c.env).catch(() => []);
	const key = fresh.find((k) => k.id === id);
	return c.json({ ok: true, message: '密钥已更新', key });
});

// POST /admin/api-keys/legacy/migrate — Migrate legacy key to a named key
adminApiKeyRoutes.post('/api-keys/legacy/migrate', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const name = String(body.name || '').trim();
	if (!name) return c.json({ error: '密钥名称不能为空' }, 400);
	const info = await migrateLegacyApiKey(c.env, name);
	if (!info) return c.json({ error: '没有旧版密钥可迁移' }, 404);
	invalidateAuthCache();
	return c.json({ ok: true, message: `旧版密钥已迁移为 "${name}"`, key: info });
});

// DELETE /admin/api-keys/:id — Delete a key
adminApiKeyRoutes.delete('/api-keys/:id', async (c: Context<{ Bindings: Env }>) => {
	const id = parseInt(c.req.param('id') || '0');
	if (!id) return c.json({ error: '无效的密钥 ID' }, 400);
	const deleted = await deleteApiKey(c.env, id);
	if (!deleted) return c.json({ error: '密钥不存在' }, 404);
	invalidateAuthCache(); // deleted key must stop authenticating immediately
	return c.json({ ok: true, message: '密钥已删除' });
});

// DELETE /admin/api-keys/legacy — Delete the legacy key
adminApiKeyRoutes.delete('/api-keys/legacy', async (c: Context<{ Bindings: Env }>) => {
	await setClientApiKey(c.env, null);
	invalidateAuthCache();
	return c.json({ ok: true, message: '旧版密钥已删除' });
});