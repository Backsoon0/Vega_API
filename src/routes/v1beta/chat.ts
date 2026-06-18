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

/** JSON-escape a string for inline embedding (faster than full object stringify) */
function escJson(s: string): string {
	return JSON.stringify(s).slice(1, -1);
}

/** Convert Gemini generateContent request body to OpenAI-compatible format. */
function geminiToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
	const messages: Array<Record<string, unknown>> = [];
	const si = body.systemInstruction as { parts?: Array<{ text: string }> } | undefined;
	if (si?.parts?.length) {
		const text = si.parts.map((p) => p.text || '').join('\n');
		if (text) messages.push({ role: 'system', content: text });
	}
	for (const c of (body.contents as Array<Record<string, unknown>>) || []) {
		const role = c.role === 'model' ? 'assistant' : String(c.role || 'user');
		const parts = (c.parts as Array<Record<string, unknown>>) || [];
		const text = parts.map((p: any) => p.text || '').join('\n');
		if (text) messages.push({ role, content: text });
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
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
		baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
	}

	const upstreamBody = geminiToOpenAI(body);
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
		return new Response(errText || JSON.stringify({ error: { message: `Upstream ${upstreamResponse.status}`, code: 500 } }), {
			status: upstreamResponse.status,
			headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		});
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

			const reader = upstreamResponse.body!.getReader();
			const decoder = new TextDecoder();
			let buf = '';

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

							const rc = delta?.reasoning_content;
							if (rc != null && rc !== '' && fullText.length === 0) { fullText += rc; controller.enqueue(encoder.encode(ssePfx + JSON.stringify(buildGeminiChunk(fullText)) + sseSfx)); }

							if (delta?.tool_calls?.length) {
								for (const tc of delta.tool_calls) {
									const fc = tc.function || tc;
									controller.enqueue(encoder.encode(ssePfx + JSON.stringify({
										candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: fc.name, args: fc.arguments } }] }, index: 0, safetyRatings: [] }],
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
				reader.releaseLock();
				if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
					{ prompt: lastInputTokens, completion: lastOutputTokens }, !streamError, Date.now() - startMs, requestId, true,
					streamError ? { errorType: 'stream_error', errorMessage: streamErrorMsg.slice(0, 300) } : {},
					0, 0, env.clientKeyName || ''));
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
): Promise<Response> {
	const apiKey = provider.provider.config.apiKey;
	let baseUrl = provider.provider.config.baseUrl || 'https://api.openai.com/v1';
	if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) baseUrl = baseUrl.replace(/\/$/, '') + '/v1';

	const upstreamBody = geminiToOpenAI(body);
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
			status: upstreamResponse.status, headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
		});
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};

	if (execCtx) execCtx.waitUntil(recordUsage(env, provider.provider.id, rawModelId, ip,
		{ prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
		true, Date.now() - startMs, requestId, false, {}, 0, 0, env.clientKeyName || ''));

	const fr = choice?.finish_reason || 'stop';
	const finishReason = fr === 'stop' ? 'STOP' : fr === 'length' ? 'MAX_TOKENS'
		: fr === 'tool_calls' ? 'STOP' : fr === 'content_filter' ? 'SAFETY' : 'STOP';

	const parts: Array<Record<string, unknown>> = [{ text: msg.content || '' }];
	if (msg.tool_calls?.length) for (const tc of msg.tool_calls) parts.push({ functionCall: { name: (tc.function || tc).name, args: (tc.function || tc).arguments } });

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
		headers: undefined,
	});

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
			try {
				for await (const part of result.fullStream) {
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
				env.clientKeyName || '',
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
		modelId = decodeURIComponent(rawParam.slice(0, colonIdx)).replace(/^models\//, '');
		action = rawParam.slice(colonIdx + 1);
	} else {
		modelId = decodeURIComponent(rawParam).replace(/^models\//, '');
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

	// Try each candidate in weight order (if failover enabled)
	const failoverEnabled = await getFailoverEnabled(c.env);
	const tryCandidates = failoverEnabled ? candidates : [candidates[0]];
	let lastError = '';
	for (const candidate of tryCandidates) {
		try {
			const isOpenAI = candidate.provider.type === 'openai';
			if (isStream) {
				return await (isOpenAI
					? handleGeminiDirectStream(body, requestId, candidate, c.env, ip, execCtx, startMs, modelId, altSse)
					: handleGeminiStream(body, requestId, candidate, c.env, ip, execCtx, startMs, modelId, altSse));
			}
			return await (isOpenAI
				? handleGeminiDirectNonStream(body, requestId, candidate, c.env, ip, execCtx, startMs, modelId)
				: handleGeminiNonStream(body, requestId, candidate, c.env, ip, execCtx, startMs, modelId));
		} catch (err) {
		const errMsg = err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: JSON.stringify(err);
		lastError = `Provider ${candidate.provider.id}: ${errMsg}`;
		if (execCtx) {
			execCtx.waitUntil(
				recordUsage(c.env, candidate.provider.id, modelId, ip,
					{ prompt: 0, completion: 0 }, false,
					Date.now() - startMs, requestId, isStream,
					{ errorType: 'provider_error', errorMessage: errMsg.slice(0, 300) },
					0, 0, c.env.clientKeyName || '',
				),
			);
		}
	}
}

// All providers failed
if (execCtx) {
	execCtx.waitUntil(
		recordUsage(c.env, 'unknown', modelId, ip,
			{ prompt: 0, completion: 0 }, false, 0,
			requestId, isStream,
			{ errorType: 'all_providers_failed', errorMessage: lastError.slice(0, 300) },
			0, 0, c.env.clientKeyName || '',
		),
	);
}
return c.json(
	{ error: { message: `All providers failed. Last error: ${lastError}`, code: 502 } },
	502,
);
});
