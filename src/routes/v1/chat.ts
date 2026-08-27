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
import { createModelFromProvider, getVertexAccessToken, isVertexApiKeyMode } from '../../ai-providers';
import { recordUsage, extractCacheTokens, extractOpenAICacheTokens } from '../../usage';
import { getFailoverEnabled } from '../../config';
import { getClientKeyName } from '../../middleware/auth';
import { isProviderAllowed, recordFailure as recordCBFailure, recordSuccess as recordCBSuccess } from '../../circuit-breaker';
import { toJsonErrorBody } from '../../upstream-errors';
import { shouldUseAISDKForGoogleTools } from '../../google-tool-mode';
import { getClientIp } from '../../request-util';

export const v1ChatRoutes = new Hono<{ Bindings: Env }>();

/** Maximum request body size: 5 MB */
const MAX_BODY_SIZE = 5_242_880;

// 4xx codes that indicate a client-side problem — switching providers won't help.
// Module-scope so both the route loop and the handler functions can reference it.
const FATAL_4XX = new Set([400, 401, 403]);

// ---- Helpers ----

/**
 * Build error response headers with retry guidance for the client.
 * Passes through Retry-After from upstream, sets x-should-retry based on status.
 */
function buildErrorHeaders(
	baseHeaders: Record<string, string>,
	upstreamStatus: number,
	upstreamHeaders?: Headers,
): Record<string, string> {
	const headers: Record<string, string> = { ...baseHeaders };
	// Passthrough Retry-After from upstream (rate limit, maintenance)
	if (upstreamHeaders) {
		const retryAfter = upstreamHeaders.get('Retry-After') || upstreamHeaders.get('retry-after');
		if (retryAfter) headers['Retry-After'] = retryAfter;
	}
	// Signal client SDKs whether to retry
	if (upstreamStatus === 429 || upstreamStatus >= 500) {
		headers['x-should-retry'] = 'true';
	} else {
		headers['x-should-retry'] = 'false';
	}
	return headers;
}

/** Combine two AbortSignals — cancels when either fires. Uses AbortSignal.any when available. */
function anySignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!b) return a;
	// AbortSignal.any is available on Workers (compat date ≥ 2024)
	return AbortSignal.any([a, b]);
}

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
 * Convert OpenAI chat completions messages to AI SDK model-message format.
 *
 * OpenAI: { role, content: string | array<{ type, text/image_url }>, tool_calls?, tool_call_id? }
 * AI SDK: { role, content: string | array<TextPart|FilePart|ReasoningPart|ToolCallPart|ToolResultPart> }
 *
 * This must round-trip tool calls (assistant `tool_calls`) and tool results
 * (`role: 'tool'`) so the Google provider can replay them with a valid
 * `thoughtSignature` (or inject the `skip_thought_signature_validator` sentinel
 * for Gemini 3). Without this, Google OpenAI-compat proxies reject replayed
 * function-call history with a 400 "Function call is missing a thought_signature".
 */
function openaiToAISDKMessages(
	openaiMessages: Array<{ role: string; content: unknown; name?: string; tool_calls?: any; tool_call_id?: string; reasoning_content?: string }>,
): Array<{ role: string; content: any }> {
	// Map tool_call_id → tool name. OpenAI `tool` messages only carry the id,
	// but the AI SDK tool-result part needs the tool name (from the prior
	// assistant `tool_calls`).
	const toolNameById = new Map<string, string>();
	for (const msg of openaiMessages) {
		if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				if (tc && tc.id && tc.function?.name) toolNameById.set(tc.id, tc.function.name);
			}
		}
	}

	return openaiMessages.map((msg) => {
		// Map `developer` role (OpenAI o1/O3) → `system` (AI SDK compatible)
		const role = msg.role === 'developer' ? 'system' : msg.role;
		const content = msg.content;

		// Tool result → `tool` message with tool-result part(s).
		if (role === 'tool') {
			const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
			const toolName = toolNameById.get(toolCallId) || msg.name || 'tool';
			const text =
				typeof content === 'string' ? content
				: Array.isArray(content) ? content.map((p: any) => String(p?.text ?? '')).join('\n')
				: String(content ?? '');
			return { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: text } }] };
		}

		// Assistant message → text + tool-call parts.
		// Note: `reasoning_content` is deliberately dropped here. Prior thoughts
		// cannot be re-signed (Gemini thought_signature / Anthropic thinking
		// signature) from OpenAI-compat history, so sending them back to the
		// provider triggers a 400. The Google path strips them earlier anyway.
		if (role === 'assistant') {
			const parts: Array<any> = [];
			if (typeof content === 'string' && content.length > 0) {
				parts.push({ type: 'text', text: content });
			} else if (Array.isArray(content)) {
				for (const part of content) {
					if (part?.type === 'text') {
						if (String(part.text || '').length > 0) parts.push({ type: 'text', text: String(part.text) });
					} else if (part?.type === 'image_url') {
						const url = part.image_url?.url || '';
						let mediaType = 'image/png';
						const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);/i);
						if (match) mediaType = match[1];
						parts.push({ type: 'file', data: url, mediaType });
					}
				}
			}
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					let input: unknown = tc?.function?.arguments;
					if (typeof input === 'string') {
						try { input = JSON.parse(input); } catch { /* keep raw string */ }
					}
					parts.push({ type: 'tool-call', toolCallId: tc?.id, toolName: tc?.function?.name, input });
				}
			}
			return { role: 'assistant', content: parts };
		}

		// System / user messages.
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
		return { role, content: '' };
	});
}

