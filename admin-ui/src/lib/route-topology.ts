// admin-ui/src/lib/route-topology.ts
// Pure (framework-free) helpers for the route-topology tree page.
// No Svelte imports here on purpose — these are unit-tested in the worker
// test pool and consumed by the Svelte page.

import type {
	RouteTopologyModel,
	RouteTopologyProvider,
	RoutingMode,
} from './api';

export type HealthStatus = 'healthy' | 'half-open' | 'open' | 'disabled';

/** Effective health of a provider node (disabled wins over circuit state). */
export function providerHealth(p: RouteTopologyProvider): HealthStatus {
	if (!p.enabled) return 'disabled';
	if (p.circuitState === 'open') return 'open';
	if (p.circuitState === 'half-open') return 'half-open';
	return 'healthy';
}

export const MODE_LABELS: Record<RoutingMode, string> = {
	priority: 'Priority Route',
	failover: 'Failover',
	weighted: 'Weighted',
};

export const MATCHED_BY_LABELS: Record<RouteTopologyProvider['matchedBy'], string> = {
	configured: '显式配置',
	live: '实时模型列表',
	prefix: '前缀匹配',
	fallback: '兜底全部',
};

export const HEALTH_LABELS: Record<HealthStatus, string> = {
	healthy: 'Healthy',
	'half-open': 'Half Open',
	open: 'Circuit Open',
	disabled: 'Disabled',
};

/** Summary counters for a model node (used for badges + availability flags). */
export interface ModelStats {
	total: number; // providers shown in the tree
	available: number; // enabled providers
	disabled: number;
	open: number;
	halfOpen: number;
}

export function modelStats(model: RouteTopologyModel): ModelStats {
	const stats: ModelStats = { total: 0, available: 0, disabled: 0, open: 0, halfOpen: 0 };
	for (const p of model.providers) {
		stats.total++;
		if (!p.enabled) {
			stats.disabled++;
			continue;
		}
		stats.available++;
		if (p.circuitState === 'open') stats.open++;
		else if (p.circuitState === 'half-open') stats.halfOpen++;
	}
	return stats;
}

// ---- Tree expansion state (stable Set-based, immutable updates) ----

export type TreeState = {
	models: Set<string>;
	groups: Set<string>; // key: `route:${modelId}`
	providers: Set<string>; // key: `${modelId}::${providerId}`
};

export function emptyTreeState(): TreeState {
	return { models: new Set(), groups: new Set(), providers: new Set() };
}

/** Toggle a single key, returning a NEW set (Svelte 5 reactivity-safe). */
export function toggleSetKey(set: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(set);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/** Expand every model, route group and provider in the current data. */
export function expandAll(models: RouteTopologyModel[]): TreeState {
	const state = emptyTreeState();
	for (const m of models) {
		state.models.add(m.id);
		state.groups.add(`route:${m.id}`);
		for (const p of m.providers) {
			state.providers.add(`${m.id}::${p.id}`);
		}
	}
	return state;
}

/** Collapse the whole tree. */
export function collapseAll(): TreeState {
	return emptyTreeState();
}

// ---- Search & filters ----

export type StatusFilter = 'all' | 'healthy' | 'half-open' | 'open' | 'disabled';
export type ModeFilter = 'all' | RoutingMode;

export interface FilterOptions {
	query: string;
	status: StatusFilter;
	mode: ModeFilter;
}

function matchesStatus(p: RouteTopologyProvider, status: StatusFilter): boolean {
	if (status === 'all') return true;
	return providerHealth(p) === status;
}

/** Model-level search: match model id, or any provider name/id. */
export function matchesSearch(model: RouteTopologyModel, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	if (model.id.toLowerCase().includes(q)) return true;
	return model.providers.some(
		(p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
	);
}

/**
 * Apply search + filters to a full topology model list.
 * Status filter narrows the providers INSIDE a model, then drops models that
 * ended up with no providers. Mode filter drops models by routing mode.
 * Always returns a NEW array (never mutates input).
 */
export function filterModels(
	models: RouteTopologyModel[],
	opts: FilterOptions,
): RouteTopologyModel[] {
	const q = opts.query.trim().toLowerCase();
	const out: RouteTopologyModel[] = [];
	for (const m of models) {
		if (opts.mode !== 'all' && m.routingMode !== opts.mode) continue;
		if (q && !matchesSearch(m, q)) continue;
		if (opts.status === 'all') {
			out.push(m);
			continue;
		}
		const filtered = m.providers.filter((p) => matchesStatus(p, opts.status));
		if (filtered.length === 0) continue;
		out.push({ ...m, providers: filtered });
	}
	return out;
}