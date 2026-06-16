// src/routes/v1beta/models.ts
// Google Gemini-native model listing routes (Generative Language API format)
// GET /v1beta/models — list all models
// GET /v1beta/models/:modelId — single model details

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { getAggregatedModels } from '../../router';

export const v1betaModelRoutes = new Hono<{ Bindings: Env }>();

/**
 * Default token limits to include with each model.
 * We don't know the exact limits for proxied models, so we provide
 * generous defaults that won't restrict client behavior.
 */
const DEFAULT_INPUT_LIMIT = 1048576;
const DEFAULT_OUTPUT_LIMIT = 8192;

/**
 * Build a Google-style model entry from an internal Model record.
 */
function toGeminiModel(m: { id: string }) {
	return {
		name: `models/${m.id}`,
		displayName: m.id,
		description: `${m.id} (via Vega API)`,
		inputTokenLimit: DEFAULT_INPUT_LIMIT,
		outputTokenLimit: DEFAULT_OUTPUT_LIMIT,
		temperature: { minTemperature: 0.0, maxTemperature: 2.0, defaultTemperature: 1.0 },
		topP: { defaultTopP: 0.95, maxTopP: 1.0 },
		topK: { defaultTopK: 40 },
		supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
	};
}

// GET /v1beta/models — List models in Google Generative Language API format
v1betaModelRoutes.get('/models', async (c: Context<{ Bindings: Env }>) => {
	const models = await getAggregatedModels(c.env);
	const geminiModels = models.map(toGeminiModel);
	return c.json({ models: geminiModels });
});

// GET /v1beta/models/:modelId — Single model details
v1betaModelRoutes.get('/models/:modelId', async (c: Context<{ Bindings: Env }>) => {
	const rawParam = c.req.param('modelId');
	if (!rawParam) {
		return c.json({ error: { message: 'Model ID is required', code: 400 } }, 400);
	}
	const modelId = decodeURIComponent(rawParam).replace(/^models\//, '');
	const models = await getAggregatedModels(c.env);
	const found = models.find((m) => m.id === modelId);
	if (!found) {
		return c.json({ error: { message: `Model not found: ${modelId}`, code: 404 } }, 404);
	}
	return c.json(toGeminiModel(found));
});
