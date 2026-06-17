// src/routes/v1beta/chat.ts
// Google Gemini-native API — generateContent + streamGenerateContent
// Uses AI SDK @ai-sdk/google provider, outputs native Gemini API format
//
// POST /v1beta/models/:model:generateContent       — non-streaming
// POST /v1beta/models/:model:streamGenerateContent  — streaming (SSE)

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamText, generateText } from 'ai';
import type { Env } from '../../types';
import type { ProviderMatch } from '../../router';
import { findProviderForModel } from '../../router';
import { createModelFromProvider } from '../../ai-providers';
import { recordUsage, extractCacheTokens } from '../../usage';
import { getFailoverEnabled } from '../../config';

export const v1betaChatRoutes = new Hono<{ Bindings: Env }>();

const MAX_BODY_SIZE = 5_242_880; // 5 MB

// ---- Helpers ----

/**
 * Convert Gemini generateContent request to AI SDK format.
 * Gemini format: { contents: [{ role, parts: [{ text, ... }] }], systemInstruction, generationConfig, ... }
 */
function geminiToAISDK(body: Record<string, unknown>): {
	messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
	system?: string;
} {
	const contents = (body.contents as Array<Record<string, unknown>>) || [];
	const systemInstruction = body.systemInstruction as { parts?: Array<{ text: string }> } | undefined;

	const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
	if (systemInstruction?.parts) {
		messages.push({
			role: 'system',
			content: [{ type: 'text', text: systemInstruction.parts.map((p) => p.text).join('\n') }],
		});
	}

	for (const c of contents) {
		const role = c.role === 'model' ? 'assistant' : String(c.role || 'user');
		const parts = (c.parts as Array<Record<string, unknown>>) || [];
		const content: Array<{ type: string; text: string }> = [];
		for (const p of parts) {
			if (p.text !== undefined) {
				content.push({ type: 'text', text: String(p.text) });
			}
		}
		if (content.length > 0) {
			messages.push({ role, content });
		}
	}

	return { messages };
}

/**
 * Convert AI SDK finishReason to Gemini finishReason.
 */
function mapFinishReason(reason: string): string {
	switch (reason) {
		case 'stop':
			return 'STOP';
		case 'length':
			return 'MAX_TOKENS';
		case 'content-filter':
			return 'SAFETY';
		default:
			return 'STOP';
	}
}

/**
 * Gemini streaming response helper: builds a GenerateContentResponse chunk.
 * Content is cumulative — Google's standard streaming accumulates text.
 */
function buildGeminiChunk(text: string, finishReason?: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): object {
	const candidate: Record<string, unknown> = {
		content: { role: 'model', parts: [{ text }] },
		index: 0,
		safetyRatings: [],
	};
	if (finishReason) candidate.finishReason = finishReason;

	const resp: Record<string, unknown> = { candidates: [candidate] };
	if (usage) {
		resp.usageMetadata = {
			promptTokenCount: usage.inputTokens,
			candidatesTokenCount: usage.outputTokens,
			totalTokenCount: usage.totalTokens,
		};
	}
	return resp;
}

/**
 * Build extra body headers from explicit extra_body field.
 */
function buildExtraBodyHeaders(body: Record<string, unknown>): Record<string, string> | undefined {
	if (!body.extra_body || typeof body.extra_body !== 'object') return undefined;
	return { 'X-Vega-Extra-Body': JSON.stringify(body.extra_body) };
}

/**
 * Stream handler: supports both Google streaming modes.
 *   - ?alt=sse  → SSE format:  "data: {...}\n\n"
 *   - default   → NDJSON format: "{...}\n" (line-delimited JSON)
 */
