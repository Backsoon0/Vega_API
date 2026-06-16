// src/index.ts
// Vega API — Hono on Cloudflare Workers
// Multi-interface AI API: OpenAI (/v1/*), Gemini (/v1beta/*), Anthropic (/anthropic/*)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { initSchema } from './db';

// Middleware
import { clientAuthMiddleware, adminAuthMiddleware } from './middleware/auth';

// Route modules
import { adminAuthRoutes } from './routes/admin/auth';
import { adminProviderRoutes } from './routes/admin/providers';
import { adminClientKeyRoutes } from './routes/admin/client-key';
import { adminUsageRoutes } from './routes/admin/usage';
import { v1ModelRoutes } from './routes/v1/models';
import { v1ChatRoutes } from './routes/v1/chat';
import { v1betaModelRoutes } from './routes/v1beta/models';
import { v1betaChatRoutes } from './routes/v1beta/chat';
import { anthropicMessagesRoutes } from './routes/anthropic/messages';

// Router utilities
import { loadProviders } from './router';

const app = new Hono<{ Bindings: Env }>();

// ---- Global CORS ----
app.use('*', cors({
	origin: (origin) => origin,
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Key'],
	exposeHeaders: ['Content-Type'],
}));

// ---- Health check ----
app.get('/health', async (c) => {
	const providers = await loadProviders(c.env).catch(() => []);
	const enabled = providers.filter((p) => p.enabled).length;
	return c.json({
		ok: true,
		message: 'Vega API is running',
		providers: enabled,
		routes: ['/', '/health', '/v1/chat/completions', '/v1/models', '/v1beta/models', '/v1beta/models/:model:generateContent', '/anthropic/v1/messages'],
	});
});

// ---- Admin routes ----
// Auth guard applied to all /admin/* routes (with skip list for public endpoints)
app.use('/admin/*', adminAuthMiddleware());

app.route('/admin', adminAuthRoutes);
app.route('/admin', adminProviderRoutes);
app.route('/admin', adminClientKeyRoutes);
app.route('/admin', adminUsageRoutes);

// ---- /v1/* Client API routes ----
app.use('/v1/*', clientAuthMiddleware());

app.route('/v1', v1ModelRoutes);
app.route('/v1', v1ChatRoutes);

// ---- /v1beta/* Gemini-native API routes ----
app.use('/v1beta/*', clientAuthMiddleware());

app.route('/v1beta', v1betaModelRoutes);
app.route('/v1beta', v1betaChatRoutes);

// ---- /anthropic/* Anthropic-native API routes ----
app.use('/anthropic/*', clientAuthMiddleware());

app.route('/anthropic', anthropicMessagesRoutes);

// Generic /v1/* fallback for unimplemented routes
app.all('/v1/*', async (c) => {
	return c.json(
		{ error: { message: `Route not implemented: ${c.req.path}`, type: 'invalid_request_error' } },
		404,
	);
});

// ---- SPA / static assets fallback ----
app.get('/*', async (c) => {
	if (c.env.ASSETS) {
		try {
			return c.env.ASSETS.fetch(c.req.raw);
		} catch {
			/* fall through */
		}
	}
	return c.json({ error: { message: 'Not Found' } }, 404);
});

// ---- Export ----
let schemaInitialized = false;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Init schema once per isolate (not every request)
		if (!schemaInitialized) {
			try {
				await initSchema(env);
				schemaInitialized = true;
			} catch (err) {
				console.error('Schema init error:', (err as Error).message);
			}
		}
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