/**
 * Detect whether the request replays a prior assistant tool call in its history.
 * Google's OpenAI-compat endpoint cannot round-trip those without a Gemini
 * thought signature, so such requests must go through the AI SDK provider.
 */
function hasReplayedToolCalls(body: Record<string, unknown>): boolean {
	const messages = body.messages;
	if (!Array.isArray(messages)) return false;
	return messages.some(
		(m: any) => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
	);
}

/**
 * Google OpenAI-compat rejects replayed assistant `reasoning_content` (thoughts)
 * that aren't signed with a Gemini thought signature. Strip them from the
 * message history forwarded to Google so the request isn't rejected. Tool calls
 * are preserved (the AI SDK path, used when tool calls are present, injects the
 * proper sentinel instead).
 */
function stripReasoningForGoogle(body: Record<string, unknown>): Record<string, unknown> {
	const messages = body.messages;
	if (!Array.isArray(messages)) return body;
	const cleaned = messages.map((m: any) => {
		if (m && m.role === 'assistant' && (m.reasoning_content !== undefined || m.reasoning !== undefined)) {
			const copy = { ...m };
			delete copy.reasoning_content;
			delete copy.reasoning;
			return copy;
		}
		return m;
	});
	return { ...body, messages: cleaned };
}

/**
 * Normalize thinking config for Google/Vertex into `thinking_config` with
 * `includeThoughts: true`, so the OpenAI-compat passthrough (which forwards the
 * body verbatim) and the AI SDK path both enable thinking AND surface the raw
 * reasoning text. Gemini 3.x hides the chain of thought unless includeThoughts.
 */
function normalizeGoogleThinking(body: Record<string, unknown>): Record<string, unknown> {
	const t = body.thinking as Record<string, unknown> | undefined;
	const tc = body.thinking_config as Record<string, unknown> | undefined;
	if (t && typeof t === 'object' && t.type === 'enabled') {
		const budget = typeof t.budget_tokens === 'number' ? t.budget_tokens : ((tc?.thinkingBudget as number) ?? 8192);
		return { ...body, thinking_config: { ...(tc || {}), thinkingBudget: budget, includeThoughts: true } };
	}
	if (tc && typeof tc === 'object') {
		return { ...body, thinking_config: { ...tc, includeThoughts: tc.includeThoughts ?? true } };
	}
	return body;
}

/**
 * Convert OpenAI `tools` (function definitions) to an AI SDK ToolSet so the
 * model can actually invoke tools through the AI SDK provider. OpenAI tool
 * definitions are `{ type: 'function', function: { name, description, parameters } }`;
 * the AI SDK ToolSet is `{ [name]: { description?, parameters? } }`.
 */
