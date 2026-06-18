// src/routes/v1/chat.ts
// OpenAI-compatible /v1/chat/completions — uses AI SDK streamText/generateText
// Supports all providers (OpenAI, Google, Vertex AI, Anthropic) with fallback
//
// POST /v1/chat/completions — streaming (stream=true) + non-streaming

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamText, generateText } from 'ai';
import type { Env } from '../../types';
import type { ProviderMatch } from '../../router';
import { findProviderForModel } from '../../router';
import { createModelFromProvider } from '../../ai-providers';
import { recordUsage, extractCacheTokens } from '../../usage';
import { getFailoverEnabled } from '../../config';

export const v1ChatRoutes = new Hono<{ Bindings: Env }>();

/** Maximum request body size: 5 MB */
const MAX_BODY_SIZE = 5_242_880;

// ---- Helpers ----

/** JSON-escape a string for inline embedding (faster than full object stringify) */
function escJson(s: string): string {
	return JSON.stringify(s).slice(1, -1);
}

/**
 * Extract system/developer message content from the messages array.
 * Removes system/developer messages in-place and returns the text.
 * The text is passed as the top-level `system` parameter to streamText.
 */
function extractSystem(messages: Array<{ role: string; content: unknown }>): string | undefined {
	const idx = messages.findIndex((m) => m.role === 'system' || m.role === 'developer');
	if (idx >= 0) {
		const sysMsg = messages.splice(idx, 1)[0];
		if (typeof sysMsg.content === 'string') return sysMsg.content;
		if (Array.isArray(sysMsg.content)) {
			return sysMsg.content
				.filter((p: any) => p.type === 'text')
				.map((p: any) => p.text)
				.join('\n');
		}
	}
	return undefined;
}

/**
 * Convert OpenAI chat completions messages to AI SDK format.
 * OpenAI: { role, content: string | array<{ type, text/image_url }> }
 * AI SDK: { role, content: string | array<{ type, text/file }> }
 */
function openaiToAISDKMessages(
	openaiMessages: Array<{ role: string; content: unknown; name?: string }>,
): Array<{ role: string; content: string | Array<{ type: string; text?: string; data?: string; mediaType?: string }> }> {
	return openaiMessages.map((msg) => {
		// Map `developer` role (OpenAI o1/O3) → `system` (AI SDK compatible)
		const role = msg.role === 'developer' ? 'system' : msg.role;
		const content = msg.content;
		if (typeof content === 'string') {
			return { role, content };
		}
		if (Array.isArray(content)) {
			const parts = content
				.map((part: any) => {
					switch (part.type) {
						case 'text':
							return { type: 'text', text: String(part.text || '') };
					case 'image_url': {
						const url = part.image_url?.url || '';
						let mediaType = 'image/png';
						const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);/i);
						if (match) mediaType = match[1];
						return {
							type: 'file' as const,
							data: url,
							mediaType,
						};
					}
						default:
							return { type: 'text' as const, text: String(part.text || '') };
					}
				})
				.filter((p) => p.type === 'text' ? (p.text?.length || 0) > 0 : true);
			return { role, content: parts };
		}
		return { role, content: String(content) };
	});
}

/**
 * Map AI SDK finishReason to OpenAI finish_reason.
 */
function mapFinishReason(reason: string): string {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'content-filter':
			return 'content_filter';
		case 'tool-calls':
			return 'tool_calls';
		default:
			return 'stop';
	}
}

/**
 * Build AI SDK providerOptions from request body.
 * Detects thinking-related fields (Anthropic/Google/OpenAI formats) and maps them
 * to provider-native options so thinking/reasoning is enabled at the API level.
 */
