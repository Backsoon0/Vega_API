// src/routes/v1/models.ts
// OpenAI-compatible model listing routes

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { getAggregatedModels } from '../../router';

export const v1ModelRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/models — List all models across providers
v1ModelRoutes.get('/models', async (c: Context<{ Bindings: Env }>) => {
	const models = await getAggregatedModels(c.env);
	return c.json({ object: 'list', data: models });
});

// GET /v1/models/:modelId — Get single model by ID
v1ModelRoutes.get('/models/:modelId', async (c: Context<{ Bindings: Env }>) => {
	const rawParam = c.req.param('modelId');
	if (!rawParam) {
		return c.json(
			{ error: { message: 'Model ID is required', type: 'invalid_request_error' } },
			400,
		);
	}
	const modelId = decodeURIComponent(rawParam);
	const models = await getAggregatedModels(c.env);
	const found = models.find((m) => m.id === modelId);
	if (!found) {
		return c.json(
			{ error: { message: `Model not found: ${modelId}`, type: 'invalid_request_error' } },
			404,
		);
	}
	return c.json(found);
});
