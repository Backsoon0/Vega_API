// src/router.ts
// Model routing: cache management, provider lookup, model aggregation

import type { Env, Provider, Model, ProviderHandler } from './types';
import { listProviders, getFailoverEnabled } from './config';
import { getConfigVersion } from './config';
import { getCircuitState } from './circuit-breaker';
import * as VertexProvider from './providers/vertex';
import * as AiStudioProvider from './providers/ai-studio';
import * as OpenAIProvider from './providers/openai';

export const PROVIDER_HANDLERS: Record<string, ProviderHandler> = {
	vertex_ai: VertexProvider,
	google_ai_studio: AiStudioProvider,
	openai: OpenAIProvider,
};

/**
 * Bound a promise with a wall-clock timeout. Used so a slow or unreachable
 * provider model-list API can't hang /v1/models (or the models cache) for the
 * full platform timeout. The underlying fetch is left to settle on its own and
 * its result is discarded — providers already swallow their own errors.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

// ---- Cache state ----
let cachedProviders: Provider[] | null = null;
let cachedProvidersAt = 0;
let cachedProvidersVersion = -1;
const PROVIDERS_CACHE_TTL = 60_000;

let cachedModels: Model[] | null = null;
let cachedModelsAt = 0;
let cachedModelsVersion = -1;
const MODELS_CACHE_TTL = 900_000;

// Model → provider ID list (for model-aware routing)
let cachedModelProviders: Map<string, string[]> | null = null;

// Promise dedup — prevents cache stampede on concurrent cold-start requests
let providersPromise: Promise<Provider[]> | null = null;
let modelsPromise: Promise<Model[]> | null = null;

// ---- Provider loading ----
export async function loadProviders(env: Env): Promise<Provider[]> {
	const now = Date.now();
	const version = await getConfigVersion(env);
	if (
		cachedProviders &&
		cachedProvidersVersion === version &&
		now - cachedProvidersAt < PROVIDERS_CACHE_TTL
	) {
		return cachedProviders;
	}

	// Dedup: reuse in-flight promise
	if (!providersPromise) {
		providersPromise = (async () => {
			const providers = await listProviders(env);
			cachedProviders = providers;
			cachedProvidersAt = Date.now();
			cachedProvidersVersion = version;
			return providers;
		})().finally(() => {
			providersPromise = null;
		});
	}
	return providersPromise;
}

// ---- Model aggregation ----
export function mapOwner(type: string): string {
	const map: Record<string, string> = {
		vertex_ai: 'google',
		google_ai_studio: 'google',
		openai: 'openai',
		anthropic: 'anthropic',
	};
	return map[type] || type;
}

export async function getAggregatedModels(env: Env): Promise<Model[]> {
	const now = Date.now();
	const version = await getConfigVersion(env);
	if (
		cachedModels &&
		cachedModelsVersion === version &&
		now - cachedModelsAt < MODELS_CACHE_TTL
	) {
		return cachedModels;
	}

	// Dedup: reuse in-flight promise
	if (!modelsPromise) {
		modelsPromise = (async () => {
			const providers = await loadProviders(env);
			const seen = new Set<string>();
			const models: Model[] = [];
			const providedBy = new Map<string, string[]>();

			// Collect configured models and build list of live-fetch promises
			const livePromises: Promise<void>[] = [];
			// Sort by weight desc — higher weight providers' models take priority
			const sorted = [...providers].sort((a, b) => (b.weight || 1) - (a.weight || 1));

			function trackProvider(modelId: string, providerId: string) {
				const ids = providedBy.get(modelId) || [];
				if (!ids.includes(providerId)) {
					ids.push(providerId);
					providedBy.set(modelId, ids);
				}
			}

			for (const p of sorted) {
				if (!p.enabled) continue;

				// Static configured models
				for (const m of p.models || []) {
					trackProvider(m, p.id);
					if (!seen.has(m)) {
						seen.add(m);
						models.push({
							id: m,
							object: 'model',
							created: 0,
							owned_by: mapOwner(p.type),
							_providerId: p.id,
						});
					}
				}

				// Live model list — fire and forget-style with per-provider isolation.
				// Wrapped in a 10s timeout so one unreachable provider API can't
				// stall /v1/models for everyone else.
				const handler = PROVIDER_HANDLERS[p.type];
				if (handler?.fetchModelList) {
					livePromises.push(
						withTimeout(
							handler.fetchModelList(env, p.config),
							10_000,
							`Model fetch for provider ${p.id} (${p.type})`,
						)
							.then((live) => {
								for (const m of live) {
									trackProvider(m.id, p.id);
									if (!seen.has(m.id)) {
										seen.add(m.id);
										models.push({ ...m, _providerId: p.id });
									}
								}
							})
							.catch((err) => {
								console.error(`Model fetch failed for provider ${p.id} (${p.type}):`, (err as Error).message);
							}),
					);
				}
			}

			// Parallel fetch — wait all live model list requests concurrently
			await Promise.allSettled(livePromises);

			cachedModels = models;
			cachedModelProviders = providedBy;
			cachedModelsAt = Date.now();
			cachedModelsVersion = version;
			return models;
		})().finally(() => {
			modelsPromise = null;
		});
	}
	return modelsPromise;
}

// ---- Model-to-provider routing (returns ALL candidates sorted by weight desc) ----
export interface ProviderMatch {
	provider: Provider;
	matchedModel: string;
}

/** Returns the model→provider IDs map, lazily populated by getAggregatedModels(). */
export async function getModelProviders(env: Env): Promise<Map<string, string[]>> {
	// Warm the model cache if not already populated
	await getAggregatedModels(env);
	return cachedModelProviders || new Map();
}

