// src/index.js
// Cloudflare Worker - Vega API
//
// Supports:
//   - Google Vertex AI (JWT service account auth)
//   - Google AI Studio (API key auth, OpenAI-compatible endpoint)
//   - OpenAI official API (API key auth)
//
// All API routes use /v1 prefix (OpenAI-compatible).
// Admin UI at / for configuration management.
// Configuration stored in Cloudflare KV.

import { handleAdminRoutes } from "./admin.js";
import { listProviders, getConfigVersion, getClientApiKey } from "./config.js";
import { recordUsage } from "./usage.js";
import * as VertexProvider from "./providers/vertex.js";
import * as AiStudioProvider from "./providers/ai-studio.js";
import * as OpenAIProvider from "./providers/openai.js";

// ---- Cache ----
let cachedProviders = null;
let cachedProvidersAt = 0;
let cachedProvidersVersion = -1;
const PROVIDERS_CACHE_TTL_MS = 60 * 1000; // 1 minute

let cachedModels = null;
let cachedModelsAt = 0;
let cachedModelsVersion = -1;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---- Provider registry ----
const PROVIDER_HANDLERS = {
  vertex_ai: VertexProvider,
  google_ai_studio: AiStudioProvider,
  openai: OpenAIProvider,
};

// ---- Helpers ----

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, x-proxy-key",
    "Access-Control-Expose-Headers": "content-type",
    "Vary": "Origin",
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(request);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---- Provider loading ----

async function loadProviders(env) {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedProviders && cachedProvidersVersion === version &&
      now - cachedProvidersAt < PROVIDERS_CACHE_TTL_MS) {
    return cachedProviders;
  }
  cachedProviders = await listProviders(env);
  cachedProvidersAt = now;
  cachedProvidersVersion = version;
  return cachedProviders;
}

// ---- Model routing ----

/**
 * Find which provider handles a given model.
 * Builds a model→provider map from the aggregated model cache (auto-fetched + configured).
 * Falls back to name-based heuristics for unknown models.
 */
async function findProviderForModel(env, modelId) {
  const providers = await loadProviders(env);
  const enabled = providers.filter((p) => p.enabled);
  if (!enabled.length) return null;

  // 1. Look up from auto-fetched + configured model cache
  const models = await getAggregatedModels(env);
  const found = models.find((m) => m.id === modelId);
  if (found && found._providerId) {
    const provider = enabled.find((p) => p.id === found._providerId);
    if (provider) {
      return { provider, matchedModel: modelId };
    }
  }

  // 2. Configured models (exact match, for providers where auto-fetch fails)
  for (const p of enabled) {
    if ((p.models || []).some((m) => m === modelId)) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 3. Configured models (prefix match)
  for (const p of enabled) {
    if ((p.models || []).some((m) => modelId.startsWith(m + "/") || modelId.startsWith(m))) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 4. Heuristic: match by model name prefix
  const prefix = modelId.split("/")[0].toLowerCase();
  let candidateProviders;

  if (["google", "gemini", "publishers"].includes(prefix)) {
    candidateProviders = enabled.filter(
      (p) => p.type === "vertex_ai" || p.type === "google_ai_studio"
    );
  } else if (["gpt", "o1", "o3", "text-embedding", "dall-e", "tts", "whisper"].some(
    (p) => modelId.toLowerCase().startsWith(p)
  )) {
    candidateProviders = enabled.filter((p) => p.type === "openai");
  } else {
    candidateProviders = enabled;
  }

  if (candidateProviders.length > 0) {
    return { provider: candidateProviders[0], matchedModel: modelId };
  }

  if (enabled.length > 0) {
    return { provider: enabled[0], matchedModel: modelId };
  }

  return null;
}

// ---- Model list aggregation ----

async function getAggregatedModels(env) {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedModels && cachedModelsVersion === version &&
      now - cachedModelsAt < MODELS_CACHE_TTL_MS) {
    return cachedModels;
  }

  const providers = await loadProviders(env);
  const seen = new Set();
  const models = [];

  for (const p of providers) {
    if (!p.enabled) continue;

    // Configured models (explicit list from provider config)
    for (const m of p.models || []) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push({
          id: m, object: "model", created: 0,
          owned_by: mapTypeToOwner(p.type),
          _providerId: p.id,
        });
      }
    }

    // Auto-fetch live models from provider API
    const handler = PROVIDER_HANDLERS[p.type];
    if (handler && handler.fetchModelList) {
      try {
        const liveModels = await handler.fetchModelList(env, p.config);
        for (const m of liveModels) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push({ ...m, _providerId: p.id });
          }
        }
      } catch {
        // Silently skip unreachable providers
      }
    }
  }

  cachedModels = models;
  cachedModelsAt = now;
  cachedModelsVersion = version;
  return models;
}