function openaiToolsToAISDK(tools: unknown): Record<string, { description?: string; parameters?: unknown }> | undefined {
	if (!Array.isArray(tools)) return undefined;
	const result: Record<string, { description?: string; parameters?: unknown }> = {};
	for (const t of tools) {
		if (t?.type === 'function' && t?.function?.name) {
			const fn = t.function;
			result[fn.name] = {
				description: typeof fn.description === 'string' ? fn.description : undefined,
				parameters: fn.parameters ?? undefined,
			};
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Convert OpenAI `tool_choice` to an AI SDK toolChoice so the model can be
 * told whether to call tools (or a specific one).
 *
 * OpenAI: "auto" | "none" | "required" | "any" | { type: "function", function: { name } }
 * AI SDK:  "auto" | "none" | "required" | { type: "tool", toolName }
 * (Gemini's `any` mode is expressed as AI SDK `required`; `validated` is a
 * Gemini-native mode OpenAI-compatible clients don't send.)
 */
function buildToolChoice(toolChoice: unknown): unknown {
	if (typeof toolChoice === 'string') {
		if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
		// "required" (OpenAI) and "any" (Gemini-style) both mean "force a tool call".
		if (toolChoice === 'required' || toolChoice === 'any') return 'required';
		return undefined;
	}
	if (toolChoice && typeof toolChoice === 'object') {
		const tc = toolChoice as Record<string, any>;
		if (tc.type === 'function' && tc.function?.name) return { type: 'tool', toolName: String(tc.function.name) };
		if (tc.name) return { type: 'tool', toolName: String(tc.name) };
	}
	return undefined;
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
		// Map to Google format. `includeThoughts: true` surfaces the raw reasoning
		// text so clients see the chain of thought (Gemini 3.x hides it otherwise).
		if (t.type === 'disabled') {
			opts.google = { thinkingConfig: { thinkingBudget: 0 } };
		} else if (t.type === 'enabled') {
			const budget = typeof t.budget_tokens === 'number' ? t.budget_tokens : 8192;
			opts.google = { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
		}
	}

	// Google direct format: { thinking_config: { thinkingBudget: 8192 } }
	if (body.thinking_config && typeof body.thinking_config === 'object' && body.thinking_config !== null) {
		const tc = body.thinking_config as Record<string, unknown>;
		opts.google = {
			...(opts.google || {}),
			thinkingConfig: { ...tc, includeThoughts: tc.includeThoughts ?? true },
		};
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
	skipVersioning = false,
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!skipVersioning && !baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

	const upstreamBody = { ...body };
	upstreamBody.stream = true;

	const isGoogleStudio = baseUrl.includes('generativelanguage.googleapis.com');
	const isVertexApiKey = baseUrl.includes('aiplatform.googleapis.com') && apiKey && apiKey.length < 200;
	const authHeaders: Record<string, string> = (isGoogleStudio || isVertexApiKey)
		? { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }
		: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

	// Connect timeout: 15s for TCP + TLS + headers. Cancelled once connected so
	// streaming body reads are NOT affected. Prevents hanging on unresponsive upstream.
	const connectController = new AbortController();
	const connectTimer = setTimeout(() => connectController.abort(), 15_000);
	const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: authHeaders,
		body: JSON.stringify(upstreamBody),
		signal: anySignal(connectController.signal, clientSignal),
	}).finally(() => clearTimeout(connectTimer));

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		// Record usage only on the final attempt or for definitive client errors —
		// otherwise a retried/failover request would be double-counted.
		if (execCtx && (isLastAttempt || FATAL_4XX.has(upstreamResponse.status))) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) },
				0, 0, clientKeyName,
			));
		}
		return new Response(toJsonErrorBody(errText, `Upstream ${upstreamResponse.status}`), {
			status: upstreamResponse.status,
			headers: buildErrorHeaders({ 'Content-Type': 'application/json', 'x-request-id': requestId }, upstreamResponse.status, upstreamResponse.headers),
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
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, clientKeyName));
		}
		throw err;
	}

	if (prefetchError) {
		reader.releaseLock();
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: prefetchError.slice(0, 300) },
				0, 0, clientKeyName));
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
			let lastCacheRead = 0;
			let lastCacheCreation = 0;

			// SSE heartbeat: send comment every 15s to keep connection alive
			const HEARTBEAT_MS = 15_000;
			let lastActivity = Date.now();
			const heartbeatTimer = setInterval(() => {
				if (Date.now() - lastActivity >= HEARTBEAT_MS) {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
					lastActivity = Date.now();
				}
			}, HEARTBEAT_MS);

			let buf = prefetchBuf;

			try {
				while (true) {
					// Idle timeout: if no data for 60s, upstream likely dead — abort
					const { done, value } = await Promise.race([
						reader.read(),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error('Stream idle timeout: no data for 60s')), 60_000)
						),
					]);
					if (done) break;
					lastActivity = Date.now();
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
								// Capture cache hit tokens from the usage chunk (DeepSeek etc.)
								const cache = extractOpenAICacheTokens(parsed.usage);
								if (cache.cacheReadInputTokens > 0) lastCacheRead = cache.cacheReadInputTokens;
								if (cache.cacheCreationInputTokens > 0) lastCacheCreation = cache.cacheCreationInputTokens;
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
									// Capture cache hit tokens from the finish chunk (DeepSeek etc.)
									const cache = extractOpenAICacheTokens(usage);
									if (cache.cacheReadInputTokens > 0) lastCacheRead = cache.cacheReadInputTokens;
									if (cache.cacheCreationInputTokens > 0) lastCacheCreation = cache.cacheCreationInputTokens;
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
				clearInterval(heartbeatTimer);
				reader.releaseLock();
				if (execCtx) {
					execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
						{ prompt: lastPromptTokens, completion: lastCompletionTokens },
						!streamError, Date.now() - startMs, requestId, true,
						streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
						lastCacheRead, lastCacheCreation, clientKeyName,
					));
				}
				// Circuit breaker: only count as success when the stream actually
				// completed without an internal error (mid-stream failures must not
				// reset the breaker).
				if (!streamError) recordCBSuccess(provider.provider.id);
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
	skipVersioning = false,
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!skipVersioning && !baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

		const upstreamBody = { ...body };
		delete upstreamBody.stream;

		const isGoogleStudio = baseUrl.includes('generativelanguage.googleapis.com');
		const isVertexApiKey = baseUrl.includes('aiplatform.googleapis.com') && apiKey && apiKey.length < 200;
		const authHeaders: Record<string, string> = (isGoogleStudio || isVertexApiKey)
			? { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }
			: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

		const upstreamResponse = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: authHeaders,
			body: JSON.stringify(upstreamBody),
			signal: anySignal(AbortSignal.timeout(120_000), clientSignal),
		});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		if (execCtx && (isLastAttempt || FATAL_4XX.has(upstreamResponse.status))) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
				{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) },
				0, 0, clientKeyName,
			));
		}
		return new Response(toJsonErrorBody(errText, `Upstream ${upstreamResponse.status}`), {
			status: upstreamResponse.status,
			headers: buildErrorHeaders({ 'Content-Type': 'application/json', 'x-request-id': requestId }, upstreamResponse.status, upstreamResponse.headers),
		});
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};
	// Extract cache hits from upstream usage — supports DeepSeek's
	// prompt_cache_hit_tokens, OpenAI-standard prompt_tokens_details.cached_tokens,
	// and other third-party shapes (see extractOpenAICacheTokens).
	const cache = extractOpenAICacheTokens(usage);

	if (execCtx) {
		execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
			{ prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
			true, Date.now() - startMs, requestId, false, {},
			cache.cacheReadInputTokens, cache.cacheCreationInputTokens, clientKeyName,
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
			// Surface cache hits to clients in the standard OpenAI shape. If the
			// upstream already sent prompt_tokens_details, pass it through verbatim;
			// otherwise synthesize it from the extracted cache tokens.
			...(usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
				? { prompt_tokens_details: usage.prompt_tokens_details }
				: cache.cacheReadInputTokens > 0
					? { prompt_tokens_details: { cached_tokens: cache.cacheReadInputTokens } }
					: {}),
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
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const modelId = String(body.model).trim();
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);

	const messages = openaiToAISDKMessages(
		(body.messages as Array<{ role: string; content: unknown }>) || [],
	);
	const system = extractSystem(messages);

		// Connect timeout: 15s for initial upstream connection. Cancelled on first chunk
	// so streaming body reads are NOT affected.
	const connectController = new AbortController();
	const connectTimer = setTimeout(() => connectController.abort(), 15_000);

	const result = streamText({
		model,
		messages: messages as any,
		system,
		maxOutputTokens: body.max_tokens as number | undefined,
		temperature: body.temperature as number | undefined,
		topP: body.top_p as number | undefined,
		stopSequences: (typeof body.stop === 'string' ? [body.stop] : body.stop) as string[] | undefined,
		tools: openaiToolsToAISDK(body.tools) as any,
		toolChoice: buildToolChoice(body.tool_choice) as any,
		providerOptions: buildProviderOptions(body),
		headers: undefined,
		abortSignal: anySignal(connectController.signal, clientSignal),
	});

	// Prefetch first part from AI SDK stream to detect early errors (rate limits, quota).
	// If the first part is an error, we throw so the failover loop can try the next provider.
	const streamIterator = result.fullStream[Symbol.asyncIterator]();
	let firstPart: any = null;
	let prefetchError: string | null = null;

	try {
		const { value, done } = await streamIterator.next();
		clearTimeout(connectTimer); // Connected successfully — cancel timeout
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
		clearTimeout(connectTimer); // Timeout fired or connection error
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, clientKeyName));
		}
		throw err;
	}

	if (prefetchError) {
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: prefetchError.slice(0, 300) },
				0, 0, clientKeyName));
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
			// Index for parallel tool calls within one assistant response, so two
			// calls in the same response don't collide on index 0 in the client.
			let toolCallIndex = 0;

			// SSE heartbeat: send comment every 15s to keep connection alive
			const HEARTBEAT_MS = 15_000;
			let lastActivity = Date.now();
			const heartbeatTimer = setInterval(() => {
				if (Date.now() - lastActivity >= HEARTBEAT_MS) {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
					lastActivity = Date.now();
				}
			}, HEARTBEAT_MS);

			try {
				for await (const part of parts) {
					lastActivity = Date.now();
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
							toolCallIndex = 0; // next assistant turn starts fresh
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
												index: toolCallIndex++,
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
						clientKeyName,
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
							0, 0, clientKeyName,
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
				clearInterval(heartbeatTimer);
				// Circuit breaker: only count as success when the stream completed cleanly.
				if (!streamError) recordCBSuccess(provider.provider.id);
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
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
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
		tools: openaiToolsToAISDK(body.tools) as any,
		toolChoice: buildToolChoice(body.tool_choice) as any,
		providerOptions: buildProviderOptions(body),
		headers: undefined,
		abortSignal: anySignal(AbortSignal.timeout(120_000), clientSignal),
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (/empty assistant|no content generated/i.test(msg)) {
			return null;
		}
		// Record usage only on the final attempt to avoid double-counting on retry/failover.
		if (isLastAttempt && execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, modelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
				{ errorType: 'upstream_error', errorMessage: msg.slice(0, 300) },
				0, 0, clientKeyName));
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
				clientKeyName,
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

	const ip = getClientIp(c);
	const requestId = crypto.randomUUID();
	const execCtx = (c as any).executionCtx;
	const startMs = Date.now();
	// Request-scoped values (set by clientAuthMiddleware — never the shared env)
	const clientKeyName = getClientKeyName(c.req.raw);
	const clientSignal = c.req.raw.signal;

	// Check failover config — if disabled, only try the first candidate
	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];

	// Try each candidate in weight order; fall back on failure (if failover enabled).
	// Each candidate gets up to MAX_RETRIES attempts (with exponential backoff) for transient errors.
	const MAX_RETRIES = 2;
	const BASE_RETRY_DELAY_MS = 100;

	let lastError = '';
	let fatalResponse: Response | null = null;
	for (const candidate of tryCandidates) {
		// Circuit breaker: skip providers that have failed repeatedly
		if (!isProviderAllowed(candidate.provider.id)) {
			console.warn(`Circuit breaker: skipping provider ${candidate.provider.id} (circuit open)`);
			continue;
		}

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			// Usage is only recorded for the final attempt of the final candidate
			// (retried/failover failures must not inflate usage counts).
			const isLastAttempt = attempt === MAX_RETRIES && candidate === tryCandidates[tryCandidates.length - 1];
			try {
				const type = candidate.provider.type;
				// Google/Vertex replayed tool-call history cannot round-trip Gemini
				// thought signatures through the OpenAI-compat passthrough (Google
				// rejects it with HTTP 400 "Function call is missing a
				// thought_signature"). Route those requests through the AI SDK google
				// provider, which injects the documented `skip_thought_signature_validator`
				// sentinel and round-trips tool calls correctly. Non-tool Google chats keep
				// the fast direct passthrough.
				const googleWithTools =
					(type === 'google_ai_studio' || type === 'vertex_ai') &&
					hasReplayedToolCalls(body) &&
					shouldUseAISDKForGoogleTools(c.env);
				const useDirect =
					type === 'openai' || ((type === 'google_ai_studio' || type === 'vertex_ai') && !googleWithTools);

				let directBody = body as Record<string, unknown>;
				let directProvider: ProviderMatch = candidate;
				let skipVersioning = false;

				if (type === 'google_ai_studio') {
					const cleanedModel = String(body.model).replace(/^(google\/|models\/)+/, '');
					if (useDirect) {
						skipVersioning = true;
						directBody = normalizeGoogleThinking(stripReasoningForGoogle({ ...body, model: cleanedModel }));
						directProvider = {
							...candidate,
							provider: { ...candidate.provider, config: { ...candidate.provider.config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' } },
						};
					} else {
						// AI SDK path (native Google API) — normalize model, keep original creds.
						// Strip replayed thoughts: they can't be re-signed in OpenAI format,
						// so Google rejects them (Gemini 2.5) or needs the sentinel (Gemini 3).
						directBody = normalizeGoogleThinking(stripReasoningForGoogle(body));
						directProvider = { ...candidate, matchedModel: cleanedModel, provider: candidate.provider };
					}
				} else if (type === 'vertex_ai') {
					const cfg = candidate.provider.config;
					const loc = cfg.location || 'global';
					if (useDirect) {
						skipVersioning = true;
						directBody = normalizeGoogleThinking(stripReasoningForGoogle({ ...body, model: String(body.model).startsWith('google/') ? body.model : 'google/' + body.model }));
						const vConfig: Record<string, string> = { ...cfg, baseUrl: `https://aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${loc}/endpoints/openapi` };
						if (!isVertexApiKeyMode(cfg)) {
							vConfig.apiKey = await getVertexAccessToken(cfg);
						}
						directProvider = { ...candidate, provider: { ...candidate.provider, config: vConfig } };
					} else {
						// AI SDK path (native Vertex API) — keep original config, drop `google/`/`models/` aliases.
						const cleanedModel = String(body.model).replace(/^(google\/|models\/)+/, '');
						directBody = normalizeGoogleThinking(stripReasoningForGoogle(body));
						directProvider = { ...candidate, matchedModel: cleanedModel, provider: candidate.provider };
					}
				}

				const response = isStream
					? await (useDirect
						? handleOpenAIDirectStream(directBody, requestId, directProvider, c.env, ip, execCtx, startMs, skipVersioning, clientSignal, clientKeyName, isLastAttempt)
						: handleOpenAIStream(directBody, requestId, directProvider, c.env, ip, execCtx, startMs, clientSignal, clientKeyName, isLastAttempt))
					: await (useDirect
						? handleOpenAIDirectNonStream(directBody, requestId, directProvider, c.env, ip, execCtx, startMs, skipVersioning, clientSignal, clientKeyName, isLastAttempt)
						: handleOpenAINonStream(directBody, requestId, directProvider, c.env, ip, execCtx, startMs, clientSignal, clientKeyName, isLastAttempt));

				if (response.status >= 400) {
					lastError = `Provider ${candidate.provider.id}: HTTP ${response.status}`;
					// 400/401/403: deterministic client/request error — won't be fixed by
					// switching providers, so return immediately. These are NOT a provider
					// health problem, so they must not count toward the circuit breaker
					// (otherwise a handful of bad requests would open the circuit and
					// block every later request until the cooldown elapses).
					if (FATAL_4XX.has(response.status)) {
						fatalResponse = response;
						break;
					}
					// 5xx or 429 (rate limit): server error — retry with backoff
					recordCBFailure(candidate.provider.id);
					if (attempt < MAX_RETRIES) {
						const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100;
						console.error(`${lastError} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
						await new Promise((r) => setTimeout(r, delay));
						continue;
					}
					console.error(lastError);
					break;
				}
				// Streaming success is recorded inside the stream's finally (so mid-stream
				// failures don't reset the breaker); non-stream success is final here.
				if (!isStream) recordCBSuccess(candidate.provider.id);
				return response;
			} catch (err) {
				const errMessage = err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: JSON.stringify(err);
				lastError = `Provider ${candidate.provider.id}: ${errMessage}`;
				recordCBFailure(candidate.provider.id);
				// Retry on transient network errors / stream prefetch failures
				if (attempt < MAX_RETRIES) {
					const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100;
					console.error(`${lastError} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				console.error(lastError);
				break;
			}
		}
		if (fatalResponse) return fatalResponse;
	}

	return c.json(
		{
			error: {
				message: `All providers failed for model '${modelId}'. Last error: ${lastError}`,
				type: 'server_error',
			},
		},
		502,
		{ 'x-should-retry': 'true' },
	);
});
