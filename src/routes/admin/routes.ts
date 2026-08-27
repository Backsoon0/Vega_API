// src/routes/admin/routes.ts
// Admin route topology and provider statistics.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types.js';
import { getRouteTopology } from '../../router.js';
import { getCircuitState } from '../../circuit-breaker.js';

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

// GET /admin/routes/stats — real provider request/latency statistics from call_logs.
// The aggregation uses provider_id directly from call_logs; no model→provider inference
// is performed. A provider with no reliably attributable logs is returned with requestCount=0
// and averageLatencyMs=null. The frontend renders null latency as “暂无数据”.
adminRouteTopologyRoutes.get('/routes/stats', async (c: Context<{ Bindings: Env }>) => {
	try {
		const requestedHours = Number(c.req.query('hours') || '24');
		const periodHours = Number.isFinite(requestedHours)
			? Math.min(Math.max(Math.floor(requestedHours), 1), 168)
			: 24;

		const to = new Date();
		const from = new Date(to.getTime() - periodHours * 60 * 60 * 1000);
		const fromIso = from.toISOString();
		const toIso = to.toISOString();

		const topology = await getRouteTopology(c.env);
		const providerMap = new Map<string, { id: string; name: string; type: string; enabled: boolean }>();
		for (const model of topology.models) {
			for (const provider of model.providers) {
				if (!providerMap.has(provider.id)) {
					providerMap.set(provider.id, {
						id: provider.id,
						name: provider.name,
						type: provider.type,
						enabled: provider.enabled,
					});
				}
			}
		}

		// call_logs stores the actual provider_id selected for each request, so this
		// is a direct attribution rather than an estimate based on the model topology.
		const rows = await c.env.DB.prepare(
			`SELECT provider_id, COUNT(*) AS request_count,
			        AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS avg_latency_ms
			 FROM call_logs
			 WHERE timestamp >= ? AND timestamp <= ?
			 GROUP BY provider_id`
		).bind(fromIso, toIso).all<{
			provider_id: string;
			request_count: number;
			avg_latency_ms: number | null;
		}>();

		const aggregate = new Map<string, { requests: number; latency: number | null }>();
		for (const row of rows.results || []) {
			aggregate.set(row.provider_id, {
				requests: Number(row.request_count) || 0,
				latency: row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
			});
		}

		const providers = Array.from(providerMap.values()).map((provider) => ({
			...provider,
			requestCount: aggregate.get(provider.id)?.requests || 0,
			averageLatencyMs: aggregate.get(provider.id)?.latency ?? null,
		}));

		const trackedRequests = providers.reduce((sum, provider) => sum + provider.requestCount, 0);
		const latencyWeighted = providers.reduce((sum, provider) => {
			if (provider.averageLatencyMs == null || provider.requestCount === 0) return sum;
			return sum + provider.averageLatencyMs * provider.requestCount;
		}, 0);
		const latencySamples = providers.reduce((sum, provider) =>
			sum + (provider.averageLatencyMs == null ? 0 : provider.requestCount), 0);

		const healthyUpstreams = providers.filter((provider) =>
			provider.enabled && getCircuitState(provider.id) === 'closed'
		).length;

		// 12 buckets for the selected period. Each bucket contains the average latency
		// for providers that have directly attributable samples in that interval.
		const bucketCount = 12;
		const bucketMs = (to.getTime() - from.getTime()) / bucketCount;
		const bucketRows = await c.env.DB.prepare(
			`SELECT provider_id,
			        CAST(((julianday(timestamp) - julianday(?)) * 86400000.0) / ? AS INTEGER) AS bucket,
			        AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS avg_latency_ms
			 FROM call_logs
			 WHERE timestamp >= ? AND timestamp <= ?
			 GROUP BY provider_id, bucket
			 ORDER BY bucket ASC`
		).bind(fromIso, bucketMs, fromIso, toIso).all<{
			provider_id: string;
			bucket: number;
			avg_latency_ms: number | null;
		}>();

		const bucketMap = new Map<string, Map<number, number | null>>();
		for (const row of bucketRows.results || []) {
			if (!bucketMap.has(row.provider_id)) bucketMap.set(row.provider_id, new Map());
			bucketMap.get(row.provider_id)!.set(
				Math.min(Math.max(Number(row.bucket) || 0, 0), bucketCount - 1),
				row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
			);
		}

		const trackedProviderIds = providers
			.filter((provider) => provider.requestCount > 0 && provider.averageLatencyMs != null)
			.map((provider) => provider.id);
		const points = Array.from({ length: bucketCount }, (_, index) => ({
			timestamp: new Date(from.getTime() + index * bucketMs).toISOString(),
			providers: Object.fromEntries(
				trackedProviderIds.map((providerId) => [providerId, bucketMap.get(providerId)?.get(index) ?? null]),
			),
		}));

		return c.json({
			periodHours,
			from: fromIso,
			to: toIso,
			overview: {
				models: topology.models.length,
				upstreams: providers.length,
				healthyUpstreams,
				trackedRequests,
				averageLatencyMs: latencySamples > 0 ? latencyWeighted / latencySamples : null,
			},
			providers,
			latency: {
				providerIds: trackedProviderIds,
				points,
			},
		});
	} catch (err) {
		console.error('Route statistics error:', (err as Error).message);
		return c.json({ error: 'Failed to build route statistics' }, 500);
	}
});