async function handleGeminiStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
	altSse: boolean,
): Promise<Response> {
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);
	const { messages } = geminiToAISDK(body);
	const genConfig = body.generationConfig as Record<string, unknown> | undefined;

	const result = streamText({
		model,
		messages: messages as any,
		maxOutputTokens: genConfig?.maxOutputTokens as number | undefined,
		temperature: genConfig?.temperature as number | undefined,
		topP: genConfig?.topP as number | undefined,
		stopSequences: (genConfig?.stopSequences as string[]) || undefined,
		headers: buildExtraBodyHeaders(body),
	});

	const encoder = new TextEncoder();
	let fullText = '';
	let lastInputTokens = 0;
	let lastOutputTokens = 0;

	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const part of result.fullStream) {
					switch (part.type) {
						case 'text-delta':
							fullText += part.text;
							{
								const chunk = JSON.stringify(buildGeminiChunk(fullText));
								controller.enqueue(
									encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
								);
							}
							break;

						case 'finish': {
							const finishReason = mapFinishReason(part.finishReason);
							lastInputTokens = part.totalUsage?.inputTokens || 0;
							lastOutputTokens = part.totalUsage?.outputTokens || 0;
							const chunk = JSON.stringify(
								buildGeminiChunk(fullText, finishReason, {
									inputTokens: lastInputTokens,
									outputTokens: lastOutputTokens,
									totalTokens: part.totalUsage?.totalTokens || 0,
								}),
							);
							controller.enqueue(
								encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
							);
							break;
						}

					case 'error': {
						const errMsg = part.error instanceof Error
							? part.error.message
							: typeof part.error === 'string'
								? part.error
								: JSON.stringify(part.error);
						const chunk = JSON.stringify({ error: { message: errMsg, code: 500 } });
							controller.enqueue(
								encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
							);
							break;
						}
					}
				}

				// Extract cache tokens from provider metadata
				let cacheRead = 0;
				let cacheCreation = 0;
				try {
					const metadata = await result.providerMetadata;
					if (metadata) {
						const cache = extractCacheTokens(metadata);
						cacheRead = cache.cacheReadInputTokens;
						cacheCreation = cache.cacheCreationInputTokens;
					}
				} catch { /* provider metadata not available */ }

				if (execCtx && lastInputTokens + lastOutputTokens > 0) {
					execCtx.waitUntil(
						recordUsage(env, provider.provider.id, rawModelId, ip,
							{ prompt: lastInputTokens, completion: lastOutputTokens },
							true, Date.now() - startMs, requestId, true, {},
							cacheRead, cacheCreation,
							env.clientKeyName || '',
						),
					);
				}
		} catch (err) {
			const errMsg = err instanceof Error
				? err.message
				: typeof err === 'string'
					? err
					: JSON.stringify(err);
			const chunk = JSON.stringify({ error: { message: errMsg, code: 500 } });
				controller.enqueue(
					encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
				);
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'x-request-id': requestId,
		},
	});
}

/**
 * Non-streaming handler: Gemini generateContent response format.
 */
async function handleGeminiNonStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
): Promise<Response> {
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);
	const { messages } = geminiToAISDK(body);
	const genConfig = body.generationConfig as Record<string, unknown> | undefined;

	const result = await generateText({
		model,
		messages: messages as any,
		maxOutputTokens: genConfig?.maxOutputTokens as number | undefined,
		temperature: genConfig?.temperature as number | undefined,
		topP: genConfig?.topP as number | undefined,
		stopSequences: (genConfig?.stopSequences as string[]) || undefined,
		headers: buildExtraBodyHeaders(body),
	});

	const finishReason = mapFinishReason(result.finishReason);

	let cacheRead = 0;
	let cacheCreation = 0;
	try {
		const metadata = await result.providerMetadata;
		if (metadata) {
			const cache = extractCacheTokens(metadata);
			cacheRead = cache.cacheReadInputTokens;
			cacheCreation = cache.cacheCreationInputTokens;
		}
	} catch { /* provider metadata not available */ }

	if (execCtx) {
		execCtx.waitUntil(
			recordUsage(
				env,
				provider.provider.id,
				rawModelId,
				ip,
				{ prompt: result.usage?.inputTokens || 0, completion: result.usage?.outputTokens || 0 },
				true,
				Date.now() - startMs,
				requestId,
				false,
				{},
				cacheRead,
				cacheCreation,
				env.clientKeyName || '',
			),
		);
	}

	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: {
						role: 'model',
						parts: [{ text: result.text }],
					},
					finishReason,
					index: 0,
					safetyRatings: [],
				},
			],
			usageMetadata: {
				promptTokenCount: result.usage?.inputTokens || 0,
				candidatesTokenCount: result.usage?.outputTokens || 0,
				totalTokenCount: result.usage?.totalTokens || 0,
			},
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		},
	);
}

// ---- Routes ----

