// src/providers/openai.ts
// OpenAI (and OpenAI-compatible) model-list fetch — legacy provider handler.
// Chat requests bypass this file entirely (direct SSE passthrough in
// src/routes/v1/chat.ts). Default upstream: https://api.openai.com/v1

import type { Model } from '../types.js';

const DEFAULT_UPSTREAM = 'https://api.openai.com/v1';

function buildUpstreamUrl(config: Record<string, string>): string {
  return config.baseUrl || DEFAULT_UPSTREAM;
}

/**
 * Fetch available models from OpenAI.
 */
export async function fetchModelList(
  config: Record<string, string>
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
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`Model fetch failed: ${baseUrl}/models → ${resp.status}: ${errText.slice(0, 200)}`);
      return [];
    }

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
  } catch (err) { console.error(`OpenAI model fetch error at ${baseUrl}/models: ${(err as Error).message}`); return []; }
}
