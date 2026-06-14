// src/routes/admin/usage.ts
// Admin usage statistics and call log routes

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { getUsage, getUsageTotals, getCallLogs } from '../../usage';

export const adminUsageRoutes = new Hono<{ Bindings: Env }>();

// GET /admin/usage — Usage statistics (totals or date-filtered)
adminUsageRoutes.get('/usage', async (c: Context<{ Bindings: Env }>) => {
	const from = c.req.query('from') || '';
	const to = c.req.query('to') || '';
	if (!from && !to) {
		const totals = await getUsageTotals(c.env);
		return c.json({ totals });
	}
	const data = await getUsage(c.env, from, to, null);
	return c.json(data);
});

// GET /admin/logs — Call logs from D1 (with search, filter, pagination)
adminUsageRoutes.get('/logs', async (c: Context<{ Bindings: Env }>) => {
	const search = c.req.query('search') || '';
	const providerId = c.req.query('providerId') || '';
	const isStream = c.req.query('isStream') || '';
	const success = c.req.query('success') || '';
	const includeTotal = c.req.query('includeTotal') !== 'false';
	const limit = parseInt(c.req.query('limit') || '200');
	const offset = parseInt(c.req.query('offset') || '0');
	const data = await getCallLogs(c.env, { search, providerId, isStream, success, includeTotal, limit, offset });
	return c.json(data);
});
