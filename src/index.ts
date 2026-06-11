// src/index.ts
// Vega API — Hono on Cloudflare Workers
// OpenAI-compatible API aggregating Vertex AI, AI Studio, and OpenAI

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, Provider, Model, ProviderHandler } from './types';
import { initSchema } from './db';
import {
  listProviders, listProvidersMasked, getProvider,
  saveProvider, deleteProvider, getAdminPasswordHash,
  setAdminPassword, getClientApiKey, setClientApiKey,
  getConfigVersion,
} from './config';
import { sha256 } from './crypto';
import { rateLimitLogin, recordLoginFailure, resetLoginRate, getRateLimitConfig } from './rate-limit';
import { recordUsage, getUsage, getUsageTotals } from './usage';
import { getLogs, clearLogs } from './log-buffer';
import * as VertexProvider from './providers/vertex';
import * as AiStudioProvider from './providers/ai-studio';
import * as OpenAIProvider from './providers/openai';

const app = new Hono<{ Bindings: Env }>();

// ---- Global CORS ----
app.use('*', cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Key'],
  exposeHeaders: ['Content-Type'],
}));

// ---- Cache state ----
let cachedProviders: Provider[] | null = null;
let cachedProvidersAt = 0;
let cachedProvidersVersion = -1;
const PROVIDERS_CACHE_TTL = 60_000;

let cachedModels: Model[] | null = null;
let cachedModelsAt = 0;
let cachedModelsVersion = -1;
const MODELS_CACHE_TTL = 300_000;

const PROVIDER_HANDLERS: Record<string, ProviderHandler> = {
  vertex_ai: VertexProvider,
  google_ai_studio: AiStudioProvider,
  openai: OpenAIProvider,
};

// ---- Provider loading ----
async function loadProviders(env: Env): Promise<Provider[]> {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedProviders && cachedProvidersVersion === version &&
      now - cachedProvidersAt < PROVIDERS_CACHE_TTL) {
    return cachedProviders;
  }
  cachedProviders = await listProviders(env);
  cachedProvidersAt = now;
  cachedProvidersVersion = version;
  return cachedProviders;
}

// ---- Model routing ----
async function findProviderForModel(
  env: Env, modelId: string
): Promise<{ provider: Provider; matchedModel: string } | null> {
  const providers = await loadProviders(env);
  const enabled = providers.filter(p => p.enabled);
  if (!enabled.length) return null;

  // 1. Look up from cached model list
  const models = await getAggregatedModels(env);
  const found = models.find(m => m.id === modelId);
  if (found?._providerId) {
    const provider = enabled.find(p => p.id === found._providerId);
    if (provider) return { provider, matchedModel: modelId };
  }

  // 2. Configured model exact match
  for (const p of enabled) {
    if ((p.models || []).some(m => m === modelId)) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 3. Configured model prefix match
  for (const p of enabled) {
    if ((p.models || []).some(
      m => modelId.startsWith(m + '/') || modelId.startsWith(m)
    )) {
      return { provider: p, matchedModel: modelId };
    }
  }

  // 4. Heuristic by model name prefix
  const prefix = modelId.split('/')[0].toLowerCase();
  if (['google', 'gemini', 'publishers'].includes(prefix)) {
    const candidates = enabled.filter(
      p => p.type === 'vertex_ai' || p.type === 'google_ai_studio'
    );
    if (candidates.length) return { provider: candidates[0], matchedModel: modelId };
  }
  if (['gpt', 'o1', 'o3', 'text-embedding', 'dall-e', 'tts', 'whisper'].some(
    p => modelId.toLowerCase().startsWith(p)
  )) {
    const candidates = enabled.filter(p => p.type === 'openai');
    if (candidates.length) return { provider: candidates[0], matchedModel: modelId };
  }

  return enabled.length ? { provider: enabled[0], matchedModel: modelId } : null;
}

async function getAggregatedModels(env: Env): Promise<Model[]> {
  const now = Date.now();
  const version = await getConfigVersion(env);
  if (cachedModels && cachedModelsVersion === version &&
      now - cachedModelsAt < MODELS_CACHE_TTL) {
    return cachedModels;
  }

  const providers = await loadProviders(env);
  const seen = new Set<string>();
  const models: Model[] = [];

  for (const p of providers) {
    if (!p.enabled) continue;
    for (const m of p.models || []) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push({
          id: m, object: 'model', created: 0,
          owned_by: mapOwner(p.type), _providerId: p.id,
        });
      }
    }
    const handler = PROVIDER_HANDLERS[p.type];
    if (handler?.fetchModelList) {
      try {
        const live = await handler.fetchModelList(env, p.config);
        for (const m of live) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            models.push({ ...m, _providerId: p.id });
          }
        }
      } catch { /* skip unreachable */ }
    }
  }

  cachedModels = models;
  cachedModelsAt = now;
  cachedModelsVersion = version;
  return models;
}

