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

			for (const p of providers) {
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

// ---- Model-to-provider routing ----
export async function findProviderForModel(
	env: Env,
	modelId: string,
): Promise<{ provider: Provider; matchedModel: string } | null> {
	const providers = await loadProviders(env);
	const enabled = providers.filter((p) => p.enabled);
	if (!enabled.length) return null;

	// 1. Look up from cached model list (includes live-fetched models)
	const models = await getAggregatedModels(env);
	const found = models.find((m) => m.id === modelId);
	if (found?._providerId) {
		const provider = enabled.find((p) => p.id === found._providerId);
		if (provider) return { provider, matchedModel: modelId };
	}

	// 2. Configured model exact match
	for (const p of enabled) {
		if ((p.models || []).some((m) => m === modelId)) {
			return { provider: p, matchedModel: modelId };
		}
	}

	// 3. Configured model prefix match
	for (const p of enabled) {
		if (
			(p.models || []).some(
				(m) => modelId.startsWith(m + '/') || modelId.startsWith(m),
			)
		) {
			return { provider: p, matchedModel: modelId };
		}
	}

	// 4. Heuristic by model name prefix
	const prefix = modelId.split('/')[0].toLowerCase();
	if (['google', 'gemini', 'publishers'].includes(prefix)) {
		const candidates = enabled.filter(
			(p) => p.type === 'vertex_ai' || p.type === 'google_ai_studio',
		);
		if (candidates.length) return { provider: candidates[0], matchedModel: modelId };
	}
	if (
		['gpt', 'o1', 'o3', 'text-embedding', 'dall-e', 'tts', 'whisper'].some((p) =>
			modelId.toLowerCase().startsWith(p),
		)
	) {
		const candidates = enabled.filter((p) => p.type === 'openai');
		if (candidates.length) return { provider: candidates[0], matchedModel: modelId };
	}

	return enabled.length ? { provider: enabled[0], matchedModel: modelId } : null;
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
