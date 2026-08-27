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
import { createModelFromProvider, getVertexAccessToken, isVertexApiKeyMode } from '../../ai-providers';
import { recordUsage, extractCacheTokens } from '../../usage';
import { getFailoverEnabled } from '../../config';
import { getClientKeyName } from '../../middleware/auth';
import { isProviderAllowed, recordFailure as recordCBFailure, recordSuccess as recordCBSuccess } from '../../circuit-breaker';
import { toJsonErrorBody } from '../../upstream-errors';
import { shouldUseAISDKForGoogleTools } from '../../google-tool-mode';

export const v1betaChatRoutes = new Hono<{ Bindings: Env }>();

const MAX_BODY_SIZE = 5_242_880; // 5 MB

// 4xx codes that indicate a client-side problem — switching providers won't help.
// Module-scope so both the route loop and the handler functions can reference it.
const FATAL_4XX = new Set([400, 401, 403]);

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
	if (upstreamHeaders) {
		const retryAfter = upstreamHeaders.get('Retry-After') || upstreamHeaders.get('retry-after');
		if (retryAfter) headers['Retry-After'] = retryAfter;
	}
	if (upstreamStatus === 429 || upstreamStatus >= 500) {
		headers['x-should-retry'] = 'true';
	} else {
		headers['x-should-retry'] = 'false';
	}
	return headers;
}

/** Combine two AbortSignals — cancels when either fires. */
function anySignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!b) return a;
	return AbortSignal.any([a, b]);
}

// ---- Helpers ----

/** JSON-escape a string for inline embedding (faster than full object stringify) */
function escJson(s: string): string {
	return JSON.stringify(s).slice(1, -1);
}

/** Safely decode a URI component (malformed % sequences must not throw → 500). */
function safeDecodeURIComponent(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * OpenAI tool-call arguments arrive as a JSON *string*; Gemini's functionCall.args
 * must be an *object*. Parse when possible, keep the raw value as a fallback.
 */
function parseFunctionArgs(args: unknown): unknown {
	if (typeof args !== 'string') return args;
	try {
		return JSON.parse(args);
	} catch {
		return args;
	}
}

/** Convert Gemini generateContent request body to OpenAI-compatible format. */
function geminiToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
	const messages: Array<Record<string, unknown>> = [];
	const si = body.systemInstruction as { parts?: Array<{ text: string }> } | undefined;
	if (si?.parts?.length) {
		const text = si.parts.map((p) => p.text || '').join('\n');
		if (text) messages.push({ role: 'system', content: text });
	}

	// Match functionResponse → functionCall by name (Gemini has no call ids).
	let callSeq = 0;
	const pendingByName = new Map<string, string>();

	for (const c of (body.contents as Array<Record<string, unknown>>) || []) {
		const role = c.role === 'model' ? 'assistant' : String(c.role || 'user');
		const parts = (c.parts as Array<Record<string, unknown>>) || [];
		const textParts: string[] = [];
		const toolCalls: Array<Record<string, unknown>> = [];
		const toolResults: Array<Record<string, unknown>> = [];
		for (const p of parts as Array<any>) {
			if (p.thought) continue;
			if (p.functionCall) {
				const id = `call_${++callSeq}`;
				const name = p.functionCall.name;
				pendingByName.set(name, id);
				toolCalls.push({
					id,
					type: 'function',
					function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
				});
			} else if (p.functionResponse) {
				const name = p.functionResponse.name;
				const id = pendingByName.get(name) || `call_${++callSeq}`;
				const resp = p.functionResponse.response;
				toolResults.push({
					role: 'tool',
					tool_call_id: id,
					content: typeof resp === 'string' ? resp : JSON.stringify(resp ?? {}),
				});
			} else if (typeof p.text === 'string' && p.text.length > 0) {
				textParts.push(p.text);
			}
		}
		if (textParts.length > 0 || toolCalls.length > 0) {
			const msg: Record<string, unknown> = { role, content: textParts.join('\n') || null };
			if (toolCalls.length > 0) msg.tool_calls = toolCalls;
			messages.push(msg);
		}
		for (const tr of toolResults) messages.push(tr);
	}

	const gc = body.generationConfig as Record<string, unknown> | undefined;
	return {
		messages,
		max_tokens: gc?.maxOutputTokens,
		temperature: gc?.temperature,
		top_p: gc?.topP,
		stop: gc?.stopSequences,
	};
}