function mapTypeToOwner(type) {
  const map = {
    vertex_ai: "google",
    google_ai_studio: "google",
    openai: "openai",
  };
  return map[type] || type;
}

// ---- Chat completions proxy ----

async function handleChatCompletions(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }

  const modelId = String(body.model || "").trim();
  if (!modelId) {
    return json(
      { error: { message: "model is required", type: "invalid_request_error" } },
      400
    );
  }

  const result = await findProviderForModel(env, modelId);
  if (!result) {
    return json(
      {
        error: {
          message: `No enabled provider found for model: ${modelId}. Configure providers in the admin panel.`,
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  const { provider } = result;
  const handler = PROVIDER_HANDLERS[provider.type];
  if (!handler) {
    return json({ error: { message: `Unknown provider type: ${provider.type}` } }, 500);
  }

  body.model = result.matchedModel;

  // Build new request with modified body; remove stale Content-Length
  const newHeaders = new Headers(request.headers);
  newHeaders.delete("content-length");
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: newHeaders,
    body: JSON.stringify(body),
  });
  try {
    const suffix = "/chat/completions";
    const upstreamResp = await handler.proxyRequest(newRequest, env, provider, suffix);

    // Record usage: read body once, extract token counts, return reconstructed response
    if (!upstreamResp.ok || !upstreamResp.body) return upstreamResp;

    const isStream = !!body.stream;

    if (isStream) {
      // Streaming: pipe through TransformStream, capture usage from last SSE chunk
      let lastData = "";
      const ts = new TransformStream({
        transform(chunk, ctrl) {
          ctrl.enqueue(chunk);
          const text = new TextDecoder().decode(chunk);
          const lines = text.split("\n");
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith("data: ") && t !== "data: [DONE]") {
              lastData = t.slice(6).trim();
            }
          }
        },
        flush() {
          if (lastData && ctx) {
            try {
              const d = JSON.parse(lastData);
              if (d?.usage) {
                ctx.waitUntil(recordUsage(env, provider.id, {
                  prompt: d.usage.prompt_tokens || 0,
                  completion: d.usage.completion_tokens || 0,
                }));
              }
            } catch { /* ignore */ }
          }
        }
      });
      return new Response(upstreamResp.body.pipeThrough(ts), {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: upstreamResp.headers,
      });
    }

    // Non-streaming: read body once, extract usage, reconstruct response
    const bodyText = await upstreamResp.text();
    try {
      const data = JSON.parse(bodyText);
      if (data?.usage) {
        const u = { prompt: data.usage.prompt_tokens || 0, completion: data.usage.completion_tokens || 0 };
        if (ctx) ctx.waitUntil(recordUsage(env, provider.id, u));
      }
    } catch { /* ignore parse errors */ }
    return new Response(bodyText, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  } catch (err) {
    console.error(`Provider ${provider.id} error:`, err.message);
    return json(
      {
        error: {
          message: `Upstream request failed: ${err.message}`,
          type: "server_error",
        },
      },
      502
    );
  }
}

// ---- Generic /v1/* proxy ----

async function handleGenericV1Route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const suffix = path.slice("/v1".length);

  let provider = null;
  if (request.method === "POST" || request.method === "PUT") {
    try {
      const cloned = request.clone();
      const body = await cloned.json().catch(() => null);
      if (body && body.model) {
        const result = await findProviderForModel(env, String(body.model).trim());
        if (result) {
          provider = result.provider;
          body.model = result.matchedModel;
          const v1Headers = new Headers(request.headers);
          v1Headers.delete("content-length");
          request = new Request(request.url, {
            method: request.method,
            headers: v1Headers,
            body: JSON.stringify(body),
          });
        }
      }
    } catch {
      // Use original request
    }
  }

  if (!provider) {
    const providers = await loadProviders(env);
    const enabled = providers.filter((p) => p.enabled);
    if (!enabled.length) {
      return json(
        { error: { message: "No enabled providers configured" } },
        503
      );
    }
    provider = enabled[0];
  }

  const handler = PROVIDER_HANDLERS[provider.type];
  if (!handler) {
    return json({ error: { message: `Unknown provider type: ${provider.type}` } }, 500);
  }

  try {
    const upstreamResp = await handler.proxyRequest(request, env, provider, suffix);
    return upstreamResp;
  } catch (err) {
    console.error(`Provider ${provider.id} error:`, err.message);
    return json(
      { error: { message: `Upstream request failed: ${err.message}`, type: "server_error" } },
      502
    );
  }
}

