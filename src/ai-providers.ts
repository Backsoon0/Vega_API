// src/ai-providers.ts
// AI SDK Provider factory — creates LanguageModel from Vega Provider config
// Supports OpenAI, Google AI Studio, Vertex AI (JWT + API Key), and Anthropic

import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { Env, Provider } from './types';

// ---- Vertex AI JWT helpers (from providers/vertex.ts) ----
// Re-exported for use in ai-providers.ts

const ACCESS_TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_CACHE_SKEW_SECONDS = 60;

const tokenCache = new Map<string, { token: string; exp: number }>();
const tokenPromises = new Map<string, Promise<string>>();

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

	const cacheKey = serviceAccountEmail;

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
 * Create a fetch wrapper that fixes `developer` role back to `system` in the
 * request body before sending to the upstream API.
 *
 * @ai-sdk/openai v2 auto-converts system → developer for any model not matching
 * gpt-3.x/gpt-4.x/chatgpt-4o.x/gpt-5-chat.x. Non-OpenAI APIs (deepseek etc.)
 * reject the `developer` role, so we reverse the conversion in-flight.
 */
function patchedFetch(originalFetch: typeof fetch): typeof fetch {
	return async (url, init) => {
		if (init?.body) {
			try {
				const bodyStr = typeof init.body === 'string'
					? init.body
					: new TextDecoder().decode(init.body as ArrayBuffer);
				const body = JSON.parse(bodyStr);
				if (body.messages && Array.isArray(body.messages)) {
					let changed = false;
					for (const msg of body.messages) {
						if (msg.role === 'developer') {
							msg.role = 'system';
							changed = true;
						}
					}
					if (changed) {
						init = {
							...init,
							body: JSON.stringify(body),
							headers: new Headers(init.headers),
						};
					}
				}
			} catch {
				/* ignore parse errors — pass body through unchanged */
			}
		}
		return originalFetch(url, init);
	};
}

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
		case 'openai': {
			const openai = createOpenAI({
				apiKey: provider.config.apiKey,
				baseURL: provider.config.baseUrl || undefined,
				// Fix system→developer role conversion for non-OpenAI APIs
				fetch: patchedFetch(fetch),
			});
			return openai.chat(modelId);
		}

		case 'google_ai_studio': {
			const google = createGoogleGenerativeAI({
				apiKey: provider.config.apiKey,
			});
			return google(modelId);
		}

		case 'vertex_ai': {
			const { projectId, location } = provider.config;
			const loc = location || 'us-central1';
			const baseURL = `https://${loc}-aiplatform.googleapis.com/v1beta`;

			if (isVertexApiKeyMode(provider.config)) {
				const google = createGoogleGenerativeAI({
					apiKey: provider.config.apiKey,
					baseURL,
				});
				return google(modelId);
			}
			// JWT mode: use custom fetch to inject Bearer token
			const google = createGoogleGenerativeAI({
				apiKey: '', // prevent x-goog-api-key header
				baseURL,
				fetch: async (url, init) => {
					const token = await getVertexAccessToken(provider.config);
					const headers = new Headers(init?.headers);
					headers.set('Authorization', `Bearer ${token}`);
					headers.set('x-goog-user-project', projectId);
					// Remove empty x-goog-api-key that the provider may inject
					headers.delete('x-goog-api-key');
					return fetch(url, { ...init, headers });
				},
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
