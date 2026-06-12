// src/routes/v1/chat.ts
// OpenAI-compatible /v1/chat/completions — streaming + non-streaming proxy

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
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
	const result = await findProviderForModel(c.env, modelId);
	if (!result) {
		return c.json(
			{ error: { message: `No enabled provider for model: ${modelId}` } },
			400,
		);
	}

	const { provider } = result;
	const handler = PROVIDER_HANDLERS[provider.type];
	if (!handler) {
		return c.json(
			{ error: { message: `Unknown provider type: ${provider.type}` } },
			500,
		);
	}

	body.model = result.matchedModel;

	const newHeaders = new Headers(c.req.raw.headers);
	newHeaders.delete('content-length');
	const proxyReq = new Request(c.req.raw.url, {
		method: 'POST',
		headers: newHeaders,
		body: JSON.stringify(body),
	});

	try {
		const upstreamResp = await handler.proxyRequest(
			proxyReq,
			c.env,
			provider,
			'/chat/completions',
		);
	if (!upstreamResp.ok || !upstreamResp.body) return upstreamResp;

		const ip = c.req.header('CF-Connecting-IP') || 'unknown';
		const isStream = !!body.stream;

		if (isStream) {
			return handleStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, c);
		}

		return handleNonStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, c);
	} catch (err) {
		console.error(`Provider ${provider.id} error:`, (err as Error).message);
		const ip = c.req.header('CF-Connecting-IP') || 'unknown';
		const execCtx = (c as any).executionCtx;
		if (execCtx) {
			execCtx.waitUntil(
				recordUsage(c.env, provider.id, modelId, ip, { prompt: 0, completion: 0 }, false),
			);
		}
		return c.json(
			{
				error: {
					message: `Upstream failed: ${(err as Error).message}`,
					type: 'server_error',
				},
			},
			502,
		);
	}
});

// ---- Non-streaming response handler ----
async function handleNonStreamResponse(
	upstreamResp: Response,
	env: Env,
	providerId: string,
	modelId: string,
	ip: string,
	c: Context<{ Bindings: Env }>,
): Promise<Response> {
	const bodyText = await upstreamResp.text();
	try {
		const data = JSON.parse(bodyText);
		if (data?.usage) {
			const execCtx = (c as any).executionCtx;
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(env, providerId, modelId, ip, {
						prompt: data.usage.prompt_tokens || 0,
						completion: data.usage.completion_tokens || 0,
					}, true),
				);
			}
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

// ---- Streaming response handler with improved token counting ----
function handleStreamResponse(
	upstreamResp: Response,
	env: Env,
	providerId: string,
	modelId: string,
	ip: string,
	c: Context<{ Bindings: Env }>,
): Response {
	// Accumulate all candidate JSON objects from data lines,
	// then pick the one with usage info on flush.
	const candidates: string[] = [];

	const ts = new TransformStream({
		transform(chunk, ctrl) {
			ctrl.enqueue(chunk);
			const text = new TextDecoder().decode(chunk);
			const lines = text.split('\n');
			for (const line of lines) {
				const t = line.trim();
				if (t.startsWith('data: ') && t !== 'data: [DONE]') {
					candidates.push(t.slice(6).trim());
				}
			}
		},
		flush() {
			// Find the last chunk that has usage info (more robust than assuming last chunk)
			for (let i = candidates.length - 1; i >= 0; i--) {
				try {
					const d = JSON.parse(candidates[i]);
					if (d?.usage) {
						const execCtx = (c as any).executionCtx;
						if (execCtx) {
							execCtx.waitUntil(
								recordUsage(env, providerId, modelId, ip, {
									prompt: d.usage.prompt_tokens || 0,
									completion: d.usage.completion_tokens || 0,
								}, true),
							);
						}
						break;
					}
				} catch {
					/* skip unparseable candidates */
				}
			}
		},
	});

	// body is non-null — checked before calling handleStreamResponse
	return new Response(upstreamResp.body!.pipeThrough(ts), {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers: upstreamResp.headers,
	});
}
