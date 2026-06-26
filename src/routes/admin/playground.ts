// src/routes/admin/playground.ts
// Admin playground — chat with a specific provider+model for testing
// No usage recording, no rate limiting, admin-auth only
//
// POST /admin/playground/chat
//   Body: { providerId, model, messages: [{role, content}], stream?: boolean }
//   Returns: stream=JSONLines per event | non-stream=JSON with content+usage
//   Stream format: one JSON object per line
//     {"type":"text-delta","text":"..."}
//     {"type":"reasoning-delta","text":"..."}
//     {"type":"done","usage":{"promptTokens":N,"completionTokens":N,"totalTokens":N}}
//     {"type":"error","message":"..."}

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamText, generateText } from 'ai';
import type { Env, Provider } from '../../types';
import { getProvider } from '../../config';
import {
	createModelFromProvider,
	getVertexAccessToken,
	isVertexApiKeyMode,
} from '../../ai-providers';
import { PROVIDER_HANDLERS } from '../../router';

export const adminPlaygroundRoutes = new Hono<{ Bindings: Env }>();

// ---- Types ----

interface ChatMessage {
	role: string;
	content: string;
}

interface PlaygroundRequest {
	providerId: string;
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	stream?: boolean;
}

// ---- Helpers ----

function convertMessages(msgs: PlaygroundRequest['messages']): ChatMessage[] {
	return msgs.map((m) => ({
		role: m.role === 'developer' ? 'system' : m.role,
		content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
	}));
}

function extractSystem(messages: ChatMessage[]): string | undefined {
	const idx = messages.findIndex((m) => m.role === 'system' || m.role === 'developer');
	if (idx >= 0) return messages.splice(idx, 1)[0].content;
	return undefined;
}

function encodeLine(obj: Record<string, unknown>): Uint8Array {
	const enc = new TextEncoder();
	return enc.encode(JSON.stringify(obj) + '\n');
}

// ---- Models endpoint ----
// GET /admin/playground/models/:providerId — fetch live models from a provider

adminPlaygroundRoutes.get('/playground/models/:providerId', async (c: Context<{ Bindings: Env }>) => {
	const providerId = c.req.param('providerId');
	if (!providerId) return c.json({ error: 'providerId is required' }, 400);

	const provider = await getProvider(c.env, providerId);
	if (!provider) return c.json({ error: `Provider not found: ${providerId}` }, 404);

	const handler = PROVIDER_HANDLERS[provider.type];
	if (!handler?.fetchModelList) return c.json({ models: provider.models || [] });

	try {
		const live = await handler.fetchModelList(c.env, provider.config);
		const merged = new Set(provider.models || []);
		for (const m of live) merged.add(m.id);
		return c.json({ models: [...merged] });
	} catch (err) {
		console.error(`Live model fetch failed for ${providerId}:`, (err as Error).message);
		return c.json({ models: provider.models || [] });
	}
});

// ---- Chat route ----
adminPlaygroundRoutes.post('/playground/chat', async (c: Context<{ Bindings: Env }>) => {
	const body: PlaygroundRequest = await c.req.json().catch(() => null);
	if (!body) return c.json({ error: 'Invalid JSON' }, 400);
	if (!body.providerId) return c.json({ error: 'providerId is required' }, 400);
	if (!body.model) return c.json({ error: 'model is required' }, 400);
	if (!Array.isArray(body.messages) || !body.messages.length) {
		return c.json({ error: 'messages array is required' }, 400);
	}

	const provider = await getProvider(c.env, body.providerId);
	if (!provider) return c.json({ error: `Provider not found: ${body.providerId}` }, 404);
	if (!provider.enabled) return c.json({ error: 'Provider is disabled' }, 400);

	const modelId = String(body.model).trim();
	const messages = convertMessages(body.messages);
	const system = extractSystem(messages);
	const isStream = body.stream !== false;

	// Anthropic uses AI SDK; OpenAI/Google/Vertex use direct fetch
	if (provider.type === 'anthropic') {
		return isStream
			? handleAnthropicStream(c, provider, modelId, messages, system)
			: handleAnthropicNonStream(c, provider, modelId, messages, system);
	}

	return isStream
		? handleDirectStream(c, provider, modelId, messages, system)
		: handleDirectNonStream(c, provider, modelId, messages, system);
});

// ---- Direct fetch handlers (OpenAI / Google AI Studio / Vertex AI) ----

async function buildDirectRequest(
	provider: Provider,
	inModelId: string,
	messages: ChatMessage[],
	system: string | undefined,
): Promise<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> {
	let modelId = inModelId;
	let baseUrl: string;
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };

	switch (provider.type) {
		case 'google_ai_studio':
			baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
			modelId = inModelId.replace(/^(google\/|models\/)+/, '');
			headers['x-goog-api-key'] = provider.config.apiKey;
			break;
		case 'vertex_ai': {
			const cfg = provider.config;
			const loc = cfg.location || 'us-central1';
			baseUrl = `https://aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${loc}/endpoints/openapi`;
			headers['x-goog-user-project'] = cfg.projectId;
			if (isVertexApiKeyMode(cfg)) {
				headers['x-goog-api-key'] = cfg.apiKey;
			} else {
				const token = await getVertexAccessToken(cfg);
				headers['Authorization'] = `Bearer ${token}`;
			}
			break;
		}
		default: {
			baseUrl = provider.config.baseUrl || 'https://api.openai.com/v1';
			if (!baseUrl.endsWith('/v1') && !baseUrl.endsWith('/v1/')) {
				baseUrl = baseUrl.replace(/\/$/, '') + '/v1';
			}
			headers['Authorization'] = `Bearer ${provider.config.apiKey}`;
			break;
		}
	}

	const openaiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
	if (system) openaiMessages.unshift({ role: 'system', content: system });

	return {
		url: `${baseUrl}/chat/completions`,
		headers,
		body: { model: modelId, messages: openaiMessages },
	};
}