function mapOwner(type: string): string {
  const map: Record<string, string> = {
    vertex_ai: 'google', google_ai_studio: 'google', openai: 'openai',
  };
  return map[type] || type;
}

// ---- Client auth ----
async function checkClientAuth(c: any, env: Env): Promise<boolean> {
  const kvKey = await getClientApiKey(env);
  if (kvKey) {
    const auth = c.req.header('Authorization') || '';
    return auth === `Bearer ${kvKey}`;
  }
  if (env.OPENAI_API_KEY) {
    const auth = c.req.header('Authorization') || '';
    return auth === `Bearer ${env.OPENAI_API_KEY}`;
  }
  return true;
}

async function requireAdminAuth(c: any, env: Env): Promise<boolean> {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  const storedHash = await getAdminPasswordHash(env);
  return !!(storedHash && token === storedHash);
}

// ═══════════════ ROUTES ═══════════════

// ---- Health check ----
app.get('/health', async (c) => {
  const providers = await loadProviders(c.env).catch(() => []);
  const enabled = providers.filter(p => p.enabled).length;
  return c.json({
    ok: true,
    message: 'Vega API is running',
    providers: enabled,
    routes: ['/', '/health', '/v1/chat/completions', '/v1/models'],
  });
});

// ---- Admin: Login (rate-limited) ----
app.post('/admin/auth', rateLimitLogin, async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const password = String(body.password || '');
  if (!password) return c.json({ error: 'Password is required' }, 400);

  const storedHash = await getAdminPasswordHash(c.env);

  // First login sets the password
  if (!storedHash) {
    const hash = await sha256(password);
    await setAdminPassword(c.env, hash);
    return c.json({ ok: true, token: hash, message: 'Password set successfully' });
  }

  const inputHash = await sha256(password);
  if (inputHash !== storedHash) {
    return recordLoginFailure(c);
  }

  await resetLoginRate(c);
  return c.json({ ok: true, token: storedHash });
});

// ---- Admin: Setup (initial password, no auth required) ----
app.post('/admin/setup', async (c) => {
  const storedHash = await getAdminPasswordHash(c.env);
  if (storedHash) return c.json({ error: 'Password already set' }, 400);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const password = String(body.password || '');
  if (!password || password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400);
  }

  const hash = await sha256(password);
  await setAdminPassword(c.env, hash);
  return c.json({ ok: true, token: hash, message: 'Admin password set' });
});

// ---- Admin: Auth check ----
app.get('/admin/check', async (c) => {
  if (await requireAdminAuth(c, c.env)) return c.json({ authenticated: true });
  return c.json({ error: 'Unauthorized' }, 401);
});

// ---- Admin: Rate limit config ----
app.get('/admin/fail2ban-config', async (c) => {
  return c.json(getRateLimitConfig());
});

// ---- Admin: Auth guard for remaining /admin/* routes ----
app.use('/admin/*', async (c, next) => {
  const skipAuth = ['/admin/auth', '/admin/setup', '/admin/check', '/admin/fail2ban-config'];
  if (skipAuth.includes(c.req.path)) return next();
  if (await requireAdminAuth(c, c.env)) return next();
  return c.json({ error: 'Unauthorized' }, 401);
});

// ---- Admin: Providers CRUD ----
app.get('/admin/providers', async (c) => {
  const providers = await listProvidersMasked(c.env);
  return c.json(providers);
});

app.post('/admin/providers', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  try {
    const record = await saveProvider(c.env, body);
    return c.json(record, 201);
  } catch (err) { return c.json({ error: (err as Error).message }, 400); }
});