/**
 * Convert Gemini generateContent request to AI SDK model-message format.
 *
 * Handles native Gemini functionCall / functionResponse parts so tools round-trip
 * through the AI SDK Google provider (which injects the Gemini-3
 * `skip_thought_signature_validator` sentinel for replayed function calls).
 * Thought parts (`thought: true`) are dropped — they can't be re-signed in this
 * path. functionCall/functionResponse are matched by name, since native Gemini
 * has no call ids.
 */
function geminiToAISDK(body: Record<string, unknown>): {
	messages: Array<{ role: string; content: any }>;
	system?: string;
} {
	const contents = (body.contents as Array<Record<string, unknown>>) || [];
	const systemInstruction = body.systemInstruction as { parts?: Array<{ text: string }> } | undefined;

	const messages: Array<{ role: string; content: any }> = [];
	if (systemInstruction?.parts) {
		messages.push({
			role: 'system',
			content: [{ type: 'text', text: systemInstruction.parts.map((p) => p.text).join('\n') }],
		});
	}

	// Build a synthetic id per functionCall and match functionResponse by name
	// (Gemini uses the same name to pair a call with its result).
	let callSeq = 0;
	const pendingByName = new Map<string, string[]>();

	const toolResult = (fr: { name: string; response?: unknown }) => {
		const arr = pendingByName.get(fr.name);
		const toolCallId = (arr && arr.length ? arr.shift() : `${fr.name}_${++callSeq}`) || '';
		const resp = fr.response;
		const text = typeof resp === 'string' ? resp : JSON.stringify(resp ?? {});
		return { type: 'tool-result', toolCallId, toolName: fr.name, output: { type: 'text', value: text } };
	};

	for (const c of contents) {
		const parts = (c.parts as Array<Record<string, unknown>>) || [];
		const rawRole = String(c.role || 'user');

		if (rawRole === 'model') {
			const content: any[] = [];
			for (const p of parts) {
				if (p.thought) continue; // reasoning can't be re-signed
				const fc = p.functionCall as any;
				if (fc && fc.name) {
					const name = fc.name;
					const callId = `${name}_${++callSeq}`;
					const arr = pendingByName.get(name) || [];
					arr.push(callId);
					pendingByName.set(name, arr);
					content.push({ type: 'tool-call', toolCallId: callId, toolName: name, input: fc.args ?? {} });
				} else if (typeof p.text === 'string' && p.text.length > 0) {
					content.push({ type: 'text', text: p.text });
				}
			}
			if (content.length > 0) messages.push({ role: 'assistant', content });
		} else if (rawRole === 'function' || rawRole === 'tool') {
			const content: any[] = [];
			for (const p of parts) {
				const fr = p.functionResponse as any;
				if (fr && fr.name) content.push(toolResult(fr));
			}
			if (content.length > 0) messages.push({ role: 'tool', content });
		} else {
			// user: may carry text and/or functionResponse parts (Gemini packs the
			// tool result into a user message). Split them into separate messages.
			const textParts: any[] = [];
			const resultParts: any[] = [];
			for (const p of parts) {
				const fr = p.functionResponse as any;
				if (fr && fr.name) resultParts.push(toolResult(fr));
				else if (typeof p.text === 'string' && p.text.length > 0) textParts.push({ type: 'text', text: p.text });
			}
			if (textParts.length > 0) messages.push({ role: 'user', content: textParts });
			if (resultParts.length > 0) messages.push({ role: 'tool', content: resultParts });
		}
	}

	return { messages };
}

/**
 * Convert native Gemini tool declarations to an AI SDK ToolSet so the model can
 * invoke tools through the AI SDK provider.
 * Gemini: { tools: [{ functionDeclarations: [{ name, description, parameters }] }] }
 */
