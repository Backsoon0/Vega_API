// src/routes/anthropic/messages.ts
// Anthropic Messages API — native /anthropic/v1/messages endpoint
// Uses AI SDK @ai-sdk/anthropic provider, outputs Anthropic SSE format
//
// POST /anthropic/v1/messages — Anthropic Messages API (streaming + non-streaming)

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamText, generateText } from 'ai';
import type { Env } from '../../types';
import type { ProviderMatch } from '../../router';
import { findProviderForModel, getAggregatedModels } from '../../router';
import { createModelFromProvider } from '../../ai-providers';
import { recordUsage, extractCacheTokens } from '../../usage';
import { getFailoverEnabled } from '../../config';

export const anthropicMessagesRoutes = new Hono<{ Bindings: Env }>();

const MAX_BODY_SIZE = 5_242_880; // 5 MB

// ---- Helpers ----

/**
 * Convert Anthropic Messages API request to AI SDK format.
 * Anthropic: { model, messages, system, max_tokens, temperature, top_p, stop_sequences, stream }
 * AI SDK: { messages: ModelMessage[], system?: string, ... }
 */
function anthropicToAISDK(body: Record<string, unknown>): {
	messages: Array<{ role: string; content: Array<{ type: string; text?: string; data?: string; mediaType?: string }> }>;
	system?: string;
} {
	const anthropicMessages = (body.messages as Array<Record<string, unknown>>) || [];
	const systemPrompt = body.system;

	let system: string | undefined;

	if (systemPrompt) {
		system = typeof systemPrompt === 'string'
			? systemPrompt
			: (Array.isArray(systemPrompt) ? systemPrompt.map((b: any) => b.text || '').join('\n') : String(systemPrompt));
	}

	const messages: Array<{
		role: string;
		content: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
	}> = [];

	for (const msg of anthropicMessages) {
		const role = String(msg.role || 'user');
		const content = msg.content;
		if (typeof content === 'string') {
			messages.push({ role, content: [{ type: 'text', text: content }] });
		} else if (Array.isArray(content)) {
			const parts = content
				.map((block: any) => {
					if (block.type === 'text') return { type: 'text', text: String(block.text || '') };
					if (block.type === 'image') {
						return {
							type: 'file',
							data: block.source?.data || '',
							mediaType: block.source?.media_type || 'image/png',
						};
					}
					if (block.type === 'tool_use') {
						return { type: 'text', text: JSON.stringify({ tool_use: block }) };
					}
					if (block.type === 'tool_result') {
						return {
							type: 'text',
							text: JSON.stringify({ tool_result: block }),
						};
					}
					return { type: 'text', text: String(block.text || '') };
				})
				.filter((p: any) => p.type === 'text' ? (p.text?.length || 0) > 0 : true);
			if (parts.length > 0) messages.push({ role, content: parts as any });
		}
	}

	return { messages, system };
}

/**
 * Convert AI SDK finishReason to Anthropic stop_reason.
 */
function mapStopReason(reason: string): string {
	switch (reason) {
		case 'stop':
			return 'end_turn';
		case 'length':
			return 'max_tokens';
		case 'content-filter':
			return 'content_filter';
		default:
			return 'end_turn';
	}
}

/**
 * Generate a unique message ID (Anthropic-style: msg_xxx).
 */
