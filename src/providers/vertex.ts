// src/providers/vertex.ts
// Google Vertex AI model-list fetch (legacy provider handler).
// Vertex request routing now lives in src/ai-providers.ts (AI SDK path) and
// src/routes/* (OpenAI-compat passthrough); this file only supplies the
// live model aggregation used by the models cache.

import type { Model } from '../types.js';
import { getVertexAccessToken, isVertexApiKeyMode } from '../google-auth.js';

// ---- Model list ----

export async function fetchModelList(
  config: Record<string, string>
): Promise<Model[]> {
  try {
    const url = new URL('https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('listAllVersions', 'false');
    url.searchParams.set('languageCode', 'en');

    let headers: Record<string, string>;
    if (isVertexApiKeyMode(config)) {
      headers = { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' };
    } else {
      const accessToken = await getVertexAccessToken(config);
      headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    }

    const models: Model[] = [];
    let pageToken = '';
    for (let i = 0; i < 3; i++) {
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetch(url, { headers });
      const data = await resp.json() as Record<string, unknown>;
      if (!resp.ok) break;
      const items = Array.isArray(data.publisherModels)
        ? data.publisherModels as Array<{ name: string }>
        : [];
      for (const item of items) {
        const last = String(item.name || '').split('/').pop();
        if (last) models.push({ id: last, object: 'model', created: 0, owned_by: 'google' });
      }
      pageToken = String(data.nextPageToken || '');
      if (!pageToken) break;
    }
    return models;
  } catch { return []; }
}
