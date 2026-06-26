// src/providers/ai-studio.ts
// Google AI Studio (Gemini API) backend proxy
// Uses OpenAI-compatible endpoint at generativelanguage.googleapis.com
// Auth: Bearer token (API key)

import type { Env, Provider, Model } from '../types';

const UPSTREAM_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Build and proxy a request to Google AI Studio (pass-through, no format conversion).
 */
export async function proxyRequest(
  request: Request, env: Env, provider: Provider, suffix: string
): Promise<Response> {
  const apiKey = provider.config.apiKey;
  if (!apiKey) throw new Error('AI Studio: Missing apiKey');

  const upstreamUrl = new URL(UPSTREAM_BASE);
  upstreamUrl.pathname += suffix;

  const reqUrl = new URL(request.url);
  upstreamUrl.search = reqUrl.search;

  const headers = new Headers(request.headers);
	// Remove incoming Authorization — it's the client key, not the provider key
	headers.delete('Authorization');
	headers.set('x-goog-api-key', apiKey);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // For /chat/completions, strip google/ and models/ prefixes from model name
  let body = request.body;
  if (suffix === '/chat/completions' && body) {
    try {
      const cloned = request.clone();
      const json = await cloned.json() as Record<string, unknown>;
      if (json.model) {
        json.model = String(json.model).replace(/^(google\/|models\/)+/, '');
        body = JSON.stringify(json);
        headers.delete('content-length');
      }
    } catch {
      // If parsing fails, use original body
    }
  }

  return fetch(new Request(upstreamUrl.toString(), {
    method: request.method, headers, body,
  }));
}

/**
 * Fetch available models from Google AI Studio.
 * Tries the OpenAI-compatible endpoint first, falls back to the native Gemini API.
 */
export async function fetchModelList(
	env: Env, config: Record<string, string>
): Promise<Model[]> {
	const apiKey = config.apiKey;
	if (!apiKey) {
		console.warn('[ai-studio] fetchModelList: no apiKey in config');
		return [];
	}

	// Strategy 1: OpenAI-compatible endpoint (confirmed by Google docs)
	const openaiUrl = `${UPSTREAM_BASE}/models`;
	let resp = await fetch(openaiUrl, {
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
	});

	if (resp.ok) {
		const data = await resp.json() as Record<string, unknown>;
		// Try both OpenAI format ({ data: [...] }) and Google format ({ models: [...] })
		const items = Array.isArray(data.data) ? data.data as Array<Record<string, unknown>>
			: Array.isArray(data.models) ? data.models as Array<Record<string, unknown>>
			: [];
		if (items.length > 0) {
			return items.map((m) => ({
				id: String(m.id || m.name || '').replace(/^(google\/|models\/)+/, ''),
				object: 'model' as const,
				created: (m.created as number) || 0,
				owned_by: (m.owned_by as string) || 'google',
			}));
		}
		// OpenAI endpoint responded OK but returned 0 models — fall through to native API
		console.warn(`[ai-studio] OpenAI endpoint returned 0 models (keys: ${Object.keys(data).join(', ')}), trying native API`);
	} else {
		const errText = await resp.text().catch(() => '');
		console.warn(`[ai-studio] OpenAI endpoint failed (${resp.status}): ${errText.slice(0, 200)}`);
	}

	// Strategy 2: Native Gemini API models endpoint
	const nativeUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
	resp = await fetch(nativeUrl, {
		headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
	});

	if (!resp.ok) {
		const errText = await resp.text().catch(() => '');
		console.error(`[ai-studio] Native endpoint failed (${resp.status}): ${errText.slice(0, 200)}`);
		return [];
	}

	const data = await resp.json() as Record<string, unknown>;
	const items = Array.isArray(data.models) ? data.models as Array<Record<string, unknown>> : [];
	if (items.length === 0) {
		console.warn(`[ai-studio] Native endpoint returned 0 models. Response keys: ${Object.keys(data).join(', ')}`);
		return [];
	}

	return items
		.filter((m) => {
			const methods = m.supportedGenerationMethods as string[] | undefined;
			// Keep models that support generateContent, or models without the field (backward compat)
			if (Array.isArray(methods) && !methods.includes('generateContent')) return false;
			return true;
		})
		.map((m) => ({
			id: String(m.name || m.id || '').replace(/^(google\/|models\/)+/, ''),
			object: 'model' as const,
			created: 0,
			owned_by: 'google',
		}));
}