function generateMessageId(): string {
	return 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * Build extra body headers from explicit extra_body field.
 */
function buildExtraBodyHeaders(body: Record<string, unknown>): Record<string, string> | undefined {
	if (!body.extra_body || typeof body.extra_body !== 'object') return undefined;
	return { 'X-Vega-Extra-Body': JSON.stringify(body.extra_body) };
}

// ---- Stream handler ----

async function handleAnthropicStream(
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
	const { messages, system } = anthropicToAISDK(body);

	const result = streamText({
		model,
		messages: messages as any,
		system,
		maxOutputTokens: body.max_tokens as number | undefined,
		temperature: body.temperature as number | undefined,
		topP: body.top_p as number | undefined,
		stopSequences: body.stop_sequences as string[] | undefined,
		headers: buildExtraBodyHeaders(body),
	});

	const encoder = new TextEncoder();
	const msgId = generateMessageId();
	let contentIndex = 0;
	let hasStartedBlock = false;
	let lastInputTokens = 0;
	let lastOutputTokens = 0;

	const stream = new ReadableStream({
		async start(controller) {
			try {
				// Send message_start
				controller.enqueue(
					encoder.encode(
						`event: message_start\ndata: ${JSON.stringify({
							type: 'message_start',
							message: {
								id: msgId,
								type: 'message',
								role: 'assistant',
								content: [],
								model: rawModelId,
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 0, output_tokens: 0 },
							},
						})}\n\n`,
					),
				);

				for await (const part of result.fullStream) {
					switch (part.type) {
						case 'text-start':
							hasStartedBlock = true;
							controller.enqueue(
								encoder.encode(
									`event: content_block_start\ndata: ${JSON.stringify({
										type: 'content_block_start',
										index: contentIndex,
										content_block: { type: 'text', text: '' },
									})}\n\n`,
								),
							);
							break;

						case 'text-delta':
							controller.enqueue(
								encoder.encode(
									`event: content_block_delta\ndata: ${JSON.stringify({
										type: 'content_block_delta',
										index: contentIndex,
										delta: { type: 'text_delta', text: part.text },
									})}\n\n`,
								),
							);
							break;

						case 'text-end':
							controller.enqueue(
								encoder.encode(
									`event: content_block_stop\ndata: ${JSON.stringify({
										type: 'content_block_stop',
										index: contentIndex,
									})}\n\n`,
								),
							);
							contentIndex++;
							break;

						case 'finish': {
							const stopReason = mapStopReason(part.finishReason);
							lastInputTokens = part.totalUsage?.inputTokens || 0;
							lastOutputTokens = part.totalUsage?.outputTokens || 0;
							controller.enqueue(
								encoder.encode(
									`event: message_delta\ndata: ${JSON.stringify({
										type: 'message_delta',
										delta: {
											stop_reason: stopReason,
											stop_sequence: null,
										},
										usage: { output_tokens: lastOutputTokens },
									})}\n\n`,
								),
							);
							controller.enqueue(
								encoder.encode(
									`event: message_stop\ndata: ${JSON.stringify({
										type: 'message_stop',
									})}\n\n`,
								),
							);
							break;
						}

					case 'error': {
						const errMsg = part.error instanceof Error
							? part.error.message
							: typeof part.error === 'string'
								? part.error
								: JSON.stringify(part.error);
						controller.enqueue(
							encoder.encode(
								`event: error\ndata: ${JSON.stringify({
									type: 'error',
									error: { message: errMsg, type: 'api_error' },
								})}\n\n`,
							),
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
						recordUsage(
							env,
							provider.provider.id,
							rawModelId,
							ip,
							{ prompt: lastInputTokens, completion: lastOutputTokens },
							true,
							Date.now() - startMs,
							requestId,
							true,
							{},
							cacheRead,
							cacheCreation,
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
			controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({
							type: 'error',
							error: { message: errMsg, type: 'api_error' },
						})}\n\n`,
					),
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
			'anthropic-version': '2023-06-01',
		},
	});
}

// ---- Non-streaming handler ----

async function handleAnthropicNonStream(
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
	const { messages, system } = anthropicToAISDK(body);

	const result = await generateText({
		model,
		messages: messages as any,
		system,
		maxOutputTokens: body.max_tokens as number | undefined,
		temperature: body.temperature as number | undefined,
		topP: body.top_p as number | undefined,
		stopSequences: body.stop_sequences as string[] | undefined,
		headers: buildExtraBodyHeaders(body),
	});

	const stopReason = mapStopReason(result.finishReason);
	const msgId = generateMessageId();

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
			id: msgId,
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text: result.text }],
			model: rawModelId,
			stop_reason: stopReason,
			stop_sequence: null,
			usage: {
				input_tokens: result.usage?.inputTokens || 0,
				output_tokens: result.usage?.outputTokens || 0,
			},
		}),
		{
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'x-request-id': requestId,
				'anthropic-version': '2023-06-01',
			},
		},
	);
}

// ---- Model listing (Anthropic has no standard endpoint, return OpenAI format) ----

/**
 * GET /anthropic/v1/models
 * Anthropic API doesn't have a standard model list endpoint, but clients
 * (e.g. Cherry Studio) may still try to fetch models. Return OpenAI format.
 */
anthropicMessagesRoutes.get('/v1/models', async (c: Context<{ Bindings: Env }>) => {
	const models = await getAggregatedModels(c.env);
	const clean = models.map(({ _providerId, ...rest }) => rest);
	return c.json({ object: 'list', data: clean });
});

// ---- Route ----

/**
 * POST /anthropic/v1/messages
 * Full Anthropic Messages API endpoint.
 */
anthropicMessagesRoutes.post('/v1/messages', async (c: Context<{ Bindings: Env }>) => {
	const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
	if (contentLength > MAX_BODY_SIZE) {
		return c.json(
			{ type: 'error', error: { message: `Request body too large`, type: 'invalid_request_error' } },
			413,
		);
	}

	const body = await c.req.json().catch(() => null);
	if (!body?.model) {
		return c.json(
			{ type: 'error', error: { message: 'model is required', type: 'invalid_request_error' } },
			400,
		);
	}

	const rawModelId = String(body.model).trim();
	const isStream = !!body.stream;

	const candidates: ProviderMatch[] = await findProviderForModel(c.env, rawModelId);
	if (!candidates.length) {
		return c.json(
			{
				type: 'error',
				error: { message: `No enabled provider for model: ${rawModelId}`, type: 'invalid_request_error' },
			},
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
				return await handleAnthropicStream(
					body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId,
				);
			}
			return await handleAnthropicNonStream(
				body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId,
			);
		} catch (err) {
		const errMsg = err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: JSON.stringify(err);
		lastError = `Provider ${candidate.provider.id}: ${errMsg}`;
			console.error(lastError);
		}
	}

	return c.json(
		{
			type: 'error',
			error: {
				message: `All providers failed. Last error: ${lastError}`,
				type: 'api_error',
			},
		},
		502,
	);
});
