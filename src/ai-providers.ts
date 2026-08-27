// src/ai-providers.ts
// AI SDK Provider factory — creates LanguageModel from Vega Provider config
// Supports Google AI Studio, Vertex AI (JWT + API Key), and Anthropic.
// OpenAI-compatible providers are now handled by direct fetch (src/routes/v1/chat.ts).

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { Env, Provider } from './types';

// ---- Vertex AI JWT helpers (from providers/vertex.ts) ----
// Re-exported for use in ai-providers.ts

const ACCESS_TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_CACHE_SKEW_SECONDS = 60;

const tokenCache = new Map<string, { token: string; exp: number }>();
const tokenPromises = new Map<string, Promise<string>>();

// Cache of the verified working base URL for each Vertex model, keyed by
// `${projectId}:${modelId}`. Avoids re-running the 404 fallback on every request
// (the model is typically at one location, so after the first request we hit it
// directly and skip the extra failing HTTP round-trip).
const vertexBaseCache = new Map<string, string>();

function normalizePem(pem: string): string {
	return (pem || '').replace(/\\n/g, '\n').trim();
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
	let clean = normalizePem(pem)
		.replace('-----BEGIN PRIVATE KEY-----', '')
		.replace('-----END PRIVATE KEY-----', '')
		.replace(/\s+/g, '');
	clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
	if (!clean) throw new Error('Vertex AI: Invalid private key — PEM is empty after cleaning');
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeString(str: string): string {
	return base64UrlEncode(new TextEncoder().encode(str));
}

async function getSigningKey(privateKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		pemToArrayBuffer(privateKey),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
}

export async function getVertexAccessToken(config: Record<string, string>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const { serviceAccountEmail, privateKey } = config;
	if (!serviceAccountEmail) throw new Error('Vertex AI: Missing serviceAccountEmail');
	if (!privateKey) throw new Error('Vertex AI: Missing privateKey');

	// Cache key includes a fingerprint of the private key so a rotated key
	// (same service account email) does not reuse the old token until expiry.
	const cacheKey = `${serviceAccountEmail}:${normalizePem(privateKey).slice(-64)}`;

	// Periodic eviction of expired entries
	if (Math.random() < 0.05) {
		for (const [key, entry] of tokenCache) {
			if (now >= entry.exp) tokenCache.delete(key);
		}
	}

	const cached = tokenCache.get(cacheKey);
	if (cached && now < cached.exp - TOKEN_CACHE_SKEW_SECONDS) return cached.token;

	const pending = tokenPromises.get(cacheKey);
	if (pending) return pending;

	const promise = (async (): Promise<string> => {
		const key = await getSigningKey(privateKey);
		const header = { alg: 'RS256', typ: 'JWT' };
		const payload = {
			iss: serviceAccountEmail,
			scope: ACCESS_TOKEN_SCOPE,
			aud: 'https://oauth2.googleapis.com/token',
			iat: now,
			exp: now + 3600,
		};
		const unsignedJwt =
			`${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(payload))}`;
		const signature = await crypto.subtle.sign(
			'RSASSA-PKCS1-v1_5',
			key,
			new TextEncoder().encode(unsignedJwt),
		);
		const jwt = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;
		const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: jwt,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const data = (await tokenResp.json()) as Record<string, unknown>;
		if (!tokenResp.ok)
			throw new Error(`Vertex AI token exchange failed (${tokenResp.status}): ${JSON.stringify(data)}`);
		tokenCache.set(cacheKey, {
			token: data.access_token as string,
			exp: now + ((data.expires_in as number) || 3600),
		});
		return data.access_token as string;
	})().finally(() => {
		tokenPromises.delete(cacheKey);
	});

	tokenPromises.set(cacheKey, promise);
	return promise;
}

// ---- Provider type helpers ----

export function isVertexApiKeyMode(config: Record<string, string>): boolean {
	return !!(config.apiKey);
}

export function isVertexJwtMode(config: Record<string, string>): boolean {
	return !!(config.serviceAccountEmail && config.privateKey);
}

// ---- AI SDK Model Factory ----

/**
 * Create an AI SDK LanguageModel from a Vega Provider config.
 * Uses the appropriate @ai-sdk/* provider for each backend.
 *
 * @param provider - Vega Provider record from D1
 * @param env - Worker env bindings
 * @param modelId - The specific model ID to use (e.g. "gpt-4o", "gemini-2.5-flash")
 * @returns LanguageModelV3 instance for use with streamText/generateText
 */
export function createModelFromProvider(
	provider: Provider,
	env: Env,
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