export async function findProviderForModel(
	env: Env,
	modelId: string,
): Promise<ProviderMatch[]> {
	const providers = await loadProviders(env);
	const enabled = providers
		.filter((p) => p.enabled)
		.sort((a, b) => (b.weight || 1) - (a.weight || 1));
	if (!enabled.length) return [];

	const matches: ProviderMatch[] = [];
	const seen = new Set<string>();

	function addMatch(provider: Provider, model: string) {
		if (!seen.has(provider.id)) {
			seen.add(provider.id);
			matches.push({ provider, matchedModel: model });
		}
	}

	// 1. Use model→provider map to find providers that actually list this model
	const modelProviders = await getModelProviders(env);
	const supportedIds = modelProviders.get(modelId) || [];
	for (const pid of supportedIds) {
		const provider = enabled.find((p) => p.id === pid);
		if (provider) addMatch(provider, modelId);
	}

	// 2. Configured model exact match
	for (const p of enabled) {
		if ((p.models || []).some((m) => m === modelId)) {
			addMatch(p, modelId);
		}
	}

	// 3. Configured model prefix match (only with '/' delimiter to avoid over-matching)
	//    e.g. "openai/gpt-4" matches "openai/gpt-4-0613" but "gpt-4" does NOT match "gpt-4o"
	for (const p of enabled) {
		if (
			(p.models || []).some(
				(m) => modelId.startsWith(m + '/'),
			)
		) {
			addMatch(p, modelId);
		}
	}

	// 4. Fallback: no provider explicitly lists this model — try ALL enabled providers.
	if (!matches.length) {
		for (const p of enabled) {
			addMatch(p, modelId);
		}
	}

	return matches.sort((a, b) => (b.provider.weight || 1) - (a.provider.weight || 1));
}

// ---- Cache invalidation (for testing) ----
export function invalidateCaches(): void {
	cachedProviders = null;
	cachedProvidersAt = 0;
	cachedProvidersVersion = -1;
	providersPromise = null;
	cachedModels = null;
	cachedModelProviders = null;
	cachedModelsAt = 0;
	cachedModelsVersion = -1;
	modelsPromise = null;
}

// ---- Route topology (admin visualization DTO) ----
//
// Built exclusively from the SAME primitives the real request path uses
// (loadProviders / getAggregatedModels / getModelProviders), so what the
// admin panel sees is exactly what /v1/*, /v1beta/* and /anthropic/* requests
// see. This function NEVER reads the runtime routing algorithm — it replicates
// findProviderForModel()'s candidate selection (map → exact → prefix → fallback)
// and tags each provider with the stage that matched it.

export type RouteMatchedBy = 'live' | 'configured' | 'prefix' | 'fallback';
export type RoutingMode = 'priority' | 'failover' | 'weighted';

export interface RouteTopologyProvider {
	id: string;
	name: string;
	type: string;
	enabled: boolean;
	weight: number;
	/** Which routing stage matched this provider to the model. */
	matchedBy: RouteMatchedBy;
	/** The model id that was matched (always the requested/displayed model). */
	matchedModel: string;
	/** For prefix matches: the configured prefix pattern that matched. */
	matchedPattern?: string;
	/** Whether the model is explicitly listed in the provider's models array. */
	modelConfigured: boolean;
	/** Circuit breaker snapshot: closed | open | half-open. */
	circuitState: 'closed' | 'open' | 'half-open';
}

export interface RouteTopologyModel {
	id: string;
	/**
	 * Accurate representation of the CURRENT request behaviour:
	 *  - "priority": only the first (highest-weight) candidate is attempted
	 *    (failover disabled, or a single candidate).
	 *  - "failover": candidates are tried in weight order, next on failure.
	 *  - "weighted": reserved for a future true weighted load balancer — the
	 *    current backend never emits it. Weights alone do NOT mean weighted LB.
	 */
	routingMode: RoutingMode;
	failoverEnabled: boolean;
	/** Enabled candidates in request (weight desc) order, then disabled extras. */
	providers: RouteTopologyProvider[];
}

export interface RouteTopologyData {
	models: RouteTopologyModel[];
	failoverEnabled: boolean;
}

