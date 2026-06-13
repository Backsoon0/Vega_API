// src/routes/v1/chat.ts
// OpenAI-compatible /v1/chat/completions — streaming + non-streaming proxy
// Supports fallback: tries providers in weight order until one succeeds

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import type { ProviderMatch } from '../../router';
import { findProviderForModel, PROVIDER_HANDLERS } from '../../router';
import { recordUsage } from '../../usage';

/** Maximum request body size: 5 MB (balances image support vs Worker memory) */
const MAX_BODY_SIZE = 5_242_880;

export const v1ChatRoutes = new Hono<{ Bindings: Env }>();

// POST /v1/chat/completions
v1ChatRoutes.post('/chat/completions', async (c: Context<{ Bindings: Env }>) => {
	// Request body size guard
	const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
	if (contentLength > MAX_BODY_SIZE) {
		return c.json(
			{
				error: {
					message: `Request body too large: ${contentLength} bytes (max ${MAX_BODY_SIZE})`,
					type: 'invalid_request_error',
				},
			},
			413,
		);
	}

	const body = await c.req.json().catch(() => null);
	if (!body?.model) {
		return c.json(
			{ error: { message: 'model is required', type: 'invalid_request_error' } },
			400,
		);
	}

	const modelId = String(body.model).trim();
	const candidates: ProviderMatch[] = await findProviderForModel(c.env, modelId);
	if (!candidates.length) {
		return c.json(
			{ error: { message: `No enabled provider for model: ${modelId}` } },
			400,
		);
	}

	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const execCtx = (c as any).executionCtx;

	// Try each candidate in weight order; fall back on failure
	let lastError: string = '';
	for (let i = 0; i < candidates.length; i++) {
		const { provider, matchedModel } = candidates[i];
		const handler = PROVIDER_HANDLERS[provider.type];
		if (!handler) {
			lastError = `Unknown provider type: ${provider.type}`;
			continue;
		}

		const routedBody = { ...body, model: matchedModel };

		const newHeaders = new Headers(c.req.raw.headers);
		newHeaders.delete('content-length');
		const proxyReq = new Request(c.req.raw.url, {
			method: 'POST',
			headers: newHeaders,
			body: JSON.stringify(routedBody),
		});

		try {
			const startMs = Date.now();
			const upstreamResp = await handler.proxyRequest(
				proxyReq,
				c.env,
				provider,
				'/chat/completions',
			);

			if (upstreamResp.ok && upstreamResp.body) {
				const isStream = !!body.stream;
				if (isStream) {
					return handleStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs);
				}
				return handleNonStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs);
			}

			// Non-ok response: try to read error, then fall through to next provider
			const errText = await upstreamResp.text().catch(() => '');
			lastError = `Provider ${provider.id} returned ${upstreamResp.status}: ${errText.slice(0, 200)}`;
			console.error(lastError);
			// Record failed attempt (fire-and-forget)
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(c.env, provider.id, modelId, ip, { prompt: 0, completion: 0 }, false, 0),
				);
			}
			// Continue to next candidate
		} catch (err) {
			lastError = `Provider ${provider.id} error: ${(err as Error).message}`;
			console.error(lastError);
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(c.env, provider.id, modelId, ip, { prompt: 0, completion: 0 }, false, 0),
				);
			}
			// Continue to next candidate
		}
	}

	// All providers failed
	return c.json(
		{
			error: {
				message: `All providers failed for model '${modelId}'. Last error: ${lastError}`,
				type: 'server_error',
			},
		},
		502,
	);
});

// ---- Usage extraction helpers ----

/** Extract a balanced JSON object at key, handling nested braces (e.g. prompt_tokens_details). */
function extractUsageJson(text: string): { prompt_tokens?: number; completion_tokens?: number } | null {
	for (const key of ['"usage"', '"usageMetadata"']) {
		const start = text.indexOf(key);
		if (start === -1) continue;

		let i = text.indexOf('{', start);
		if (i === -1) continue;

		let depth = 1;
		let j = i + 1;
		while (j < text.length && depth > 0) {
			const ch = text[j];
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
			else if (ch === '"') {
				j++;
				while (j < text.length) {
					if (text[j] === '\\') { j += 2; continue; }
					if (text[j] === '"') break;
					j++;
				}
			}
			j++;
		}

		if (depth === 0) {
			try {
				const obj = JSON.parse(text.substring(i, j));
				return obj;
			} catch {
				continue;
			}
		}
	}
	return null;
}

// ---- Non-streaming response handler ----
async function handleNonStreamResponse(
	upstreamResp: Response,
	env: Env,
	providerId: string,
	modelId: string,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const bodyText = await upstreamResp.text();
	try {
		const data = JSON.parse(bodyText);
		// OpenAI returns `usage`, Google returns `usageMetadata` in OpenAI-compatible mode
		const usage = data?.usage || data?.usageMetadata;
		if (usage && execCtx) {
			const durationMs = Date.now() - startMs;
			execCtx.waitUntil(
				recordUsage(env, providerId, modelId, ip, {
					prompt: usage.prompt_tokens || 0,
					completion: usage.completion_tokens || 0,
				}, true, durationMs),
			);
		}
	} catch {
		/* ignore parse errors */
	}
	return new Response(bodyText, {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers: upstreamResp.headers,
	});
}

// ---- Streaming response handler ----
// Uses body.tee() so execCtx.waitUntil() is called BEFORE the handler returns.
// (waitUntil inside TransformStream.flush() runs too late — fetch handler already returned.)
function handleStreamResponse(
	upstreamResp: Response,
	env: Env,
	providerId: string,
	modelId: string,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Response {
	const [clientStream, observerStream] = upstreamResp.body!.tee();

	// Read observer stream to extract usage, then record via waitUntil (called now, not in flush)
	if (execCtx) {
		execCtx.waitUntil(
			(async () => {
				const reader = observerStream.getReader();
				let rawBuffer = '';
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (value) rawBuffer += new TextDecoder().decode(value);
						if (done) break;
					}
					const usage = extractUsageJson(rawBuffer);
					if (usage) {
						const durationMs = Date.now() - startMs;
						await recordUsage(env, providerId, modelId, ip, {
							prompt: usage.prompt_tokens || 0,
							completion: usage.completion_tokens || 0,
						}, true, durationMs);
					}
				} catch {
					/* ignore read errors */
				}
			})(),
		);
	}

	return new Response(clientStream, {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers: upstreamResp.headers,
	});
}
