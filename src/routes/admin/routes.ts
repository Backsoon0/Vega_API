// src/routes/admin/routes.ts
// Admin route topology — read-only visualization of how every model is routed.
//
// GET /admin/routes — returns the full model → provider routing topology.
// The DTO is built server-side by reusing the SAME primitives the real request
// path uses (loadProviders / getAggregatedModels / getModelProviders via
// router.getRouteTopology), so the admin panel sees exactly what /v1/*,
// /v1beta/* and /anthropic/* requests see. No provider config (apiKey,
// privateKey, …) is ever included — only whitelisted routing fields.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { getRouteTopology } from '../../router';

export const adminRouteTopologyRoutes = new Hono<{ Bindings: Env }>();

// GET /admin/routes — model route topology
adminRouteTopologyRoutes.get('/routes', async (c: Context<{ Bindings: Env }>) => {
	try {
		const { models, failoverEnabled } = await getRouteTopology(c.env);
		return c.json({
			models,
			failoverEnabled,
			generatedAt: new Date().toISOString(),
		});
	} catch (err) {
		console.error('Route topology error:', (err as Error).message);
		return c.json({ error: 'Failed to build route topology' }, 500);
	}
});