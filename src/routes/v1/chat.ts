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
			const startMs = Date.now();
			const upstreamResp = await handler.proxyRequest(
				proxyReq,
				c.env,
				provider,
				'/chat/completions',
			);
		if (!upstreamResp.ok || !upstreamResp.body) return upstreamResp;

			const ip = c.req.header('CF-Connecting-IP') || 'unknown';
			const isStream = !!body.stream;
			// Capture execCtx now — not available in TransformStream flush() after handler returns
			const execCtx = (c as any).executionCtx;

			if (isStream) {
				return handleStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs);
			}

			return handleNonStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs);
		} catch (err) {
		console.error(`Provider ${provider.id} error:`, (err as Error).message);
		const ip = c.req.header('CF-Connecting-IP') || 'unknown';
		const execCtx = (c as any).executionCtx;
		if (execCtx) {
			execCtx.waitUntil(
				recordUsage(c.env, provider.id, modelId, ip, { prompt: 0, completion: 0 }, false, 0),
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
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const bodyText = await upstreamResp.text();
	try {
		const data = JSON.parse(bodyText);
		if (data?.usage) {
			const durationMs = Date.now() - startMs;
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(env, providerId, modelId, ip, {
						prompt: data.usage.prompt_tokens || 0,
						completion: data.usage.completion_tokens || 0,
					}, true, durationMs),
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
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Response {
	// Buffer raw text across chunks — SSE data may contain embedded
	// newlines in the JSON content, which breaks line-by-line parsing.
	let rawBuffer = '';

	const ts = new TransformStream({
		transform(chunk, ctrl) {
			ctrl.enqueue(chunk);
			rawBuffer += new TextDecoder().decode(chunk);
		},
		flush() {
			// Extract "usage":{...} from raw text via regex.
			// Works even when JSON content contains literal newlines.
			const usageMatch = rawBuffer.match(/"usage"\s*:\s*\{[^}]+\}/);
			if (usageMatch) {
				try {
					const usageJson = JSON.parse('{' + usageMatch[0] + '}');
					if (usageJson.usage && execCtx) {
						const durationMs = Date.now() - startMs;
						execCtx.waitUntil(
							recordUsage(env, providerId, modelId, ip, {
								prompt: usageJson.usage.prompt_tokens || 0,
								completion: usageJson.usage.completion_tokens || 0,
							}, true, durationMs),
						);
					}
				} catch {
					/* skip parse errors */
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
