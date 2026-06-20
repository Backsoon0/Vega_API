// src/router.ts
// Model routing: cache management, provider lookup, model aggregation

import type { Env, Provider, Model, ProviderHandler } from './types';
import { listProviders } from './config';
import { getConfigVersion } from './config';
import * as VertexProvider from './providers/vertex';
import * as AiStudioProvider from './providers/ai-studio';
import * as OpenAIProvider from './providers/openai';

export const PROVIDER_HANDLERS: Record<string, ProviderHandler> = {
	vertex_ai: VertexProvider,
	google_ai_studio: AiStudioProvider,
	openai: OpenAIProvider,
};

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

				// Live model list — fire and forget-style with per-provider isolation
				const handler = PROVIDER_HANDLERS[p.type];
				if (handler?.fetchModelList) {
					livePromises.push(
						handler
							.fetchModelList(env, p.config)
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
