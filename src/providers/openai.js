// src/providers/openai.js
// OpenAI official API backend proxy
// Auth: Bearer token (API key)
// Default upstream: https://api.openai.com/v1

const DEFAULT_UPSTREAM = "https://api.openai.com/v1";

/**
 * Build the upstream URL for OpenAI.
 */
export function buildUpstreamUrl(config) {
  return config.baseUrl || DEFAULT_UPSTREAM;
}

/**
 * Build and proxy a request to OpenAI.
 */
export async function proxyRequest(request, env, provider, suffix) {
  const apiKey = provider.config.apiKey;
  if (!apiKey) throw new Error("OpenAI: Missing apiKey");

  const upstreamBase = buildUpstreamUrl(provider.config);
  const upstreamUrl = new URL(upstreamBase);
  upstreamUrl.pathname += suffix;

  // Copy original URL search params
  const reqUrl = new URL(request.url);
  upstreamUrl.search = reqUrl.search;

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const upstreamReq = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
  });

  return fetch(upstreamReq);
}

/**
 * Fetch available models from OpenAI.
 */
export async function fetchModelList(env, config) {
  const apiKey = config.apiKey;
  if (!apiKey) return [];

  const baseUrl = buildUpstreamUrl(config);

  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) return [];

    const data = await resp.json().catch(() => ({}));
    const items = Array.isArray(data.data) ? data.data : [];

    return items.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created || 0,
      owned_by: m.owned_by || "openai",
    }));
  } catch {
    return [];
  }
}
