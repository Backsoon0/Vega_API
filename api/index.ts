// api/index.ts
// Vercel Serverless entry — runs the shared Hono app (src/app.ts) on Vercel's
// Node runtime, backed by Neon (Postgres) instead of Cloudflare D1.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
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

import type { Env } from '../src/types.js';
import { app, prepareRuntime } from '../src/app.js';
import { NeonDBClient } from './neon.js';

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
		// Vercel serves the SvelteKit SPA statically (via public/), so ASSETS is an inert stub here.
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

// ---- Vercel request/response bridging (Node `(req, res)` ↔ web Request/Response) ----

/** True when the first arg is already a web `Request` (Vercel web-handler mode). */
function isWebRequest(req: any): req is Request {
	return !!req && typeof req.url === 'string' && typeof req.method === 'string' && req.headers && typeof req.headers.get === 'function';
}

/** Convert a Node `IncomingMessage` body to a web `ReadableStream`. */
function nodeBodyToStream(req: any): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			req.on('data', (chunk: Uint8Array) => controller.enqueue(chunk));
			req.on('end', () => controller.close());
			req.on('error', (err: Error) => controller.error(err));
		},
	});
}

/** Build a web `Request` from a Vercel/Node request (web Request or IncomingMessage). */
async function toWebRequest(req: any): Promise<Request> {
	if (isWebRequest(req)) return req as Request;

	// Node IncomingMessage path.
	const headers = new Headers();
	const rawHeaders = (req.headers as Record<string, string | string[] | undefined>) || {};
	for (const [k, v] of Object.entries(rawHeaders)) {
		if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
	}
	const host = headers.get('host') || 'localhost';
	const url = `https://${host}${req.url || '/'}`;
	const method = String(req.method || 'GET').toUpperCase();
	let body: BodyInit | null = null;
	if (method !== 'GET' && method !== 'HEAD' && typeof req.on === 'function') {
		body = nodeBodyToStream(req);
	}
	const init: Record<string, unknown> = { method, headers };
	if (body) {
		init.body = body;
		// Node's fetch requires `duplex: 'half'` when the request body is a stream.
		init.duplex = 'half';
	}
	return new Request(url, init as RequestInit);
}

/** Write a web `Response` to a Node `ServerResponse` (streaming-safe). */
async function writeResponseToNode(res: any, response: Response): Promise<void> {
	res.statusCode = response.status;
	for (const [k, v] of response.headers) res.setHeader(k, v);
	if (response.body) {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	}
	res.end();
}

/**
 * Vercel Node handler. Vercel may call it with either a web `Request` (return a
 * `Response`) or the classic Node `(req, res)` pair (write to `res`). Both are
 * supported, so the Hono app always receives a standard web `Request`.
 */
export default async function handler(req: any, res?: any): Promise<Response | void> {
	try {
		const runtimeEnv = getEnv();
		// One-time per-cold-start init: schema + circuit-breaker config.
		await prepareRuntime(runtimeEnv);
		const request = await toWebRequest(req);
		const response = await app.fetch(request, runtimeEnv, executionCtxShim as never);

		if (res && typeof res.statusCode === 'number') {
			await writeResponseToNode(res, response);
			return;
		}
		return response;
	} catch (err) {
		// Surface the real error (e.g. missing env var, DB connection failure) so it's
		// visible in the response instead of a generic 500.
		console.error('Vercel handler error:', err);
		const message = (err as Error)?.message || String(err);
		const body = JSON.stringify({ error: `Function error: ${message}` }, null, 2);
		if (res && typeof res.statusCode === 'number') {
			res.statusCode = 500;
			res.setHeader('content-type', 'application/json');
			res.end(body);
			return;
		}
		return new Response(body, { status: 500, headers: { 'content-type': 'application/json' } });
	}
}

// Re-export so tools / tests can inspect the entry without side effects.
export { buildEnv, getEnv };