app.get('/admin/providers/:id', async (c) => {
  const provider = await getProvider(c.env, c.req.param('id'));
  if (!provider) return c.json({ error: 'Not found' }, 404);
  return c.json(provider);
});

app.put('/admin/providers/:id', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);
  body.id = c.req.param('id');
  try {
    const record = await saveProvider(c.env, body);
    return c.json(record);
  } catch (err) { return c.json({ error: (err as Error).message }, 400); }
});

app.delete('/admin/providers/:id', async (c) => {
  await deleteProvider(c.env, c.req.param('id'));
  return c.json({ ok: true });
});

// ---- Admin: Client API Key ----
app.get('/admin/client-key', async (c) => {
  const key = await getClientApiKey(c.env);
  if (!key) {
    return c.json({ configured: false, message: 'No client API key set. /v1/* routes are public.' });
  }
  const reveal = c.req.query('reveal') === 'true';
  const masked = key.length > 8 ? '*'.repeat(key.length - 4) + key.slice(-4) : '****';
  const result: Record<string, unknown> = {
    configured: true, masked, length: key.length, prefix: key.substring(0, 4),
  };
  if (reveal) result.fullKey = key;
  return c.json(result);
});

app.post('/admin/client-key', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  let key = String(body.key || '');
  if (body.generate || !key) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = 'sk-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  if (key.length < 8) return c.json({ error: 'API key must be at least 8 characters' }, 400);
  await setClientApiKey(c.env, key);
  const masked = key.length > 8 ? '*'.repeat(key.length - 4) + key.slice(-4) : '****';
  return c.json({
    ok: true, message: 'Client API key set', masked, fullKey: key, configured: true,
  });
});

app.delete('/admin/client-key', async (c) => {
  await setClientApiKey(c.env, null);
  return c.json({ ok: true, message: 'Client API key removed. /v1/* routes are now public.' });
});

// ---- Admin: Change password ----
app.post('/admin/change-password', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const current = String(body.currentPassword || '');
  const newPass = String(body.newPassword || '');
  if (!current || !newPass) {
    return c.json({ error: 'currentPassword and newPassword are required' }, 400);
  }
  if (newPass.length < 6) {
    return c.json({ error: 'New password must be at least 6 characters' }, 400);
  }
  const storedHash = await getAdminPasswordHash(c.env);
  if (await sha256(current) !== storedHash) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }
  const newHash = await sha256(newPass);
  await setAdminPassword(c.env, newHash);
  return c.json({ ok: true, token: newHash, message: 'Password changed' });
});

// ---- Admin: Usage stats ----
app.get('/admin/usage', async (c) => {
  const from = c.req.query('from') || '';
  const to = c.req.query('to') || '';
  if (!from && !to) {
    const totals = await getUsageTotals(c.env);
    return c.json({ totals });
  }
  const data = await getUsage(c.env, from, to, null);
  return c.json(data);
});

// ---- Admin: Real-time logs ----
app.get('/admin/logs', async (c) => {
  const since = c.req.query('since') || '';
  const logs = getLogs(since);
  return c.json({ logs, count: logs.length });
});

app.delete('/admin/logs', async (c) => {
  clearLogs();
  return c.json({ ok: true });
});

// ═══════════════ /v1/* CLIENT API ROUTES ═══════════════

// Client auth middleware for /v1/*
app.use('/v1/*', async (c, next) => {
  if (!(await checkClientAuth(c, c.env))) {
    return c.json({ error: { message: 'Unauthorized' } }, 401);
  }
  return next();
});

// /v1/models
app.get('/v1/models', async (c) => {
  const models = await getAggregatedModels(c.env);
  return c.json({ object: 'list', data: models });
});

app.get('/v1/models/:modelId', async (c) => {
  const modelId = decodeURIComponent(c.req.param('modelId'));
  const models = await getAggregatedModels(c.env);
  const found = models.find(m => m.id === modelId);
  if (!found) {
    return c.json(
      { error: { message: `Model not found: ${modelId}`, type: 'invalid_request_error' } },
      404
    );
  }
  return c.json(found);
});

