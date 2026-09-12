// src/routes/admin/usage.ts
// Admin usage statistics and call log routes

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types.js';
import { getUsage, getUsageTotals, getCallLogs, getUsageReport } from '../../usage.js';

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

// GET /admin/usage/report?hours=24&tz=480 — 用量报表: series + byModel + byKey.
// Granularity follows the range: hours <= 24 → hourly series (from call_logs),
// longer → daily series (from usage_hourly, split by the viewer's local day).
// `tz` is the viewer's UTC offset in minutes east of UTC (default 0 = UTC);
// the legacy `?days=N` form still works and always returns day granularity.
adminUsageRoutes.get('/usage/report', async (c: Context<{ Bindings: Env }>) => {
	const hours = c.req.query('hours');
	const days = c.req.query('days');
	const tz = c.req.query('tz');
	const tzOffsetMinutes = tz != null ? parseInt(tz, 10) : 0;
	const report = await getUsageReport(
		c.env,
		hours != null
			? { hours: parseInt(hours, 10), tzOffsetMinutes }
			: { days: parseInt(days || '7', 10), tzOffsetMinutes },
	);
	return c.json(report);
});

// GET /admin/logs — Call logs from D1 (with search, filter, pagination)
adminUsageRoutes.get('/logs', async (c: Context<{ Bindings: Env }>) => {
	const search = c.req.query('search') || '';
	const providerId = c.req.query('providerId') || '';
	const isStream = c.req.query('isStream') || '';
	const success = c.req.query('success') || '';
	const limit = parseInt(c.req.query('limit') || '200');
	const offset = parseInt(c.req.query('offset') || '0');
	const data = await getCallLogs(c.env, { search, providerId, isStream, success, limit, offset });
	return c.json(data);
});

// DELETE /admin/logs — Clear all call logs (one-click wipe from the admin panel).
// Only the detail records (call_logs) are deleted; aggregated usage stats (usage_daily) are kept.
adminUsageRoutes.delete('/logs', async (c: Context<{ Bindings: Env }>) => {
	const result = await c.env.DB.prepare('DELETE FROM call_logs').run();
	return c.json({
		ok: true,
		deleted: result.meta.changes,
		message: '调用记录已清空',
	});
});