/**
 * POST /v1beta/models/:modelAndAction
 * Hono route with wildcard to handle :modelId:generateContent and :modelId:streamGenerateContent
 * The parameter will be something like "gemini-2.5-flash:generateContent"
 */
v1betaChatRoutes.post('/models/:modelAndAction{.+}', async (c: Context<{ Bindings: Env }>) => {
	const rawParam = c.req.param('modelAndAction');
	if (!rawParam) {
		return c.json({ error: { message: 'Model and action required', code: 400 } }, 400);
	}

	// Parse modelId and action from "gemini-2.5-flash:generateContent" or "gemini-2.5-flash:streamGenerateContent"
	const colonIdx = rawParam.lastIndexOf(':');
	if (colonIdx < 0) {
		return c.json({ error: { message: 'Missing action (e.g. :generateContent)', code: 400 } }, 400);
	}

	const modelId = decodeURIComponent(rawParam.slice(0, colonIdx)).replace(/^models\//, '');
	const action = rawParam.slice(colonIdx + 1);

	if (action !== 'generateContent' && action !== 'streamGenerateContent') {
		return c.json(
			{ error: { message: `Unknown action: ${action}. Expected :generateContent or :streamGenerateContent`, code: 400 } },
			400,
		);
	}

	const isStream = action === 'streamGenerateContent';
	const altSse = c.req.query('alt') === 'sse';  // ?alt=sse → SSE format, otherwise NDJSON

	// Request body size guard
	const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
	if (contentLength > MAX_BODY_SIZE) {
		return c.json(
			{ error: { message: `Request body too large: ${contentLength} bytes (max ${MAX_BODY_SIZE})`, code: 413 } },
			413,
		);
	}

	const body = await c.req.json().catch(() => null);
	if (!body) {
		return c.json({ error: { message: 'Invalid JSON body', code: 400 } }, 400);
	}

	const candidates: ProviderMatch[] = await findProviderForModel(c.env, modelId);
	if (!candidates.length) {
		return c.json(
			{ error: { message: `No enabled provider for model: ${modelId}`, code: 400 } },
			400,
		);
	}

	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const requestId = crypto.randomUUID();
	const execCtx = (c as any).executionCtx;
	const startMs = Date.now();

	// Try each candidate in weight order (if failover enabled)
	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];
	let lastError = '';
	for (const candidate of tryCandidates) {
		try {
			if (isStream) {
				return await handleGeminiStream(
					body, requestId, candidate, c.env, ip, execCtx, startMs, modelId, altSse,
				);
			}
			return await handleGeminiNonStream(
				body, requestId, candidate, c.env, ip, execCtx, startMs, modelId,
			);
		} catch (err) {
			lastError = `Provider ${candidate.provider.id}: ${(err as Error).message}`;
			console.error(lastError);
		}
	}

	return c.json(
		{ error: { message: `All providers failed. Last error: ${lastError}`, code: 502 } },
		502,
	);
});

/**
 * Also handle POST /v1beta/models/:modelId (without action) — default to generateContent
 */
v1betaChatRoutes.post('/models/:modelId', async (c: Context<{ Bindings: Env }>) => {
	const modelId = decodeURIComponent(c.req.param('modelId') || '').replace(/^models\//, '');
	// Redirect to generateContent behavior
	if (!modelId) {
		return c.json({ error: { message: 'Model ID is required', code: 400 } }, 400);
	}

	const body = await c.req.json().catch(() => null);
	if (!body) {
		return c.json({ error: { message: 'Invalid JSON body', code: 400 } }, 400);
	}

	const candidates = await findProviderForModel(c.env, modelId);
	if (!candidates.length) {
		return c.json(
			{ error: { message: `No enabled provider for model: ${modelId}`, code: 400 } },
			400,
		);
	}

	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const requestId = crypto.randomUUID();
	const execCtx = (c as any).executionCtx;

	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];
	for (const candidate of tryCandidates) {
		try {
			return await handleGeminiNonStream(
				body, requestId, candidate, c.env, ip, execCtx, Date.now(), modelId,
			);
		} catch (err) {
		const errMsg = err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: JSON.stringify(err);
		console.error(`Provider ${candidate.provider.id}: ${errMsg}`);
	}
	}

	return c.json(
		{ error: { message: 'All Google providers failed', code: 502 } },
		502,
	);
});
