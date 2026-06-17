// src/routes/admin/auth.ts
// Admin auth routes: login, setup, check, change-password, fail2ban-config

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { sha256 } from '../../crypto';
import { getAdminPasswordHash, setAdminPassword, getFailoverEnabled, setFailoverEnabled } from '../../config';
import { rateLimitLogin, recordLoginFailure, resetLoginRate, getRateLimitConfig } from '../../rate-limit';
import { requireAdminAuth } from '../../middleware/auth';

export const adminAuthRoutes = new Hono<{ Bindings: Env }>();

// POST /admin/auth — Login (rate-limited)
adminAuthRoutes.post('/auth', rateLimitLogin, async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const password = String(body.password || '');
	if (!password) return c.json({ error: 'Password is required' }, 400);

	const storedHash = await getAdminPasswordHash(c.env);

	// First login sets the password
	if (!storedHash) {
		const hash = await sha256(password);
		await setAdminPassword(c.env, hash);
		return c.json({ ok: true, token: hash, message: 'Password set successfully' });
	}

	const inputHash = await sha256(password);
	if (inputHash !== storedHash) {
		return recordLoginFailure(c);
	}

	await resetLoginRate(c);
	return c.json({ ok: true, token: storedHash });
});

// POST /admin/setup — Initial password setup (no auth required)
adminAuthRoutes.post('/setup', async (c: Context<{ Bindings: Env }>) => {
	const storedHash = await getAdminPasswordHash(c.env);
	if (storedHash) return c.json({ error: 'Password already set' }, 400);

	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const password = String(body.password || '');
	if (!password || password.length < 6) {
		return c.json({ error: 'Password must be at least 6 characters' }, 400);
	}

	const hash = await sha256(password);
	await setAdminPassword(c.env, hash);
	return c.json({ ok: true, token: hash, message: 'Admin password set' });
});

// GET /admin/check — Auth status check
adminAuthRoutes.get('/check', async (c: Context<{ Bindings: Env }>) => {
	if (await requireAdminAuth(c)) return c.json({ authenticated: true });
	return c.json({ error: 'Unauthorized' }, 401);
});

// GET /admin/fail2ban-config — Rate limit configuration
adminAuthRoutes.get('/fail2ban-config', (c: Context<{ Bindings: Env }>) => {
	return c.json(getRateLimitConfig());
});

// POST /admin/change-password — Change admin password (requires auth)
adminAuthRoutes.post('/change-password', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const current = String(body.currentPassword || '');
	const newPass = String(body.newPassword || '');
	if (!current || !newPass) {
		return c.json({ error: 'currentPassword and newPassword are required' }, 400);
	}
	if (newPass.length < 6) {
		return c.json({ error: 'New password must be at least 6 characters' }, 400);
	}
	const storedHash = await getAdminPasswordHash(c.env);
	if ((await sha256(current)) !== storedHash) {
		return c.json({ error: 'Current password is incorrect' }, 401);
	}
	const newHash = await sha256(newPass);
	await setAdminPassword(c.env, newHash);
	return c.json({ ok: true, token: newHash, message: 'Password changed' });
});

// GET /admin/settings — Get all settings
adminAuthRoutes.get('/settings', async (c: Context<{ Bindings: Env }>) => {
	const failoverEnabled = await getFailoverEnabled(c.env);
	return c.json({
		failoverEnabled,
	});
});

// PUT /admin/settings — Update settings
adminAuthRoutes.put('/settings', async (c: Context<{ Bindings: Env }>) => {
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	if (typeof body.failoverEnabled === 'boolean') {
		await setFailoverEnabled(c.env, body.failoverEnabled);
	}
	return c.json({ ok: true, message: '设置已保存' });
});