function geminiToolsToAISDK(tools: unknown): Record<string, { description?: string; parameters?: unknown }> | undefined {
	if (!Array.isArray(tools)) return undefined;
	const result: Record<string, { description?: string; parameters?: unknown }> = {};
	for (const block of tools) {
		for (const fd of (block?.functionDeclarations as Array<any>) || []) {
			if (fd?.name) result[fd.name] = {
				description: typeof fd.description === 'string' ? fd.description : undefined,
				parameters: fd.parameters ?? undefined,
			};
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Detect whether the native Gemini request replays a prior assistant function
 * call in its history (which carries a Gemini thought_signature requirement).
 */
function hasGeminiToolCalls(body: Record<string, unknown>): boolean {
	const contents = body.contents;
	if (!Array.isArray(contents)) return false;
	return contents.some((c: any) =>
		Array.isArray(c?.parts) && c.parts.some((p: any) => !!(p && p.functionCall)),
	);
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

// ---- Direct fetch handlers (openai type only) ----

async function handleGeminiDirectStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
	altSse: boolean,
	skipVersioning = false,
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!skipVersioning && !baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

	const upstreamBody = geminiToOpenAI(body);
	upstreamBody.stream = true;
	(upstreamBody as any).model = rawModelId;

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
		if (execCtx && (isLastAttempt || FATAL_4XX.has(upstreamResponse.status))) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
			{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
			{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) }, 0, 0, clientKeyName));
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
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, clientKeyName));
		}
		throw err;
	}

	if (prefetchError) {
		reader.releaseLock();
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
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
	const ssePfx = altSse ? 'data: ' : '';
	const sseSfx = altSse ? '\n\n' : '\n';

	const stream = new ReadableStream({
		async start(controller) {
			let fullText = '';
			let streamError = false;
			let streamErrorMsg = '';
			let lastInputTokens = 0;
			let lastOutputTokens = 0;

			// SSE heartbeat: send comment every 15s to keep connection alive.
			// Only in SSE mode — a bare comment line would corrupt NDJSON output.
			const HEARTBEAT_MS = 15_000;
			let lastActivity = Date.now();
			const heartbeatTimer = setInterval(() => {
				if (altSse && Date.now() - lastActivity >= HEARTBEAT_MS) {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
					lastActivity = Date.now();
				}
			}, HEARTBEAT_MS);

			let buf = prefetchBuf;

			try {
				while (true) {
					const { done, value } = await Promise.race([
						reader.read(),
						new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Stream idle timeout: no data for 60s')), 60_000)),
					]);
					if (done) break;
					lastActivity = Date.now();
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
							controller.enqueue(encoder.encode(ssePfx + JSON.stringify({ error: { message: streamErrorMsg, code: 429 } }) + sseSfx));
							continue;
						}

						// Usage-only chunk (choices empty, usage present — captures token counts)
						if (parsed?.usage && (!parsed?.choices || parsed.choices.length === 0)) {
							lastInputTokens = parsed.usage.prompt_tokens || 0;
							lastOutputTokens = parsed.usage.completion_tokens || 0;
						}

						if (choice?.finish_reason && choice.finish_reason !== 'null' && choice.finish_reason !== null) {
								if (usage) { lastInputTokens = usage.prompt_tokens || 0; lastOutputTokens = usage.completion_tokens || 0; }
								const fr = choice.finish_reason;
								const finishReason = fr === 'stop' ? 'STOP' : fr === 'length' ? 'MAX_TOKENS'
									: fr === 'tool_calls' ? 'STOP' : fr === 'content_filter' ? 'SAFETY' : 'STOP';
								controller.enqueue(encoder.encode(ssePfx + JSON.stringify(buildGeminiChunk(fullText, finishReason, {
									inputTokens: lastInputTokens, outputTokens: lastOutputTokens,
									totalTokens: usage?.total_tokens || lastInputTokens + lastOutputTokens,
								})) + sseSfx));
								continue;
							}

							const ct = delta?.content;
							if (ct != null && ct !== '') { fullText += ct; controller.enqueue(encoder.encode(ssePfx + JSON.stringify(buildGeminiChunk(fullText)) + sseSfx)); }

							// reasoning_content must NOT be merged into the visible text output —
							// accumulating it corrupts the final answer. Drop thinking deltas
							// entirely (consistent with the AI SDK path, which also ignores them).

							if (delta?.tool_calls?.length) {
								for (const tc of delta.tool_calls) {
									const fc = tc.function || tc;
									controller.enqueue(encoder.encode(ssePfx + JSON.stringify({
										candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: fc.name, args: parseFunctionArgs(fc.arguments) } }] }, index: 0, safetyRatings: [] }],
									}) + sseSfx));
								}
							}
						} catch { /* skip */ }
					}
				}
			} catch (err) {
				streamError = true;
				streamErrorMsg = err instanceof Error ? err.message : String(err);
				controller.enqueue(encoder.encode(ssePfx + JSON.stringify({ error: { message: streamErrorMsg, code: 500 } }) + sseSfx));
			} finally {
				clearInterval(heartbeatTimer);
				reader.releaseLock();
				if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
					{ prompt: lastInputTokens, completion: lastOutputTokens }, !streamError, Date.now() - startMs, requestId, true,
					streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
					0, 0, clientKeyName));
				// Circuit breaker: only count as success when the stream completed cleanly.
				if (!streamError) recordCBSuccess(provider.provider.id);
				controller.close();
			}
		},
	});

	return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'x-request-id': requestId } });
}