/**
 * Build the route-topology row for a single model id.
 *
 * Pure function over raw inputs (no D1/cache access) so the exact matching
 * stages can be unit-tested, including the fallback stage that only fires for
 * models no provider explicitly lists. `getRouteTopology()` feeds it the real
 * cached provider/data sources, so the admin view equals the request path.
 */
export function buildModelTopology(
	modelId: string,
	enabledProviders: Provider[],
	disabledProviders: Provider[],
	modelProviderIds: string[],
	failoverEnabled: boolean,
): RouteTopologyModel {
	// Work on weight-desc copies so the function is order-independent.
	const enabled = [...enabledProviders].sort((a, b) => (b.weight || 1) - (a.weight || 1));
	const disabled = [...disabledProviders].sort((a, b) => (b.weight || 1) - (a.weight || 1));

	// Stage order mirrors findProviderForModel(): aggregated map → configured
	// exact → configured prefix → fallback to all enabled providers.
	const enabledMatches: RouteTopologyProvider[] = [];
	const seen = new Set<string>();
	const add = (p: Provider, matchedBy: RouteMatchedBy, matchedPattern?: string) => {
		if (seen.has(p.id)) return;
		seen.add(p.id);
		enabledMatches.push({
			id: p.id,
			name: p.name,
			type: p.type,
			enabled: true,
			weight: p.weight || 1,
			matchedBy,
			matchedModel: modelId,
			matchedPattern,
			modelConfigured: (p.models || []).includes(modelId),
			circuitState: getCircuitState(p.id),
		});
	};

	// A provider is tagged with the FIRST stage that matched it:
	// configured exact > configured prefix > aggregated (live) map.
	const hasExplicitMatch = enabled.some(
		(p) =>
			(p.models || []).includes(modelId) ||
			(p.models || []).some((m) => modelId.startsWith(m + '/')) ||
			modelProviderIds.includes(p.id),
	);

	if (hasExplicitMatch) {
		for (const p of enabled) {
			if ((p.models || []).includes(modelId)) add(p, 'configured');
		}
		for (const p of enabled) {
			const pattern = (p.models || []).find((m) => modelId.startsWith(m + '/'));
			if (pattern) add(p, 'prefix', pattern);
		}
		for (const pid of modelProviderIds) {
			const p = enabled.find((x) => x.id === pid);
			if (p) add(p, 'live');
		}
	} else {
		// Fallback: no provider explicitly lists this model — every enabled
		// provider is a candidate, exactly like findProviderForModel().
		for (const p of enabled) add(p, 'fallback');
	}

	// Disabled providers never serve requests, but when they explicitly match
	// the model (configured/prefix/live) the admin should see them marked as
	// Disabled instead of them silently vanishing from the tree.
	const disabledMatches: RouteTopologyProvider[] = [];
	const seenDisabled = new Set<string>();
	const addDisabled = (p: Provider, matchedBy: RouteMatchedBy, matchedPattern?: string) => {
		if (seenDisabled.has(p.id)) return;
		seenDisabled.add(p.id);
		disabledMatches.push({
			id: p.id,
			name: p.name,
			type: p.type,
			enabled: false,
			weight: p.weight || 1,
			matchedBy,
			matchedModel: modelId,
			matchedPattern,
			modelConfigured: (p.models || []).includes(modelId),
			circuitState: 'closed',
		});
	};
	for (const p of disabled) {
		const pattern = (p.models || []).find((m) => modelId.startsWith(m + '/'));
		if ((p.models || []).includes(modelId)) addDisabled(p, 'configured');
		else if (pattern) addDisabled(p, 'prefix', pattern);
		else if (modelProviderIds.includes(p.id)) addDisabled(p, 'live');
	}

	let routingMode: RoutingMode = 'priority';
	if (enabledMatches.length > 1 && failoverEnabled) routingMode = 'failover';

	return {
		id: modelId,
		routingMode,
		failoverEnabled,
		providers: [...enabledMatches, ...disabledMatches],
	};
}

/**
 * Build the full model → provider routing topology for the admin panel.
 * Covers EVERY model the platform can currently serve (aggregated model list).
 */
export async function getRouteTopology(env: Env): Promise<RouteTopologyData> {
	const providers = await loadProviders(env);
	const enabled = providers
		.filter((p) => p.enabled)
		.sort((a, b) => (b.weight || 1) - (a.weight || 1));
	const disabled = providers
		.filter((p) => !p.enabled)
		.sort((a, b) => (b.weight || 1) - (a.weight || 1));
	const aggregated = await getAggregatedModels(env);
	const modelProviders = await getModelProviders(env);
	const failoverEnabled = await getFailoverEnabled(env);

	const models: RouteTopologyModel[] = [];
	for (const model of aggregated) {
		models.push(
			buildModelTopology(
				model.id,
				enabled,
				disabled,
				modelProviders.get(model.id) || [],
				failoverEnabled,
			),
		);
	}

	// Stable display order — aggregated order follows provider iteration.
	models.sort((a, b) => a.id.localeCompare(b.id));

	return { models, failoverEnabled };
}