function buildProviderOptions(body: Record<string, unknown>): Record<string, Record<string, any>> {
	const opts: Record<string, Record<string, any>> = {};

	if (body.thinking && typeof body.thinking === 'object' && body.thinking !== null) {
		const t = body.thinking as Record<string, unknown>;
		// Anthropic format: { thinking: { type: "disabled" } } or { thinking: { type: "enabled", budget_tokens: 4000 } }
		opts.anthropic = { thinking: t };
		// Map to Google format
		if (t.type === 'disabled') {
			opts.google = { thinkingConfig: { thinkingBudget: 0 } };
		} else if (t.type === 'enabled') {
			const budget = typeof t.budget_tokens === 'number' ? t.budget_tokens : 8192;
			opts.google = { thinkingConfig: { thinkingBudget: budget } };
		}
	}

	// Google direct format: { thinking_config: { thinkingBudget: 8192 } }
	if (body.thinking_config && typeof body.thinking_config === 'object' && body.thinking_config !== null) {
		opts.google = { ...(opts.google || {}), thinkingConfig: body.thinking_config };
	}

	// OpenAI reasoning format: { reasoning_effort: "medium" }
	if (body.reasoning_effort && typeof body.reasoning_effort === 'string') {
		opts.openai = { ...(opts.openai || {}), reasoningEffort: body.reasoning_effort };
	}

	return opts;
}

// ---- Stream handler: AI SDK fullStream → OpenAI SSE ----

// ---- Direct fetch handlers (openai type only — no AI SDK overhead) ----

/**
 * Direct streaming handler for OpenAI-compatible providers.
 * Bypasses the AI SDK entirely: raw fetch + SSE passthrough with string-scan
 * reasoning remap. Eliminates the triple-layer SSE parse.
 */
