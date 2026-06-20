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

/** JSON-escape a string for inline embedding (faster than full object stringify) */
function escJson(s: string): string {
	return JSON.stringify(s).slice(1, -1);
}

/** Convert Anthropic Messages request to OpenAI-compatible format. */
function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
	const messages: Array<Record<string, unknown>> = [];
	const sysMsg = body.system as string | Array<{ text: string; type: string }> | undefined;
	if (sysMsg) {
		const text = typeof sysMsg === 'string' ? sysMsg : sysMsg.map((b) => b.text || '').join('\n');
		if (text) messages.push({ role: 'system', content: text });
	}
	for (const msg of (body.messages as Array<Record<string, unknown>>) || []) {
		const role = String(msg.role || 'user');
		const content = msg.content;
		if (typeof content === 'string') {
			messages.push({ role, content });
		} else if (Array.isArray(content)) {
			const text = content
				.filter((b: any) => b.type === 'text' || b.type === 'tool_result')
				.map((b: any) => b.text || '')
				.join('\n');
			if (text) messages.push({ role, content: text });
		}
	}
	return {
		messages,
		max_tokens: body.max_tokens,
		temperature: body.temperature,
		top_p: body.top_p,
		stop: body.stop_sequences,
	};
}

/** Match AI SDK finishReason → Anthropic stop_reason */
function mapStopReasonOpenAI(reason: string): string {
	switch (reason) {
		case 'stop': return 'end_turn';
		case 'length': return 'max_tokens';
		case 'content_filter': return 'content_filter';
		case 'tool_calls': return 'tool_use';
		default: return 'end_turn';
	}
}

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

// ---- Direct fetch handlers (openai type only) ----

async function handleAnthropicDirectStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) baseUrl = baseUrl.replace(/\/$/, '') + '/v1';

	const upstreamBody = anthropicToOpenAI(body);
	upstreamBody.stream = true;
	(upstreamBody as any).model = rawModelId;

	const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
		body: JSON.stringify(upstreamBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
			{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
			{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) }, 0, 0, env.clientKeyName || ''));
		return new Response(errText || JSON.stringify({ error: { message: `Upstream ${upstreamResponse.status}` } }), {
			status: upstreamResponse.status,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'anthropic-version': '2023-06-01' },
		});
	}

	// Prefetch first SSE data line to detect immediate stream errors (rate limits, quota).
	// If the first chunk is an error, we throw so the failover loop can try the next provider.
	const reader = upstreamResponse.body!.getReader();
	const decoder = new TextDecoder();
	let prefetchBuf = '';
	let prefetchError: string | null = null;
	let firstDataLine: string | null = null;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			prefetchBuf += decoder.decode(value, { stream: true });

			const nlIdx = prefetchBuf.indexOf('\n');
			if (nlIdx < 0) continue;

			const line = prefetchBuf.slice(0, nlIdx);
			prefetchBuf = prefetchBuf.slice(nlIdx + 1);

			if (line.length === 0 || !line.startsWith('data:')) continue;

			firstDataLine = line;
			const json = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
			if (json !== '[DONE]') {
				try {
					const parsed = JSON.parse(json);
					if (parsed?.error) {
						prefetchError = parsed.error.message || JSON.stringify(parsed.error);
					}
				} catch { /* not valid JSON */ }
			}
			break;
		}
	} catch (err) {
		reader.releaseLock();
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, env.clientKeyName || ''));
		}
		throw err;
	}

	if (prefetchError) {
		reader.releaseLock();
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: prefetchError.slice(0, 300) },
				0, 0, env.clientKeyName || ''));
		}
		throw new Error(`Upstream stream error: ${prefetchError}`);
	}

	if (firstDataLine) {
		prefetchBuf = firstDataLine + '\n' + prefetchBuf;
	}

	const encoder = new TextEncoder();
	const msgId = generateMessageId();
	let contentIndex = 0;
	let hasStartedBlock = false;

	const stream = new ReadableStream({
		async start(controller) {
			let streamError = false;
			let streamErrorMsg = '';
			let lastInputTokens = 0;
			let lastOutputTokens = 0;

			let buf = prefetchBuf;

			// Emit message_start
			controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
				type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: rawModelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
			})}\n\n`));

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });

					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl);
						buf = buf.slice(nl + 1);
						if (!line.startsWith('data:')) continue;
						const json = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
						if (json === '[DONE]') continue;

					try {
						const parsed = JSON.parse(json);
						const choice = parsed?.choices?.[0];
						const delta = choice?.delta;
						const usage = parsed?.usage;

						// Error chunk from upstream (e.g., rate limit, quota exhausted)
						if (parsed?.error) {
							streamError = true;
							streamErrorMsg = parsed.error.message || JSON.stringify(parsed.error);
							continue;
						}

						// Usage-only chunk (choices empty, usage present — captures token counts)
						if (parsed?.usage && (!parsed?.choices || parsed.choices.length === 0)) {
							lastInputTokens = parsed.usage.prompt_tokens || 0;
							lastOutputTokens = parsed.usage.completion_tokens || 0;
						}

						// Finish event
						if (choice?.finish_reason && choice.finish_reason !== 'null' && choice.finish_reason !== null) {
								if (usage) { lastInputTokens = usage.prompt_tokens || 0; lastOutputTokens = usage.completion_tokens || 0; }
								if (hasStartedBlock) {
									controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: contentIndex - 1 })}\n\n`));
								}
								const sr = mapStopReasonOpenAI(choice.finish_reason);
								controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
									type: 'message_delta', delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: lastOutputTokens },
								})}\n\n`));
								controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`));
								continue;
							}

							const ct = delta?.content;
							if (ct != null && ct !== '') {
								if (!hasStartedBlock) {
									hasStartedBlock = true;
									controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
										type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' },
									})}\n\n`));
								}
								controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
									type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: ct },
								})}\n\n`));
							}
						} catch { /* skip */ }
					}
				}
			} catch (err) {
				streamError = true;
				streamErrorMsg = err instanceof Error ? err.message : String(err);
			} finally {
				reader.releaseLock();
				if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
					{ prompt: lastInputTokens, completion: lastOutputTokens }, !streamError, Date.now() - startMs, requestId, true,
					streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
					0, 0, env.clientKeyName || ''));
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'x-request-id': requestId, 'anthropic-version': '2023-06-01' },
	});
}

async function handleAnthropicDirectNonStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) baseUrl = baseUrl.replace(/\/$/, '') + '/v1';

	const upstreamBody = anthropicToOpenAI(body);
	(upstreamBody as any).model = rawModelId;

	const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
		body: JSON.stringify(upstreamBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
			{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
			{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) }, 0, 0, env.clientKeyName || ''));
		return new Response(errText || JSON.stringify({ error: { message: `Upstream ${upstreamResponse.status}` } }), {
			status: upstreamResponse.status, headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'anthropic-version': '2023-06-01' },
		});
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};

	if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
		{ prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
		true, Date.now() - startMs, requestId, false, {}, 0, 0, env.clientKeyName || ''));

	const sr = mapStopReasonOpenAI(choice?.finish_reason || 'stop');

	return new Response(JSON.stringify({
		id: generateMessageId(), type: 'message', role: 'assistant',
		content: [{ type: 'text', text: msg.content || '' }],
		model: rawModelId, stop_reason: sr, stop_sequence: null,
		usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
	}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'anthropic-version': '2023-06-01' } });
}

// ---- Existing AI SDK handlers (google_ai_studio / vertex_ai / anthropic) ----

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

	// Prefetch first part from AI SDK stream to detect early errors (rate limits, quota).
	// If the first part is an error, we throw so the failover loop can try the next provider.
	const streamIterator = result.fullStream[Symbol.asyncIterator]();
	let firstPart: any = null;
	let prefetchError: string | null = null;

	try {
		const { value, done } = await streamIterator.next();
		if (!done && value) {
			firstPart = value;
			if (value.type === 'error') {
				prefetchError = value.error instanceof Error
					? value.error.message
					: typeof value.error === 'string'
						? value.error
						: JSON.stringify(value.error);
			}
		}
	} catch (err) {
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, env.clientKeyName || ''));
		}
		throw err;
	}

	if (prefetchError) {
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: prefetchError.slice(0, 300) },
				0, 0, env.clientKeyName || ''));
		}
		throw new Error(`Upstream stream error: ${prefetchError}`);
	}

	// Wrap iterator to prepend the already-consumed first part seamlessly
	const parts: AsyncIterable<any> = {
		[Symbol.asyncIterator]() {
			let prefetched = firstPart === null;
			return {
				async next() {
					if (!prefetched) {
						prefetched = true;
						return { value: firstPart!, done: false };
					}
					return streamIterator.next();
				}
			};
		}
	};

	const encoder = new TextEncoder();
	const msgId = generateMessageId();
	let contentIndex = 0;
	let hasStartedBlock = false;
	let streamError = false;
	let streamErrorMsg = '';
	let lastInputTokens = 0;
	let lastOutputTokens = 0;

	// Pre-computed frame parts — updated at block boundaries
	let textDeltaPfx = '';
	let textDeltaSfx = '';
	let reasoningDeltaPfx = '';
	let reasoningDeltaSfx = '';

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

				for await (const part of parts) {
					switch (part.type) {
					case 'text-start':
						hasStartedBlock = true;
						textDeltaPfx = `event: content_block_delta\ndata: {"type":"content_block_delta","index":${contentIndex},"delta":{"type":"text_delta","text":"`;
						textDeltaSfx = `"}}\n\n`;
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
						controller.enqueue(encoder.encode(textDeltaPfx + escJson(part.text) + textDeltaSfx));
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
						streamError = true;
						streamErrorMsg = part.error instanceof Error
							? part.error.message
							: typeof part.error === 'string'
								? part.error
								: JSON.stringify(part.error);
						controller.enqueue(
							encoder.encode(
								`event: error\ndata: ${JSON.stringify({
									type: 'error',
									error: { message: streamErrorMsg, type: 'api_error' },
								})}\n\n`,
							),
						);
						break;
					}

				case 'reasoning-start':
					reasoningDeltaPfx = `event: content_block_delta\ndata: {"type":"content_block_delta","index":${contentIndex},"delta":{"type":"thinking_delta","thinking":"`;
					reasoningDeltaSfx = `"}}\n\n`;
					controller.enqueue(
						encoder.encode(
							`event: content_block_start\ndata: ${JSON.stringify({
								type: 'content_block_start',
								index: contentIndex,
								content_block: { type: 'thinking', thinking: '' },
							})}\n\n`,
						),
					);
					break;

				case 'reasoning-delta':
					controller.enqueue(encoder.encode(reasoningDeltaPfx + escJson(part.text) + reasoningDeltaSfx));
					break;

					case 'reasoning-end':
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

					case 'tool-call':
						controller.enqueue(
							encoder.encode(
								`event: content_block_start\ndata: ${JSON.stringify({
									type: 'content_block_start',
									index: contentIndex,
									content_block: {
										type: 'tool_use',
										id: part.toolCallId,
										name: part.toolName,
										input: {},
									},
								})}\n\n`,
							),
						);
						controller.enqueue(
							encoder.encode(
								`event: content_block_delta\ndata: ${JSON.stringify({
									type: 'content_block_delta',
									index: contentIndex,
									delta: {
										type: 'input_json_delta',
										partial_json: JSON.stringify(part.input),
									},
								})}\n\n`,
							),
						);
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

			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(
						env,
						provider.provider.id,
						rawModelId,
						ip,
						{ prompt: lastInputTokens, completion: lastOutputTokens },
						!streamError,
						Date.now() - startMs,
						requestId,
						true,
						streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
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
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(env, provider.provider.id, rawModelId, ip,
						{ prompt: 0, completion: 0 }, false,
						Date.now() - startMs, requestId, true,
						{ errorType: 'stream_error', errorMessage: errMsg.slice(0, 300) },
						0, 0, env.clientKeyName || '',
					),
				);
			}
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
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (/empty assistant|no content generated/i.test(msg)) {
			return null;
		}
		throw err;
	});

	if (!result) {
		return new Response(JSON.stringify({
			id: generateMessageId(),
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text: '' }],
			model: rawModelId,
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0 },
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, 'anthropic-version': '2023-06-01' },
		});
	}

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

	// Build content blocks: thinking (if any) + text + tool_use (if any)
	const content: Array<Record<string, unknown>> = [];
	if (result.reasoningText) {
		content.push({ type: 'thinking', thinking: result.reasoningText });
	}
	content.push({ type: 'text', text: result.text });
	const toolCalls = result.toolCalls;
	if (toolCalls?.length) {
		for (const tc of toolCalls) {
			content.push({
				type: 'tool_use',
				id: tc.toolCallId,
				name: tc.toolName,
				input: tc.input,
			});
		}
	}

	// Map stop reason for tool calls
	const finalStopReason = toolCalls?.length ? 'tool_use' : stopReason;

	return new Response(
		JSON.stringify({
			id: msgId,
			type: 'message',
			role: 'assistant',
			content,
			model: rawModelId,
			stop_reason: finalStopReason,
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
			const isOpenAI = candidate.provider.type === 'openai';
			const response = isStream
				? await (isOpenAI
					? handleAnthropicDirectStream(body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId)
					: handleAnthropicStream(body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId))
				: await (isOpenAI
					? handleAnthropicDirectNonStream(body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId)
					: handleAnthropicNonStream(body, requestId, candidate, c.env, ip, execCtx, startMs, rawModelId));

			if (response.status >= 400) {
				lastError = `Provider ${candidate.provider.id}: HTTP ${response.status}`;
				console.error(lastError);
				continue;
			}
			return response;
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
