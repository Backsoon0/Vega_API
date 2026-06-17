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
						case 'image_url':
							return {
								type: 'file' as const,
								data: part.image_url?.url || '',
								mediaType: 'image/png',
							};
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
 * Detects thinking-related fields (Anthropic/Google formats) and maps them
 * so clients can disable thinking via `"thinking":{"type":"disabled"}` etc.
 */
function buildProviderOptions(body: Record<string, unknown>): Record<string, Record<string, any>> {
	const opts: Record<string, Record<string, any>> = {};

	if (body.thinking && typeof body.thinking === 'object' && body.thinking !== null) {
		const t = body.thinking as Record<string, unknown>;
		// Anthropic format: { thinking: { type: "disabled" } } or { thinking: { type: "enabled", budget_tokens: 4000 } }
		opts.anthropic = { thinking: t };
		// Map disabled thinking to Google format
		if (t.type === 'disabled') {
			opts.google = { thinkingConfig: { thinkingBudget: 0 } };
		}
	}

	// Google direct format: { thinking_config: { thinkingBudget: 0 } }
	if (body.thinking_config && typeof body.thinking_config === 'object' && body.thinking_config !== null) {
		opts.google = { ...(opts.google || {}), thinkingConfig: body.thinking_config };
	}

	return opts;
}

/** Fields consumed by route handling — never forwarded to downstream API */
const ROUTING_KEYS = new Set(['model', 'stream', 'stream_options']);

/**
 * Build extra body headers for AI SDK call.
 * Auto-forwards all request body fields (except routing keys) so they reach
 * the downstream API. Used for OpenAI-type providers where the AI SDK strips
 * unknown fields (e.g. DeepSeek `thinking`).
 *
 * SDK-generated body fields always take precedence over injected fields.
 */
function buildExtraBodyHeaders(body: Record<string, unknown>): Record<string, string> | undefined {
	const extra: Record<string, unknown> = {};
	for (const key of Object.keys(body)) {
		if (!ROUTING_KEYS.has(key)) {
			extra[key] = body[key];
		}
	}
	return Object.keys(extra).length > 0 ? { 'X-Vega-Extra-Body': JSON.stringify(extra) } : undefined;
}

// ---- Stream handler: AI SDK fullStream → OpenAI SSE ----

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
		headers: provider.provider.type === 'openai' ? buildExtraBodyHeaders(body) : undefined,
	});

	const encoder = new TextEncoder();
	const created = Math.floor(Date.now() / 1000);

	const stream = new ReadableStream({
		async start(controller) {
			let contentFiltered = false;
			let lastPromptTokens = 0;
			let lastCompletionTokens = 0;
			try {
				for await (const part of result.fullStream) {
					switch (part.type) {
						case 'text-delta':
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
												delta: { content: part.text },
												finish_reason: null,
											},
										],
									})}\n\n`,
								),
							);
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

						case 'error':
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({
										error: { message: String(part.error), type: 'server_error' },
									})}\n\n`,
								),
							);
							controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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

				if (execCtx && lastPromptTokens + lastCompletionTokens > 0) {
					execCtx.waitUntil(
						recordUsage(
							env,
							provider.provider.id,
							modelId,
							ip,
							{ prompt: lastPromptTokens, completion: lastCompletionTokens },
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
				if (!contentFiltered) {
					const errMsg = (err as Error).message || 'Unknown error';
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
		headers: provider.provider.type === 'openai' ? buildExtraBodyHeaders(body) : undefined,
	});

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

	return new Response(
		JSON.stringify({
			id: requestId,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant',
						content: result.text,
					},
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
			if (isStream) {
				return await handleOpenAIStream(
					body, requestId, candidate, c.env, ip, execCtx, startMs,
				);
			}
			return await handleOpenAINonStream(
				body, requestId, candidate, c.env, ip, execCtx, startMs,
			);
		} catch (err) {
			lastError = `Provider ${candidate.provider.id}: ${(err as Error).message}`;
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
						{ errorType: 'provider_error', errorMessage: (err as Error).message?.slice(0, 300) },
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
