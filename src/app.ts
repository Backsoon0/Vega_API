// src/app.ts
// Shared Hono application used by BOTH runtimes:
//   - Cloudflare Workers (`src/index.ts`  — default export { fetch })
//   - Vercel Serverless      (`api/index.ts` — web handler)
//
// The app is platform-agnostic: it reads `env.DB` (D1 on Workers, Neon on Vercel)
// through the D1-shaped client, and `env.ASSETS` (real binding on Workers, inert
// stub on Vercel — where Vercel serves the SPA statically).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types.js';
import { initSchema } from './db.js';
import { ensureConfigLoaded } from './circuit-breaker.js';
import { getRuntimeStatus } from './runtime.js';

// Middleware
import { clientAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';

// Route modules
import { adminAuthRoutes } from './routes/admin/auth.js';
import { adminProviderRoutes } from './routes/admin/providers.js';
import { adminApiKeyRoutes } from './routes/admin/client-key.js';
import { adminUsageRoutes } from './routes/admin/usage.js';
import { adminPlaygroundRoutes } from './routes/admin/playground.js';
import { adminRouteTopologyRoutes } from './routes/admin/routes.js';
import { v1ModelRoutes } from './routes/v1/models.js';
import { v1ChatRoutes } from './routes/v1/chat.js';
import { v1betaModelRoutes } from './routes/v1beta/models.js';
import { v1betaChatRoutes } from './routes/v1beta/chat.js';
import { anthropicMessagesRoutes } from './routes/anthropic/messages.js';

// Router utilities
import { loadProviders } from './router.js';

export const app = new Hono<{ Bindings: Env }>();

// ---- Global CORS ----
app.use('*', cors({
	origin: (origin) => origin || '*',
	allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
	maxAge: 86400,
}));

// ---- Health check ----
app.get('/health', async (c) => {
	const providers = await loadProviders(c.env).catch(() => []);
	const enabled = providers.filter((p) => p.enabled).length;
	const runtime = getRuntimeStatus(c.env);
	return c.json({
		ok: true,
		message: 'Vega API is running',
		platform: runtime.platform,
		database: runtime.database,
		providers: enabled,
		routes: ['/', '/health', '/v1/chat/completions', '/v1/models', '/v1beta/models', '/v1beta/models/:model:generateContent', '/anthropic/v1/messages'],
	});
});

// ---- Admin routes ----
// Auth guard applied to all /admin/* routes (with skip list for public endpoints)
app.use('/admin/*', adminAuthMiddleware());

app.route('/admin', adminAuthRoutes);
app.route('/admin', adminProviderRoutes);
app.route('/admin', adminApiKeyRoutes);
app.route('/admin', adminUsageRoutes);
app.route('/admin', adminPlaygroundRoutes);
app.route('/admin', adminRouteTopologyRoutes);

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
	return c.json({ error: { message: 'Not Found' } }, 404, { 'Connection': 'keep-alive' });
});

// ---- One-time runtime init (per isolate / per cold start) ----
let schemaInitialized = false;
let cbConfigInitialized = false;

/**
 * Prepare the runtime on first use: initialize the database schema and load the
 * circuit-breaker config. Idempotent across cold starts so the Cloudflare Worker
 * and Vercel function both call it once per isolate.
 */
export async function prepareRuntime(env: Env): Promise<void> {
	if (!schemaInitialized) {
		try {
			await initSchema(env);
			schemaInitialized = true;
		} catch (err) {
			console.error('Schema init error:', (err as Error).message);
		}
	}
	if (!cbConfigInitialized) {
		try {
			await ensureConfigLoaded(env);
			cbConfigInitialized = true;
		} catch (err) {
			console.error('Circuit breaker config load error:', (err as Error).message);
		}
	}
}
