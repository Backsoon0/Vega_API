// src/providers/openai.ts
// OpenAI official API backend proxy
// Auth: Bearer token (API key)
// Default upstream: https://api.openai.com/v1

import type { Env, Provider, Model } from '../types';

const DEFAULT_UPSTREAM = 'https://api.openai.com/v1';

function buildUpstreamUrl(config: Record<string, string>): string {
  return config.baseUrl || DEFAULT_UPSTREAM;
}

/**
 * Build and proxy a request to OpenAI.
 */
export async function proxyRequest(
  request: Request, env: Env, provider: Provider, suffix: string
): Promise<Response> {
  const apiKey = provider.config.apiKey;
  if (!apiKey) throw new Error('OpenAI: Missing apiKey');

  const upstreamBase = buildUpstreamUrl(provider.config);
  const upstreamUrl = new URL(upstreamBase);
  upstreamUrl.pathname += suffix;

  const reqUrl = new URL(request.url);
  upstreamUrl.search = reqUrl.search;

  const headers = new Headers(request.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(new Request(upstreamUrl.toString(), {
    method: request.method, headers, body: request.body,
  }));
}

/**
 * Fetch available models from OpenAI.
 */
export async function fetchModelList(
  env: Env, config: Record<string, string>
): Promise<Model[]> {
  const apiKey = config.apiKey;
  if (!apiKey) return [];

  const baseUrl = buildUpstreamUrl(config);

  try {
    const resp = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) return [];

    const data = await resp.json() as Record<string, unknown>;
    const items = Array.isArray(data.data)
      ? data.data as Array<{ id: string; created?: number; owned_by?: string }>
      : [];

    return items.map((m) => ({
      id: m.id,
      object: 'model' as const,
      created: m.created || 0,
      owned_by: m.owned_by || 'openai',
    }));
  } catch { return []; }
}
