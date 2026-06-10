// src/providers/ai-studio.js
// Google AI Studio (Gemini API) backend proxy
// Uses OpenAI-compatible endpoint at generativelanguage.googleapis.com
// Auth: Bearer token (API key)

const UPSTREAM_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Build the upstream URL for Google AI Studio.
 */
export function buildUpstreamUrl() {
	return UPSTREAM_BASE;
}

/**
 * Build and proxy a request to Google AI Studio (pass-through, no format conversion).
 */
export async function proxyRequest(request, env, provider, suffix) {
	const apiKey = provider.config.apiKey;
	if (!apiKey) throw new Error("AI Studio: Missing apiKey");

	const upstreamUrl = new URL(UPSTREAM_BASE);
	upstreamUrl.pathname += suffix;

	// Copy original URL search params
	const reqUrl = new URL(request.url);
	upstreamUrl.search = reqUrl.search;

	const headers = new Headers(request.headers);
	// Remove incoming Authorization — it's the client key, not the provider key
	headers.delete("Authorization");
	headers.set("Authorization", `Bearer ${apiKey}`);
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}

	// For /chat/completions, strip google/ and models/ prefixes from model name
	// The AI Studio OpenAI-compatible endpoint expects bare model IDs
	let body = request.body;
	if (suffix === "/chat/completions" && body) {
		try {
			const cloned = request.clone();
			const json = await cloned.json();
			if (json.model) {
				json.model = String(json.model).replace(/^(google\/|models\/)+/, "");
				body = JSON.stringify(json);
				headers.delete("content-length");
			}
		} catch {
			// If parsing fails, use original body
		}
	}

	const upstreamReq = new Request(upstreamUrl.toString(), {
		method: request.method,
		headers,
		body,
	});

	return fetch(upstreamReq);
}

/**
 * Fetch available models from Google AI Studio OpenAI-compatible endpoint.
 */
export async function fetchModelList(env, config) {
	const apiKey = config.apiKey;
	if (!apiKey) return [];

	try {
		const resp = await fetch(`${UPSTREAM_BASE}/models`, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (!resp.ok) return [];

		const data = await resp.json().catch(() => ({}));
		const items = Array.isArray(data.data) ? data.data : [];

		return items.map((m) => {
			// Strip google/ and models/ prefixes, then add google/ back
			const bareId = String(m.id || "").replace(/^(google\/|models\/)+/, "");
			return {
				id: `google/${bareId}`,
				object: "model",
				created: m.created || 0,
				owned_by: m.owned_by || "google",
			};
		});
	} catch {
		return [];
	}
}
