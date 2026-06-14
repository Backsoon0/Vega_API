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
	const requestId = crypto.randomUUID();
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
					return handleStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs, requestId, isStream);
				}
				return handleNonStreamResponse(upstreamResp, c.env, provider.id, modelId, ip, execCtx, startMs, requestId, isStream);
			}

			// Non-ok response: try to read error, then fall through to next provider
			const errText = await upstreamResp.text().catch(() => '');
			lastError = `Provider ${provider.id} returned ${upstreamResp.status}: ${errText.slice(0, 200)}`;
			console.error(lastError);
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(c.env, provider.id, modelId, ip,
						{ prompt: 0, completion: 0 },
						false, Date.now() - startMs, requestId, !!body.stream,
						{
							errorType: 'upstream_error',
							errorCode: String(upstreamResp.status),
							errorMessage: errText.slice(0, 500),
						}
					),
				);
			}
			// Continue to next candidate
		} catch (err) {
			lastError = `Provider ${provider.id} error: ${(err as Error).message}`;
			console.error(lastError);
			if (execCtx) {
				const errMsg = (err as Error).message || 'Unknown error';
				execCtx.waitUntil(
					recordUsage(c.env, provider.id, modelId, ip,
						{ prompt: 0, completion: 0 },
						false, 0, requestId, !!body.stream,
						{ errorType: 'network_error', errorMessage: errMsg.slice(0, 500) }
					),
				);
			}
			// Continue to next candidate
		}
	}

	// All providers failed
	if (execCtx) {
		execCtx.waitUntil(
			recordUsage(c.env, 'unknown', modelId, ip,
				{ prompt: 0, completion: 0 },
				false, 0, requestId, !!body.stream,
				{
					errorType: 'all_providers_failed',
					errorMessage: lastError.slice(0, 500),
				}
			),
		);
	}
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

/**
 * Parse SSE stream buffer and extract usage from the final event(s).
 * Each SSE event is a standalone JSON line prefixed with "data: ".
 * Parsing individual events avoids false positives where "usage" appears
 * inside model output content strings.
 *
 * Searches in reverse — usage/usageMetadata is always in the final chunk(s).
 */
function extractUsageFromSSE(rawBuffer: string): { prompt_tokens: number; completion_tokens: number } | null {
	const events = rawBuffer.split('\n\n');
	// Search in reverse: usage is always in the last event(s)
	for (let idx = events.length - 1; idx >= 0; idx--) {
		const event = events[idx];
		if (!event.startsWith('data: ')) continue;
		const jsonStr = event.slice(6); // strip "data: " prefix
		if (jsonStr === '[DONE]') continue;
		try {
			const data = JSON.parse(jsonStr);
			// OpenAI uses "usage", Google uses "usageMetadata" in OpenAI-compat mode
			const usage = data?.usage || data?.usageMetadata;
			if (usage && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
				return {
					prompt_tokens: usage.prompt_tokens || 0,
					completion_tokens: usage.completion_tokens || 0,
				};
			}
		} catch {
			// Skip malformed JSON — try earlier events
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
	requestId: string,
	isStream: boolean,
): Promise<Response> {
	const bodyText = await upstreamResp.text();
	const upstreamRequestId = upstreamResp.headers.get('x-request-id')
		|| upstreamResp.headers.get('x-goog-request-id')
		|| '';
	const extra: Record<string, string> = {};
	if (upstreamRequestId) extra.upstreamRequestId = upstreamRequestId;

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
				}, true, durationMs, requestId, isStream, extra),
			);
		}
	} catch {
		/* ignore parse errors */
	}
	const headers = new Headers(upstreamResp.headers);
	headers.set('x-request-id', requestId);
	return new Response(bodyText, {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers,
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
	requestId: string,
	isStream: boolean,
): Response {
	const [clientStream, observerStream] = upstreamResp.body!.tee();
	const upstreamRequestId = upstreamResp.headers.get('x-request-id')
		|| upstreamResp.headers.get('x-goog-request-id')
		|| '';
	const extra: Record<string, string> = {};
	if (upstreamRequestId) extra.upstreamRequestId = upstreamRequestId;

	// Always drain the observer stream (prevents leaks), but only record usage if execCtx is available
	const drainPromise = (async () => {
		const reader = observerStream.getReader();
		let rawBuffer = '';
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (value) rawBuffer += new TextDecoder().decode(value);
				if (done) break;
			}
			if (execCtx) {
				const usage = extractUsageFromSSE(rawBuffer);
				if (usage) {
					const durationMs = Date.now() - startMs;
					await recordUsage(env, providerId, modelId, ip, {
						prompt: usage.prompt_tokens,
						completion: usage.completion_tokens,
					}, true, durationMs, requestId, isStream, extra);
				}
			}
		} catch {
			/* ignore read errors */
		}
	})();

	// Register with waitUntil if available so the Worker stays alive until the observer completes
	if (execCtx) {
		execCtx.waitUntil(drainPromise);
	}

	const headers = new Headers(upstreamResp.headers);
	headers.set('x-request-id', requestId);
	return new Response(clientStream, {
		status: upstreamResp.status,
		statusText: upstreamResp.statusText,
		headers,
	});
}