async function handleGeminiDirectNonStream(
	body: Record<string, unknown>,
	requestId: string,
	provider: ProviderMatch,
	env: Env,
	ip: string,
	execCtx: ExecutionContext | undefined,
	startMs: number,
	rawModelId: string,
	skipVersioning = false,
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!skipVersioning && !baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) baseUrl = baseUrl.replace(/\/$/, '') + '/v1';

	const upstreamBody = geminiToOpenAI(body);
	(upstreamBody as any).model = rawModelId;

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
		if (execCtx && (isLastAttempt || FATAL_4XX.has(upstreamResponse.status))) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
			{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
			{ errorType: 'upstream_error', errorMessage: errText.slice(0, 300) }, 0, 0, clientKeyName));
		return new Response(toJsonErrorBody(errText, `Upstream ${upstreamResponse.status}`), {
			status: upstreamResponse.status, headers: buildErrorHeaders({ 'Content-Type': 'application/json', 'x-request-id': requestId }, upstreamResponse.status, upstreamResponse.headers),
		});
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};

	if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
		{ prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
		true, Date.now() - startMs, requestId, false, {}, 0, 0, clientKeyName));

	const fr = choice?.finish_reason || 'stop';
	const finishReason = fr === 'stop' ? 'STOP' : fr === 'length' ? 'MAX_TOKENS'
		: fr === 'tool_calls' ? 'STOP' : fr === 'content_filter' ? 'SAFETY' : 'STOP';

	const parts: Array<Record<string, unknown>> = [{ text: msg.content || '' }];
	if (msg.tool_calls?.length) for (const tc of msg.tool_calls) parts.push({ functionCall: { name: (tc.function || tc).name, args: parseFunctionArgs((tc.function || tc).arguments) } });

	return new Response(JSON.stringify({
		candidates: [{ content: { role: 'model', parts }, finishReason, index: 0, safetyRatings: [] }],
		usageMetadata: { promptTokenCount: usage.prompt_tokens || 0, candidatesTokenCount: usage.completion_tokens || 0, totalTokenCount: usage.total_tokens || 0 },
	}), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': requestId } });
}