async function handleDirectStream(
	c: Context<{ Bindings: Env }>,
	provider: Provider,
	modelId: string,
	messages: ChatMessage[],
	system: string | undefined,
): Promise<Response> {
	const { url, headers, body: reqBody } = await buildDirectRequest(provider, modelId, messages, system);
	reqBody.stream = true;

	const upstreamResponse = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(reqBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		return c.json({ error: `Upstream error ${upstreamResponse.status}: ${errText.slice(0, 500)}` }, upstreamResponse.status as any);
	}

	const decoder = new TextDecoder();

		const stream = new ReadableStream({
			async start(controller) {
				const reader = upstreamResponse.body!.getReader();
				let buf = '';
				let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

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
							if (parsed?.error) {
								controller.enqueue(encodeLine({ type: 'error', message: parsed.error.message || 'Unknown error' }));
								continue;
							}
							const delta = parsed?.choices?.[0]?.delta;
							if (delta?.content) {
								controller.enqueue(encodeLine({ type: 'text-delta', text: delta.content }));
							}
							if (delta?.reasoning_content) {
								controller.enqueue(encodeLine({ type: 'reasoning-delta', text: delta.reasoning_content }));
							}
							if (parsed?.usage) {
								lastUsage = {
									promptTokens: parsed.usage.prompt_tokens || 0,
									completionTokens: parsed.usage.completion_tokens || 0,
									totalTokens: parsed.usage.total_tokens || 0,
								};
							}
						} catch { /* ignore parse errors */ }
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				controller.enqueue(encodeLine({ type: 'error', message: msg }));
			} finally {
				reader.releaseLock();
				controller.enqueue(encodeLine({
					type: 'done',
					usage: lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				}));
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
	});
}

async function handleDirectNonStream(
	c: Context<{ Bindings: Env }>,
	provider: Provider,
	modelId: string,
	messages: ChatMessage[],
	system: string | undefined,
): Promise<Response> {
	const { url, headers, body: reqBody } = await buildDirectRequest(provider, modelId, messages, system);

	const upstreamResponse = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(reqBody),
	});

	if (!upstreamResponse.ok) {
		const errText = await upstreamResponse.text().catch(() => '');
		return c.json({ error: `Upstream error ${upstreamResponse.status}: ${errText.slice(0, 500)}` }, upstreamResponse.status as any);
	}

	const data: any = await upstreamResponse.json();
	const choice = data.choices?.[0];
	const msg = choice?.message || {};
	const usage = data.usage || {};

	return c.json({
		content: msg.content || null,
		reasoning: msg.reasoning_content || null,
		usage: {
			promptTokens: usage.prompt_tokens || 0,
			completionTokens: usage.completion_tokens || 0,
			totalTokens: usage.total_tokens || 0,
		},
	});
}

// ---- Anthropic AI SDK handlers ----

async function handleAnthropicStream(
	c: Context<{ Bindings: Env }>,
	provider: Provider,
	modelId: string,
	messages: ChatMessage[],
	system: string | undefined,
): Promise<Response> {
	const model = createModelFromProvider(provider, c.env, modelId);

	const result = streamText({
		model,
		messages: messages as any,
		system,
	});

	let lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

	const stream = new ReadableStream({
		async start(controller) {
			try {
				for await (const part of result.fullStream) {
					switch (part.type) {
						case 'text-delta':
							controller.enqueue(encodeLine({ type: 'text-delta', text: part.text }));
							break;
						case 'reasoning-delta':
							controller.enqueue(encodeLine({ type: 'reasoning-delta', text: part.text }));
							break;
						case 'finish':
							lastUsage = {
								promptTokens: part.totalUsage?.inputTokens || 0,
								completionTokens: part.totalUsage?.outputTokens || 0,
								totalTokens: part.totalUsage?.totalTokens || 0,
							};
							break;
						case 'error': {
							const msg = part.error instanceof Error ? part.error.message : String(part.error);
							controller.enqueue(encodeLine({ type: 'error', message: msg }));
							break;
						}
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				controller.enqueue(encodeLine({ type: 'error', message: msg }));
			} finally {
				controller.enqueue(encodeLine({
					type: 'done',
					usage: lastUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				}));
				controller.close();
			}
		},
	});

	return new Response(stream, {
		status: 200,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
	});
}

async function handleAnthropicNonStream(
	c: Context<{ Bindings: Env }>,
	provider: Provider,
	modelId: string,
	messages: ChatMessage[],
	system: string | undefined,
): Promise<Response> {
	const model = createModelFromProvider(provider, c.env, modelId);

	const result = await generateText({
		model,
		messages: messages as any,
		system,
	}).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		if (/empty assistant|no content generated/i.test(msg)) return null;
		throw err;
	});

	if (!result) {
		return c.json({
			content: null,
			reasoning: null,
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		});
	}

	return c.json({
		content: result.text || null,
		reasoning: result.reasoningText || null,
		usage: {
			promptTokens: result.usage?.inputTokens || 0,
			completionTokens: result.usage?.outputTokens || 0,
			totalTokens: result.usage?.totalTokens || 0,
		},
	});
}
