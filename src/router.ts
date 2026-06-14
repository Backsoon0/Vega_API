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
const MODELS_CACHE_TTL = 300_000;

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

			// Collect configured models and build list of live-fetch promises
			const livePromises: Promise<void>[] = [];
			// Sort by weight desc — higher weight providers' models take priority
			const sorted = [...providers].sort((a, b) => (b.weight || 1) - (a.weight || 1));

			for (const p of sorted) {
				if (!p.enabled) continue;

				// Static configured models
				for (const m of p.models || []) {
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
									if (!seen.has(m.id)) {
										seen.add(m.id);
										models.push({ ...m, _providerId: p.id });
									}
								}
							})
							.catch(() => {
								/* skip unreachable provider */
							}),
					);
				}
			}

			// Parallel fetch — wait all live model list requests concurrently
			await Promise.allSettled(livePromises);

			cachedModels = models;
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

	// 1. Look up from cached model list — collect ALL providers that have this model
	const models = await getAggregatedModels(env);
	const foundModels = models.filter((m) => m.id === modelId);
	for (const fm of foundModels) {
		if (fm._providerId) {
			const provider = enabled.find((p) => p.id === fm._providerId);
			if (provider) addMatch(provider, modelId);
		}
	}

	// 2. Configured model exact match
	for (const p of enabled) {
		if ((p.models || []).some((m) => m === modelId)) {
			addMatch(p, modelId);
		}
	}

	// 3. Configured model prefix match
	for (const p of enabled) {
		if (
			(p.models || []).some(
				(m) => modelId.startsWith(m + '/') || modelId.startsWith(m),
			)
		) {
			addMatch(p, modelId);
		}
	}

	// 4. Fallback: no provider explicitly handles this model — try ALL enabled providers.
	// No hardcoded provider-type restrictions. The chat handler tries each candidate
	// in weight order and falls back on failure, so the highest-weight provider wins.
	if (!matches.length) {
		for (const p of enabled) {
			addMatch(p, modelId);
		}
	}

	return matches;
}

// ---- Cache invalidation (for testing) ----
export function invalidateCaches(): void {
	cachedProviders = null;
	cachedProvidersAt = 0;
	cachedProvidersVersion = -1;
	providersPromise = null;
	cachedModels = null;
	cachedModelsAt = 0;
	cachedModelsVersion = -1;
	modelsPromise = null;
}
