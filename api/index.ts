// api/index.ts
// Vercel Serverless entry — runs the shared Hono app (src/app.ts) on Vercel's
// Node runtime, backed by Neon (Postgres) instead of Cloudflare D1.
//
// Environment variables (Vercel → Project → Settings → Environment Variables).
// Follows the Waline database convention (see https://waline.js.org/guide/database.html):
//   DATABASE  — engine selector: "postgres"/"neon"/"pg" → Neon, "d1"/"sqlite" → D1.
//   PGURL     — full Postgres connection string (Waline-style). Overrides the libpq vars.
//   PGHOST / PGDATABASE / PGUSER / PGPASSWORD / PGPORT — libpq-style split connection.
// Aliases (also accepted, commonly injected by Neon/Vercel integrations):
//   DATABASE_URL / POSTGRES_URL — connection string (equivalent to PGURL).
//   DATABASE_PROVIDER           — engine selector (equivalent to DATABASE).
// Other required vars:
//   ENCRYPTION_KEY        — required. Same AES-256-GCM key used on Cloudflare.
//   OPENAI_API_KEY        — optional. Fallback client key.
//   VEGA_GOOGLE_TOOL_MODE — optional. "ai-sdk" (default) | "direct".
//   DEPLOYMENT_PLATFORM   — optional. "vercel" | "cloudflare" (auto-detected via VERCEL).
//
// The Cloudflare Worker deployment is unaffected: this file is only compiled by
// Vercel (`main` in wrangler.jsonc still points to src/index.ts).

import type { Env } from '../src/types';
import { app, prepareRuntime } from '../src/app';
import { NeonDBClient } from './neon';

// ---- Resolve the Postgres/Neon connection string (Waline-style names) ----

/** Resolve a Postgres connection URL from Waline-style env vars (PGURL or libpq PG*). */
function resolveDatabaseUrl(processEnv: Record<string, string | undefined>): string {
	// 1. Full connection string (Waline `PGURL`, or common aliases).
	const full = processEnv.PGURL || processEnv.DATABASE_URL || processEnv.POSTGRES_URL || '';
	if (full) return full;

	// 2. libpq-style split connection vars (Waline also supports these).
	const host = processEnv.PGHOST;
	const database = processEnv.PGDATABASE;
	if (host && database) {
		const port = processEnv.PGPORT || '5432';
		const user = processEnv.PGUSER ? encodeURIComponent(processEnv.PGUSER) : '';
		const pass = processEnv.PGPASSWORD ? `:${encodeURIComponent(processEnv.PGPASSWORD)}` : '';
		const auth = user ? `${user}${pass}@` : '';
		return `postgresql://${auth}${host}:${port}/${encodeURIComponent(database)}`;
	}

	return '';
}

// ---- Build the runtime `env` from Vercel environment variables ----

function buildEnv(processEnv: Record<string, string | undefined>): Env {
	const DATABASE_URL = resolveDatabaseUrl(processEnv);
	if (!DATABASE_URL) {
		throw new Error(
			'No Neon/Postgres connection string configured on Vercel. Set `PGURL` (or `DATABASE_URL` / `POSTGRES_URL`)' +
				' — e.g. from the Vercel Neon integration — or the libpq vars `PGHOST`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`.',
		);
	}

	return {
		DB: new NeonDBClient(DATABASE_URL),
		// Vercel serves the SvelteKit SPA statically, so ASSETS is an inert stub here.
		ASSETS: { fetch: async () => new Response('Not Found', { status: 404 }) },
		ENCRYPTION_KEY: processEnv.ENCRYPTION_KEY || undefined,
		OPENAI_API_KEY: processEnv.OPENAI_API_KEY || undefined,
		VEGA_GOOGLE_TOOL_MODE: processEnv.VEGA_GOOGLE_TOOL_MODE || undefined,
		// On Vercel the engine is always Neon — a NeonDBClient backs `env.DB`, so
		// force the detected engine (and the Postgres schema path) regardless of
		// any stray `DATABASE` override.
		DATABASE_PROVIDER: 'neon',
		DATABASE: 'postgres',
		DATABASE_URL,
		DEPLOYMENT_PLATFORM: 'vercel',
	};
}

// A minimal execution-context shim — Vercel has no waitUntil, so usage recording
// is fire-and-forget (it still executes, but isn't awaited past the response).
// The `run_args` are typed loosely so Vercel's bundler never needs the
// Cloudflare-only `ExecutionContext` type.
const executionCtxShim = {
	waitUntil: (promise: Promise<unknown>) => {
		Promise.resolve(promise).catch((err) => console.error('waitUntil error:', err));
	},
	passThroughOnException: () => undefined,
};

let env: Env | null = null;
function getEnv(): Env {
	if (!env) env = buildEnv(process.env as Record<string, string | undefined>);
	return env;
}

/**
 * Vercel Node handler. Vercel calls it with a web `Request` and expects a `Response`.
 * (The Hono `hono/vercel` adapter wraps the exact same `req → app.fetch(req)` contract.)
 */
export default async function handler(request: Request): Promise<Response> {
	try {
		const runtimeEnv = getEnv();
		// One-time per-cold-start init: schema + circuit-breaker config.
		await prepareRuntime(runtimeEnv);
		return await app.fetch(request, runtimeEnv, executionCtxShim as never);
	} catch (err) {
		// Surface the real error (e.g. missing env var, DB connection failure) so it's
		// visible in the response instead of a generic 500.
		console.error('Vercel handler error:', err);
		const message = (err as Error)?.message || String(err);
		return new Response(
			JSON.stringify({ error: `Function error: ${message}` }, null, 2),
			{ status: 500, headers: { 'Content-Type': 'application/json' } },
		);
	}
}

// Re-export so tools / tests can inspect the entry without side effects.
export { buildEnv, getEnv };