// /v1/chat/completions
app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.model) {
    return c.json(
      { error: { message: 'model is required', type: 'invalid_request_error' } },
      400
    );
  }

  const modelId = String(body.model).trim();
  const result = await findProviderForModel(c.env, modelId);
  if (!result) {
    return c.json(
      { error: { message: `No enabled provider for model: ${modelId}` } },
      400
    );
  }

  const { provider } = result;
  const handler = PROVIDER_HANDLERS[provider.type];
  if (!handler) {
    return c.json(
      { error: { message: `Unknown provider type: ${provider.type}` } },
      500
    );
  }

  body.model = result.matchedModel;

  const newHeaders = new Headers(c.req.raw.headers);
  newHeaders.delete('content-length');
  const proxyReq = new Request(c.req.raw.url, {
    method: 'POST', headers: newHeaders, body: JSON.stringify(body),
  });

  try {
    const upstreamResp = await handler.proxyRequest(
      proxyReq, c.env, provider, '/chat/completions'
    );
    if (!upstreamResp.ok || !upstreamResp.body) return upstreamResp;

    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const isStream = !!body.stream;

    if (isStream) {
      let lastData = '';
      const ts = new TransformStream({
        transform(chunk, ctrl) {
          ctrl.enqueue(chunk);
          const text = new TextDecoder().decode(chunk);
          const lines = text.split('\n');
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('data: ') && t !== 'data: [DONE]') {
              lastData = t.slice(6).trim();
            }
          }
        },
        flush() {
          if (lastData) {
            try {
              const d = JSON.parse(lastData);
              if (d?.usage) {
                const execCtx = (c as any).executionCtx;
                if (execCtx) {
                  execCtx.waitUntil(
                    recordUsage(c.env, provider.id, modelId, ip, {
                      prompt: d.usage.prompt_tokens || 0,
                      completion: d.usage.completion_tokens || 0,
                    }, true)
                  );
                }
              }
            } catch { /* ignore */ }
          }
        },
      });
      return new Response(upstreamResp.body.pipeThrough(ts), {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: upstreamResp.headers,
      });
    }

    // Non-streaming
    const bodyText = await upstreamResp.text();
    try {
      const data = JSON.parse(bodyText);
      if (data?.usage) {
        const execCtx = (c as any).executionCtx;
        if (execCtx) {
          execCtx.waitUntil(
            recordUsage(c.env, provider.id, modelId, ip, {
              prompt: data.usage.prompt_tokens || 0,
              completion: data.usage.completion_tokens || 0,
            }, true)
          );
        }
      }
    } catch { /* ignore */ }
    return new Response(bodyText, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  } catch (err) {
    console.error(`Provider ${provider.id} error:`, (err as Error).message);
    // Record failed usage
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const execCtx = (c as any).executionCtx;
    if (execCtx) {
      execCtx.waitUntil(
        recordUsage(c.env, provider.id, modelId, ip,
          { prompt: 0, completion: 0 }, false)
      );
    }
    return c.json(
      { error: { message: `Upstream failed: ${(err as Error).message}`, type: 'server_error' } },
      502
    );
  }
});

// Generic /v1/* proxy for other routes (embeddings, etc.)
app.all('/v1/*', async (c) => {
  // For now, return a helpful error for unimplemented routes
  return c.json(
    { error: { message: `Route not implemented: ${c.req.path}`, type: 'invalid_request_error' } },
    404
  );
});

// ---- SPA / static assets fallback ----
app.get('/*', async (c) => {
  if (c.env.ASSETS) {
    try {
      return c.env.ASSETS.fetch(c.req.raw);
    } catch { /* fall through */ }
  }
  return c.json({ error: { message: 'Not Found' } }, 404);
});

// ---- Export ----
let schemaInitialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Only init schema once per isolate (not every request)
    if (!schemaInitialized) {
      try {
        await initSchema(env);
        schemaInitialized = true;
      } catch (err) {
        console.error('Schema init error:', (err as Error).message);
      }
    }
    try {
      return await app.fetch(request, env, ctx);
    } catch (err) {
      console.error('Worker error:', (err as Error).message, (err as Error).stack);
      return new Response(JSON.stringify({
        error: { message: 'Internal server error: ' + (err as Error).message }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
