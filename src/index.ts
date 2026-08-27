// src/index.ts
// Cloudflare Worker entry — Vega API
// Multi-interface AI API: OpenAI (/v1/*), Gemini (/v1beta/*), Anthropic (/anthropic/*)

import type { Env } from './types.js';
import { app, prepareRuntime } from './app.js';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// One-time per-isolate init: schema + circuit-breaker config.
		await prepareRuntime(env);
		try {
			return await app.fetch(request, env, ctx);
		} catch (err) {
			console.error('Worker error:', (err as Error).message, (err as Error).stack);
			return new Response(
				JSON.stringify({
					error: { message: 'Internal server error: ' + (err as Error).message },
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}
	},
};