// ---- Client auth (optional, configurable via admin UI) ----

async function checkClientAuth(request, env) {
  // 1. Check KV-stored client API key (set via admin UI)
  const kvKey = await getClientApiKey(env);
  if (kvKey) {
    const auth = request.headers.get("Authorization") || "";
    return auth === `Bearer ${kvKey}`;
  }

  // 2. Fallback to env.OPENAI_API_KEY (set via wrangler secret)
  if (env.OPENAI_API_KEY) {
    const auth = request.headers.get("Authorization") || "";
    return auth === `Bearer ${env.OPENAI_API_KEY}`;
  }

  // 3. No key configured → allow all requests (public)
  return true;
}

// ---- Main fetch handler ----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight is exempt from auth
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // ---- Admin routes ----
    if (path.startsWith("/admin/")) {
      try {
        const resp = await handleAdminRoutes(request, env);
        return withCors(resp, request);
      } catch (err) {
        console.error("Admin error:", err.message);
        return withCors(json({ error: err.message }, 500), request);
      }
    }

    // ---- Health check ----
    if (path === "/health") {
      const providers = await loadProviders(env).catch(() => []);
      const enabled = providers.filter((p) => p.enabled).length;
      return withCors(
        json({
          ok: true,
          message: "Vega API is running",
          providers: enabled,
          routes: [
            "/",
            "/health",
            "/v1/chat/completions",
            "/v1/models",
            "/v1/models/{model}",
          ],
        }),
        request
      );
    }

    // ---- Client auth for /v1/* routes (optional) ----
    if (path.startsWith("/v1/")) {
      if (!(await checkClientAuth(request, env))) {
        return withCors(
          json({ error: { message: "Unauthorized" } }, 401),
          request
        );
      }
    }

    // ---- /v1/models ----
    if (path === "/v1/models" || path.startsWith("/v1/models/")) {
      try {
        const modelId = path.startsWith("/v1/models/")
          ? decodeURIComponent(path.slice("/v1/models/".length))
          : "";

        const models = await getAggregatedModels(env);

        if (modelId) {
          const found = models.find((m) => m.id === modelId);
          if (!found) {
            return withCors(
              json(
                { error: { message: `Model not found: ${modelId}`, type: "invalid_request_error" } },
                404
              ),
              request
            );
          }
          return withCors(json(found), request);
        }

        return withCors(json({ object: "list", data: models }), request);
      } catch (err) {
        console.error("Models error:", err.message);
        return withCors(
          json({ error: { message: err.message || "Failed to list models", type: "server_error" } }, 500),
          request
        );
      }
    }

    // ---- /v1/chat/completions ----
    if (path === "/v1/chat/completions" && request.method === "POST") {
      try {
        const resp = await handleChatCompletions(request, env, ctx);
        return withCors(resp, request);
      } catch (err) {
        console.error("Chat completions error:", err.message);
        return withCors(
          json(
            { error: { message: err.message || "Chat completion failed", type: "server_error" } },
            502
          ),
          request
        );
      }
    }

    // ---- Generic /v1/* routes ----
    if (path.startsWith("/v1/")) {
      try {
        const resp = await handleGenericV1Route(request, env);
        return withCors(resp, request);
      } catch (err) {
        console.error("V1 route error:", err.message);
        return withCors(
          json(
            { error: { message: err.message || "Request failed", type: "server_error" } },
            502
          ),
          request
        );
      }
    }

    // ---- SPA / static assets fallback ----
    // For GET requests not handled by API routes, serve from static assets
    // (SvelteKit SPA with not_found_handling: single-page-application)
    if (request.method === "GET" && env.ASSETS) {
      try {
        return env.ASSETS.fetch(request);
      } catch (e) {
        console.error('ASSETS fetch error:', e.message);
      }
    }

    // ---- 404 ----
    return withCors(
      json({ error: { message: "Not Found" } }, 404),
      request
    );
  },
};