// ---- Existing AI SDK handlers (google_ai_studio / vertex_ai / anthropic) ----
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
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
): Promise<Response> {
	const model = createModelFromProvider(provider.provider, env, provider.matchedModel);
	const { messages } = geminiToAISDK(body);
	const genConfig = body.generationConfig as Record<string, unknown> | undefined;

	const connectController = new AbortController();
	const connectTimer = setTimeout(() => connectController.abort(), 15_000);

	const result = streamText({
		model,
		messages: messages as any,
		maxOutputTokens: genConfig?.maxOutputTokens as number | undefined,
		temperature: genConfig?.temperature as number | undefined,
		topP: genConfig?.topP as number | undefined,
		stopSequences: (genConfig?.stopSequences as string[]) || undefined,
		tools: geminiToolsToAISDK(body.tools) as any,
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
		clearTimeout(connectTimer);
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
		clearTimeout(connectTimer);
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, true,
				{ errorType: 'stream_error', errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
				0, 0, clientKeyName));
		}
		throw err;
	}

	if (prefetchError) {
		if (execCtx && isLastAttempt) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
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
	let fullText = '';
	let streamError = false;
	let streamErrorMsg = '';
	let lastInputTokens = 0;
	let lastOutputTokens = 0;

	// Pre-compute Gemini chunk JSON frame parts (text prefix/suffix are constant)
	const geminiTextPfx = `{"candidates":[{"content":{"role":"model","parts":[{"text":"`;
	const geminiTextSfx = `"}]},"index":0,"safetyRatings":[]}]}`;
	const ssePfx = altSse ? 'data: ' : '';
	const sseSfx = altSse ? '\n\n' : '\n';

	const stream = new ReadableStream({
		async start(controller) {
			// SSE heartbeat: send comment every 15s to keep connection alive.
			// Only in SSE mode — a bare comment line would corrupt NDJSON output.
			const HEARTBEAT_MS = 15_000;
			let lastActivity = Date.now();
			const heartbeatTimer = setInterval(() => {
				if (altSse && Date.now() - lastActivity >= HEARTBEAT_MS) {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
					lastActivity = Date.now();
				}
			}, HEARTBEAT_MS);

			try {
				for await (const part of parts) {
					lastActivity = Date.now();
					switch (part.type) {
					case 'text-delta':
						fullText += part.text;
						controller.enqueue(
							encoder.encode(ssePfx + geminiTextPfx + escJson(fullText) + geminiTextSfx + sseSfx),
						);
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
						streamError = true;
						streamErrorMsg = part.error instanceof Error
							? part.error.message
							: typeof part.error === 'string'
								? part.error
								: JSON.stringify(part.error);
						const chunk = JSON.stringify({ error: { message: streamErrorMsg, code: 500 } });
							controller.enqueue(
								encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
							);
							break;
						}

					case 'tool-call': {
						const toolResp: Record<string, unknown> = {
							candidates: [{
								content: {
									role: 'model',
									parts: [{ functionCall: { name: part.toolName, args: part.input } }],
								},
								index: 0,
								safetyRatings: [],
							}],
						};
						const toolChunk = JSON.stringify(toolResp);
						controller.enqueue(
							encoder.encode(altSse ? `data: ${toolChunk}\n\n` : `${toolChunk}\n`),
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

			if (execCtx) {
				execCtx.waitUntil(
					recordUsage(env, provider.provider.id, rawModelId, ip,
						{ prompt: lastInputTokens, completion: lastOutputTokens },
						!streamError, Date.now() - startMs, requestId, true,
						streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
						cacheRead, cacheCreation,
						clientKeyName,
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
						0, 0, clientKeyName,
					),
				);
			}
			const chunk = JSON.stringify({ error: { message: errMsg, code: 500 } });
				controller.enqueue(
					encoder.encode(altSse ? `data: ${chunk}\n\n` : `${chunk}\n`),
				);
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
	clientSignal: AbortSignal,
	clientKeyName: string,
	isLastAttempt: boolean,
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
		tools: geminiToolsToAISDK(body.tools) as any,
		headers: undefined,
		abortSignal: anySignal(AbortSignal.timeout(120_000), clientSignal),
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (/empty assistant|no content generated/i.test(msg)) {
			return null;
		}
		// Record usage only on the final attempt to avoid double-counting on retry/failover.
		if (isLastAttempt && execCtx) {
			execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
				{ prompt: 0, completion: 0 }, false, Date.now() - startMs, requestId, false,
				{ errorType: 'upstream_error', errorMessage: msg.slice(0, 300) },
				0, 0, clientKeyName));
		}
		throw err;
	});

	if (!result) {
		return new Response(JSON.stringify({
			candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0, safetyRatings: [] }],
			usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
		}), {
			status: 200,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		});
	}

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
				clientKeyName,
			),
		);
	}

	// Build parts with optional function calls
	const parts: Array<Record<string, unknown>> = [{ text: result.text }];
	const toolCalls = result.toolCalls;
	if (toolCalls?.length) {
		for (const tc of toolCalls) {
			parts.push({ functionCall: { name: tc.toolName, args: tc.input } });
		}
	}

	return new Response(
		JSON.stringify({
			candidates: [
				{
					content: {
						role: 'model',
						parts,
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
	// When no action (colon) is present, default to generateContent.
	const colonIdx = rawParam.lastIndexOf(':');
	let modelId: string;
	let action: string;
	if (colonIdx >= 0) {
		modelId = safeDecodeURIComponent(rawParam.slice(0, colonIdx)).replace(/^models\//, '');
		action = rawParam.slice(colonIdx + 1);
	} else {
		modelId = safeDecodeURIComponent(rawParam).replace(/^models\//, '');
		action = 'generateContent';
	}

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
	// Request-scoped values (set by clientAuthMiddleware — never the shared env)
	const clientKeyName = getClientKeyName(c.req.raw);
	const clientSignal = c.req.raw.signal;

	// Try each candidate in weight order (if failover enabled).
	// Each candidate gets up to MAX_RETRIES attempts (with exponential backoff) for transient errors.
	const MAX_RETRIES = 2;
	const BASE_RETRY_DELAY_MS = 100;

	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];
	let lastError = '';
	let fatalResponse: Response | null = null;
	for (const candidate of tryCandidates) {
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
				// Google/Vertex tool-call history can't round-trip Gemini thought
				// signatures through the OpenAI-compat passthrough (HTTP 400). Route
				// those through the AI SDK provider (injects the sentinel) unless the
				// operator opts into the lighter direct path via VEGA_GOOGLE_TOOL_MODE.
				const googleWithTools =
					(type === 'google_ai_studio' || type === 'vertex_ai') &&
					hasGeminiToolCalls(body) &&
					shouldUseAISDKForGoogleTools(c.env);
				const useDirect =
					type === 'openai' || ((type === 'google_ai_studio' || type === 'vertex_ai') && !googleWithTools);

				let normModelId = modelId;
				let directProvider: ProviderMatch = candidate;
				let skipVersioning = false;

				if (type === 'google_ai_studio') {
					const cleanedModel = modelId.replace(/^(google\/|models\/)+/, '');
					normModelId = cleanedModel;
					if (useDirect) {
						skipVersioning = true;
						directProvider = {
							...candidate,
							provider: { ...candidate.provider, config: { ...candidate.provider.config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' } },
						};
					} else {
						directProvider = { ...candidate, matchedModel: cleanedModel, provider: candidate.provider };
					}
				} else if (type === 'vertex_ai') {
					const cfg = candidate.provider.config;
					const loc = cfg.location || 'global';
					const cleanedModel = modelId.replace(/^(google\/|models\/)+/, '');
					if (useDirect) {
						skipVersioning = true;
						normModelId = modelId.startsWith('google/') ? modelId : 'google/' + modelId;
						const vConfig: Record<string, string> = { ...cfg, baseUrl: `https://aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${loc}/endpoints/openapi` };
						if (!isVertexApiKeyMode(cfg)) {
							vConfig.apiKey = await getVertexAccessToken(cfg);
						}
						directProvider = { ...candidate, provider: { ...candidate.provider, config: vConfig } };
					} else {
						// AI SDK path (native Vertex API) — drop aliases, keep original config.
						directProvider = { ...candidate, matchedModel: cleanedModel, provider: candidate.provider };
					}
				}

				const response = isStream
					? await (useDirect
						? handleGeminiDirectStream(body, requestId, directProvider, c.env, ip, execCtx, startMs, normModelId, altSse, skipVersioning, clientSignal, clientKeyName, isLastAttempt)
						: handleGeminiStream(body, requestId, directProvider, c.env, ip, execCtx, startMs, normModelId, altSse, clientSignal, clientKeyName, isLastAttempt))
					: await (useDirect
						? handleGeminiDirectNonStream(body, requestId, directProvider, c.env, ip, execCtx, startMs, normModelId, skipVersioning, clientSignal, clientKeyName, isLastAttempt)
						: handleGeminiNonStream(body, requestId, directProvider, c.env, ip, execCtx, startMs, normModelId, clientSignal, clientKeyName, isLastAttempt));

				if (response.status >= 400) {
					lastError = `Provider ${candidate.provider.id}: HTTP ${response.status}`;
					// 400/401/403: deterministic client/request error — return immediately;
					// not a provider-health problem, so don't count toward the circuit.
					if (FATAL_4XX.has(response.status)) {
						fatalResponse = response;
						break;
					}
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
				const errMsg = err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: JSON.stringify(err);
				lastError = `Provider ${candidate.provider.id}: ${errMsg}`;
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
		}
		if (fatalResponse) return fatalResponse;
	}
	return c.json(
		{ error: { message: `All providers failed. Last error: ${lastError}`, code: 502 } },
		502,
		{ 'x-should-retry': 'true' },
	);
});