async function handleOpenAIDirectStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

	const upstreamBody = { ...body };
	upstreamBody.stream = true;

	const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify(upstreamBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) },
				0, 0, env.clientKeyName || '',
			));
		}
		return new Response(errText || JSON.stringify({ error: { message: `Upstream ${upstreamResponse.status}`, type: 'server_error' } }), {
			status: upstreamResponse.status,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
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
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, env.clientKeyName || ''));
		}
		throw err;
	}

	if (prefetchError) {
		reader.releaseLock();
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
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
	const created = Math.floor(Date.now() / 1000);
	const REASONING_KEY = '"reasoning_content":"';
	const CONTENT_KEY = '"content":';

	const stream = new ReadableStream({
		async start(controller) {
			let streamError = false;
			let streamErrorMsg = '';
			let lastPromptTokens = 0;
			let lastCompletionTokens = 0;

			let buf = prefetchBuf;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });

					let nl: number;
					while ((nl = buf.indexOf('\n')) >= 0) {
						const line = buf.slice(0, nl);
						buf = buf.slice(nl + 1);

						if (!line.startsWith('data:')) {
							controller.enqueue(encoder.encode(line + '\n'));
							continue;
						}

						const json = line.slice(line.startsWith('data: ') ? 6 : 5).trim();

					if (json === '[DONE]') {
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						continue;
					}

					// Error chunk from upstream (e.g., rate limit, quota exhausted)
					if (json.indexOf('"error"') >= 0) {
						try {
							const parsed = JSON.parse(json);
							if (parsed?.error) {
								streamError = true;
								streamErrorMsg = parsed.error.message || JSON.stringify(parsed.error);
							}
						} catch { /* ignore parse errors */ }
						controller.enqueue(encoder.encode(line + '\n'));
						continue;
					}

					// Usage-only chunk (choices empty, usage present — captures token counts from chunks like {"choices":[],"usage":{...}})
					if (json.indexOf('"usage"') >= 0 && json.indexOf('"finish_reason":"') < 0) {
						try {
							const parsed = JSON.parse(json);
							if (parsed?.usage) {
								lastPromptTokens = parsed.usage.prompt_tokens || 0;
								lastCompletionTokens = parsed.usage.completion_tokens || 0;
							}
						} catch { /* ignore parse errors */ }
					}

					// Finish event: extract usage, rewrite with our id/created/model
					if (json.indexOf('"finish_reason":"') >= 0) {
							try {
								const parsed = JSON.parse(json);
								const usage = parsed?.usage;
								if (usage) {
									lastPromptTokens = usage.prompt_tokens || 0;
									lastCompletionTokens = usage.completion_tokens || 0;
								}
								const fr = parsed?.choices?.[0]?.finish_reason || 'stop';
								const finishReason = fr === 'stop' ? 'stop' : fr === 'length' ? 'length'
									: fr === 'tool_calls' ? 'tool_calls' : fr === 'content_filter' ? 'content_filter' : 'stop';
								controller.enqueue(encoder.encode(
									`data: ${JSON.stringify({
										id: requestId, object: 'chat.completion.chunk', created, model: modelId,
										choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
										usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
									})}\n\n`,
								));
								controller.enqueue(encoder.encode('data: [DONE]\n\n'));
							} catch { /* ignore parse errors */ }
							continue;
						}

					// Rare: reasoning + content in same delta chunk → split into two events
					const rcIdx = json.indexOf(REASONING_KEY);
					if (rcIdx >= 0 && json.indexOf(CONTENT_KEY, rcIdx + REASONING_KEY.length) >= 0) {
						try {
							const parsed = JSON.parse(json);
							const delta = parsed?.choices?.[0]?.delta;
							if (delta && delta.reasoning_content != null && delta.reasoning_content !== '') {
								const rc = delta.reasoning_content;
								const contentVal = delta.content;
								delete delta.reasoning_content;
								delete delta.content;
								// Reasoning chunk: inherit upstream metadata, replace delta
								if (rc) {
									const rChunk = JSON.parse(json);
									rChunk.choices[0].delta = { reasoning_content: rc };
									controller.enqueue(encoder.encode(`data: ${JSON.stringify(rChunk)}\n\n`));
								}
								// Content chunk: original delta with only content
								if (contentVal != null && contentVal !== '') {
									delta.content = contentVal;
									controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
								}
							}
						} catch { /* skip */ }
						continue;
					}

						// Normal chunk: pass through unchanged (content, reasoning, tool calls — all native)
						controller.enqueue(encoder.encode(line + '\n'));
					}
				}
			} catch (err) {
				streamError = true;
				streamErrorMsg = err instanceof Error ? err.message : String(err);
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: streamErrorMsg, type: 'server_error' } })}\n\n`));
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			} finally {
				reader.releaseLock();
				if (execCtx) {
					execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
						{ prompt: lastPromptTokens, completion: lastCompletionTokens },
						!streamError, Date.now() - startMs, requestId, true,
						streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
						0, 0, env.clientKeyName || '',
					));
				}
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-request-id': requestId },
	});
}

/**
 * Direct non-streaming handler for OpenAI-compatible providers.
 */
async function handleOpenAIDirectNonStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

	const upstreamBody = { ...body };
	delete upstreamBody.stream;

	const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify(upstreamBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		if (execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
				{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) },
				0, 0, env.clientKeyName || '',
			));
		}
		return new Response(errText || JSON.stringify({ error: { message: `Upstream ${upstreamResponse.status}` } }), {
			status: upstreamResponse.status,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		});
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};

	if (execCtx) {
		execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
			{ prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
			true, Date.now() - startMs, requestId, false, {},
			0, 0, env.clientKeyName || '',
		));
	}

	const message: Record<string, unknown> = {
		role: 'assistant',
		content: msg.content || null,
	};
	if (msg.reasoning_content) {
		message.reasoning_content = msg.reasoning_content;
	}
	if (msg.tool_calls?.length) {
		message.tool_calls = msg.tool_calls;
	}

	const fr = choice?.finish_reason || 'stop';
	const finishReason = fr === 'stop' ? 'stop' : fr === 'length' ? 'length'
		: fr === 'tool_calls' ? 'tool_calls' : fr === 'content_filter' ? 'content_filter' : 'stop';

	return new Response(JSON.stringify({
		id: requestId,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: modelId,
		choices: [{ index: 0, message, finish_reason: finishReason }],
		usage: {
			prompt_tokens: usage.prompt_tokens || 0,
			completion_tokens: usage.completion_tokens || 0,
			total_tokens: usage.total_tokens || 0,
		},
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
	});
}

// ---- AI SDK stream handler ----

async function handleOpenAIStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);

	const messages = openaiToAISDKMessages(
		(body.messages as Array<{ role: string; content: unknown }>) || [],
	);
	const system = extractSystem(messages);

	const result = streamText({
		model,
		messages: messages as any,
		system,
		maxOutputTokens: body.max_tokens as number | undefined,
		temperature: body.temperature as number | undefined,
		topP: body.top_p as number | undefined,
		stopSequences: (typeof body.stop === 'string' ? [body.stop] : body.stop) as string[] | undefined,
		providerOptions: buildProviderOptions(body),
		headers: undefined,
	});

	const encoder = new TextEncoder();
	const created = Math.floor(Date.now() / 1000);

	// Pre-compute constant SSE frame parts
	const chunkPfx = `data: {"id":"${requestId}","object":"chat.completion.chunk","created":${created},"model":"${escJson(modelId)}","choices":[{"index":0,"delta":{"content":"`;
	const chunkSfx = `"},"finish_reason":null}]}\n\n`;
	const reasoningPfx = `data: {"id":"${requestId}","object":"chat.completion.chunk","created":${created},"model":"${escJson(modelId)}","choices":[{"index":0,"delta":{"reasoning_content":"`;
	const reasoningSfx = `"},"finish_reason":null}]}\n\n`;

	const stream = new ReadableStream({
		async start(controller) {
			let contentFiltered = false;
			let streamError = false;
			let streamErrorMsg = '';
			let lastPromptTokens = 0;
			let lastCompletionTokens = 0;
			try {
				for await (const part of result.fullStream) {
					switch (part.type) {
				case 'text-delta':
					controller.enqueue(encoder.encode(chunkPfx + escJson(part.text) + chunkSfx));
					break;

						case 'finish': {
							const finishReason = mapFinishReason(part.finishReason);
							contentFiltered = part.finishReason === 'content-filter';
							lastPromptTokens = part.totalUsage?.inputTokens || 0;
							lastCompletionTokens = part.totalUsage?.outputTokens || 0;
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({
										id: requestId,
										object: 'chat.completion.chunk',
										created,
										model: modelId,
										choices: [
											{
												index: 0,
												delta: {},
												finish_reason: finishReason,
											},
										],
										usage: {
											prompt_tokens: lastPromptTokens,
											completion_tokens: lastCompletionTokens,
											total_tokens: part.totalUsage?.totalTokens || 0,
										},
									})}\n\n`,
								),
							);
							controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
								`data: ${JSON.stringify({
									error: { message: streamErrorMsg, type: 'server_error' },
								})}\n\n`,
							),
						);
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						break;
					}

				case 'reasoning-delta':
					controller.enqueue(encoder.encode(reasoningPfx + escJson(part.text) + reasoningSfx));
					break;

					case 'tool-call':
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({
									id: requestId,
									object: 'chat.completion.chunk',
									created,
									model: modelId,
									choices: [{
										index: 0,
										delta: {
											tool_calls: [{
												index: 0,
												id: part.toolCallId,
												type: 'function',
												function: {
													name: part.toolName,
													arguments: JSON.stringify(part.input),
												},
											}],
										},
										finish_reason: null,
									}],
								})}\n\n`,
							),
						);
						break;
					}
				}

				// Extract cache tokens from provider metadata (available after stream)
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
						modelId,
						ip,
						{ prompt: lastPromptTokens, completion: lastCompletionTokens },
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
			if (!contentFiltered) {
				const errMsg = err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: JSON.stringify(err);
				if (execCtx) {
					execCtx.waitUntil(
						recordUsage(env, provider.provider.id, modelId, ip,
							{ prompt: 0, completion: 0 }, false,
							Date.now() - startMs, requestId, true,
							{ errorType: 'stream_error', errorMessage: errMsg.slice(0, 300) },
							0, 0, env.clientKeyName || '',
						),
					);
				}
				controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								error: { message: errMsg, type: 'server_error' },
							})}\n\n`,
						),
					);
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				}
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

// ---- Non-streaming handler ----

async function handleOpenAINonStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);

	const messages = openaiToAISDKMessages(
		(body.messages as Array<{ role: string; content: unknown }>) || [],
	);
	const system = extractSystem(messages);

	const result = await generateText({
		model,
		messages: messages as any,
		system,
		maxOutputTokens: body.max_tokens as number | undefined,
		temperature: body.temperature as number | undefined,
		topP: body.top_p as number | undefined,
		stopSequences: (typeof body.stop === 'string' ? [body.stop] : body.stop) as string[] | undefined,
		providerOptions: buildProviderOptions(body),
		headers: undefined,
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (/empty assistant|no content generated/i.test(msg)) {
			return null;
		}
		throw err;
	});

	if (!result) {
		return new Response(JSON.stringify({
			id: requestId,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		});
	}

	const finishReason = mapFinishReason(result.finishReason);

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
				modelId,
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

	// Build message with optional reasoning and tool_calls
	const message: Record<string, unknown> = {
		role: 'assistant',
		content: result.text || null,
	};
	if (result.reasoningText) {
		message.reasoning_content = result.reasoningText;
	}
	const toolCalls = result.toolCalls;
	if (toolCalls?.length) {
		message.tool_calls = toolCalls.map((tc) => ({
			id: tc.toolCallId,
			type: 'function',
			function: {
				name: tc.toolName,
				arguments: JSON.stringify(tc.input),
			},
		}));
	}

	return new Response(
		JSON.stringify({
			id: requestId,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: 0,
					message,
					finish_reason: finishReason,
				},
			],
			usage: {
				prompt_tokens: result.usage?.inputTokens || 0,
				completion_tokens: result.usage?.outputTokens || 0,
				total_tokens: result.usage?.totalTokens || 0,
			},
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		},
	);
}

// ---- Route ----

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions using AI SDK.
 * Supports all provider types (OpenAI, Google, Vertex AI, Anthropic).
 */
v1ChatRoutes.post('/chat/completions', async (c: Context<{ Bindings: Env }>) => {
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
	const isStream = !!body.stream;

	const candidates: ProviderMatch[] = await findProviderForModel(c.env, modelId);
	if (!candidates.length) {
		return c.json(
			{ error: { message: `No enabled provider for model: ${modelId}`, type: 'invalid_request_error' } },
			400,
		);
	}

	const ip = c.req.header('CF-Connecting-IP') || 'unknown';
	const requestId = crypto.randomUUID();
	const execCtx = (c as any).executionCtx;
	const startMs = Date.now();

	// Check failover config — if disabled, only try the first candidate
	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];

	// Try each candidate in weight order; fall back on failure (if failover enabled)
	let lastError = '';
	for (const candidate of tryCandidates) {
		try {
			const isOpenAI = candidate.provider.type === 'openai';
			if (isStream) {
				return await (isOpenAI
					? handleOpenAIDirectStream(body, requestId, candidate, c.env, ip, execCtx, startMs)
					: handleOpenAIStream(body, requestId, candidate, c.env, ip, execCtx, startMs));
			}
			return await (isOpenAI
				? handleOpenAIDirectNonStream(body, requestId, candidate, c.env, ip, execCtx, startMs)
				: handleOpenAINonStream(body, requestId, candidate, c.env, ip, execCtx, startMs));
		} catch (err) {
		const errMessage = err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: JSON.stringify(err);
		lastError = `Provider ${candidate.provider.id}: ${errMessage}`;
			console.error(lastError);
			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(
						c.env,
						candidate.provider.id,
						modelId,
						ip,
						{ prompt: 0, completion: 0 },
						false,
						Date.now() - startMs,
						requestId,
						isStream,
						{ errorType: 'provider_error', errorMessage: errMessage.slice(0, 300) },
						0, 0,
						c.env.clientKeyName || '',
					),
				);
			}
		}
	}

	// All providers failed
	if (execCtx) {
		execCtx.waitUntil(
			recordUsage(
				c.env,
				'unknown',
				modelId,
				ip,
				{ prompt: 0, completion: 0 },
				false,
				0,
				requestId,
				isStream,
				{ errorType: 'all_providers_failed', errorMessage: lastError.slice(0, 300) },
				0, 0,
				c.env.clientKeyName || '',
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
