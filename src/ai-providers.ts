// src/ai-providers.ts
// AI SDK Provider factory — creates LanguageModel from Vega Provider config
// Supports Google AI Studio, Vertex AI (JWT + API Key), and Anthropic.
// OpenAI-compatible providers are now handled by direct fetch (src/routes/v1/chat.ts).

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { Provider } from './types.js';
import { getVertexAccessToken, isVertexApiKeyMode } from './google-auth.js';

// Cache of the verified working base URL for each Vertex model, keyed by
// `${projectId}:${modelId}`. Avoids re-running the 404 fallback on every request
// (the model is typically at one location, so after the first request we hit it
// directly and skip the extra failing HTTP round-trip).
const vertexBaseCache = new Map<string, string>();

// ---- AI SDK Model Factory ----

/**
 * Create an AI SDK LanguageModel from a Vega Provider config.
 * Uses the appropriate @ai-sdk/* provider for each backend.
 *
 * @param provider - Vega Provider record from D1
 * @param modelId - The specific model ID to use (e.g. "gpt-4o", "gemini-2.5-flash")
 * @returns LanguageModelV3 instance for use with streamText/generateText
 */
export function createModelFromProvider(
	provider: Provider,
	modelId: string,
) {
	switch (provider.type) {
		case 'google_ai_studio': {
			const google = createGoogleGenerativeAI({
				apiKey: provider.config.apiKey,
			});
			return google(modelId);
		}

		case 'vertex_ai': {
			const { projectId, location } = provider.config;
			// Default location `global` (Gemini 3.x models live there). Keep a
			// `us-central1` fallback in the candidate list for regional models.
			const loc = location || 'global';
			// Native Vertex API uses a full publisher resource path — a bare
			// `.../v1beta/models/{model}` returns HTTP 404 "Not Found".
			//
			// Gemini 3.x models (e.g. gemini-3.7-flash) are served under
			// `locations/global`, and host/region semantics differ between the
			// OpenAI-compat passthrough (global host) and the native API (regional
			// host). So we try a sequence of candidate base URLs and fall through
			// on a 404: global/regional host × configured/global location.
			// `name` must start with `google.vertex.` so the provider is treated as
			// Vertex (drops functionCall ids, uses Vertex streaming, etc.).
			const vertexName = 'google.vertex.ai';

			const isJwt = !isVertexApiKeyMode(provider.config);
			const jwtConfig = isJwt ? provider.config : undefined;

			// NOTE: use API version `v1`, NOT `v1beta` (verified against a live project).
			const base = (host: string, l: string) =>
				`https://${host}/v1/projects/${projectId}/locations/${l}/publishers/google`;

			// Candidate base URLs. `{loc}-aiplatform.googleapis.com` is NOT a valid
			// host when `loc === 'global'`, so skip it there. If we already learned a
			// working base for this model, put it first so the 404 fallback isn't
			// re-run on every request (which was costing latency).
			const cacheKey = `${projectId}:${modelId}`;
			const cachedBase = vertexBaseCache.get(cacheKey);
			const candidatesRaw: string[] = [];
			if (loc !== 'global') {
				candidatesRaw.push(base('aiplatform.googleapis.com', loc));
				candidatesRaw.push(base(`${loc}-aiplatform.googleapis.com`, loc));
			}
			candidatesRaw.push(base('aiplatform.googleapis.com', 'global'));
			if (loc !== 'global' && loc !== 'us-central1') candidatesRaw.push(base('aiplatform.googleapis.com', 'us-central1'));
			if (cachedBase) candidatesRaw.unshift(cachedBase);
			const candidates = [...new Set(candidatesRaw)];
			const primaryBase = candidates[0];

			// Fetch wrapper: injects the JWT Bearer token (JWT mode) and, on any
			// non-2xx, retries the other candidate base URLs (guarding each attempt
			// so a network error on one host can't break the chain). On success it
			// caches the working base to skip the fallback next time.
			const vertexFetch = async (url: any, init?: any): Promise<Response> => {
				const run = async (u: any): Promise<Response> => {
					const headers = new Headers(init?.headers);
					if (jwtConfig) {
						const token = await getVertexAccessToken(jwtConfig);
						headers.set('Authorization', `Bearer ${token}`);
						headers.set('x-goog-user-project', projectId);
						// Remove empty x-goog-api-key that the provider may inject
						headers.delete('x-goog-api-key');
					}
					return fetch(u, { ...init, headers });
				};
				const ok = (r: Response) => r.status >= 200 && r.status < 300;
				const sameBase = typeof url === 'string' && url.startsWith(primaryBase);

				let resp: Response;
				try {
					resp = await run(url);
				} catch (err) {
					console.error(`[vega:vertex] fetch error on "${url}": ${(err as Error)?.message} (model "${modelId}")`);
					resp = new Response(JSON.stringify({ error: { message: 'Vertex fetch failed', type: 'server_error' } }), { status: 502 });
				}

				if (!sameBase) return resp;

				let workingBase = primaryBase;
				if (!ok(resp)) {
					for (const alt of candidates.slice(1)) {
						if (alt === primaryBase) continue;
						const altUrl = alt + url.slice(primaryBase.length);
						try {
							resp = await run(altUrl);
						} catch (err) {
							console.error(`[vega:vertex] fetch error on "${altUrl}": ${(err as Error)?.message}`);
							continue;
						}
						if (ok(resp)) { workingBase = alt; break; }
					}
				}
				if (ok(resp) && workingBase !== primaryBase) vertexBaseCache.set(cacheKey, workingBase);
				return resp;
			};

			const google = createGoogleGenerativeAI({
				apiKey: isJwt ? '' : provider.config.apiKey,
				baseURL: primaryBase,
				name: vertexName,
				fetch: vertexFetch,
			});
			return google(modelId);
			}

		case 'anthropic': {
			const anthropic = createAnthropic({
				apiKey: provider.config.apiKey,
			});
			return anthropic(modelId);
		}

		default:
			throw new Error(`Unknown provider type: ${(provider as Provider).type}`);
	}
}
