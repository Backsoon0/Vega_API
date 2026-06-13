// src/providers/vertex.ts
// Google Vertex AI backend proxy — OpenAI-compatible pass-through
// Supports JWT (service account) and API Key auth modes

import type { Env, Provider, Model } from '../types';

const ACCESS_TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_CACHE_SKEW_SECONDS = 60;

const tokenCache = new Map<string, { token: string; exp: number }>();
const tokenPromises = new Map<string, Promise<string>>();

// ---- JWT helpers ----

function normalizePem(pem: string): string {
  return (pem || '').replace(/\\n/g, '\n').trim();
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  let clean = normalizePem(pem)
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) throw new Error('Vertex AI: Invalid private key — PEM is empty after cleaning');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

async function getSigningKey(env: Env, privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function getAccessToken(env: Env, config: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { serviceAccountEmail, privateKey } = config;
  if (!serviceAccountEmail) throw new Error('Vertex AI: Missing serviceAccountEmail');
  if (!privateKey) throw new Error('Vertex AI: Missing privateKey');

  const cacheKey = serviceAccountEmail;

  // Periodic eviction of expired entries (prevents unbounded Map growth)
  if (Math.random() < 0.05) {
    for (const [key, entry] of tokenCache) {
      if (now >= entry.exp) tokenCache.delete(key);
    }
  }

  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.exp - TOKEN_CACHE_SKEW_SECONDS) return cached.token;

  const pending = tokenPromises.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<string> => {
    const key = await getSigningKey(env, privateKey);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: serviceAccountEmail,
      scope: ACCESS_TOKEN_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };
    const unsignedJwt =
      `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(payload))}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsignedJwt)
    );
    const jwt = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const data = await tokenResp.json() as Record<string, unknown>;
    if (!tokenResp.ok)
      throw new Error(`Vertex AI token exchange failed (${tokenResp.status}): ${JSON.stringify(data)}`);
    tokenCache.set(cacheKey, {
      token: data.access_token as string,
      exp: now + ((data.expires_in as number) || 3600),
    });
    return data.access_token as string;
  })().finally(() => { tokenPromises.delete(cacheKey); });

  tokenPromises.set(cacheKey, promise);
  return promise;
}

// ---- Auth mode detection ----

function isApiKeyMode(config: Record<string, string>): boolean {
  return !!(config.apiKey);
}

function isJwtMode(config: Record<string, string>): boolean {
  return !!(config.serviceAccountEmail && config.privateKey);
}

// ---- Upstream URL ----

function buildUpstreamUrl(config: Record<string, string>): string {
  const { projectId, location } = config;
  if (!projectId) throw new Error('Vertex AI: Missing projectId');
  const loc = location || 'us-central1';
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/endpoints/openapi`;
}

// ---- Proxy request ----

export async function proxyRequest(
  request: Request, env: Env, provider: Provider, suffix: string
): Promise<Response> {
  const config = provider.config;
  if (!isApiKeyMode(config) && !isJwtMode(config)) {
    throw new Error(
      'Vertex AI: Missing authentication. Provide apiKey or serviceAccountEmail+privateKey.'
    );
  }

  const upstreamUrl = new URL(buildUpstreamUrl(config));
  upstreamUrl.pathname += suffix;
  const reqUrl = new URL(request.url);
  upstreamUrl.search = reqUrl.search;

  const headers = new Headers(request.headers);
  headers.delete('Authorization');

  if (isApiKeyMode(config)) {
    headers.set('Authorization', `Bearer ${config.apiKey}`);
  } else {
    const accessToken = await getAccessToken(env, config);
    headers.set('Authorization', `Bearer ${accessToken}`);
    headers.set('x-goog-user-project', config.projectId);
  }

  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  return fetch(new Request(upstreamUrl.toString(), {
    method: request.method, headers, body: request.body,
  }));
}

// ---- Model list ----

export async function fetchModelList(
  env: Env, config: Record<string, string>
): Promise<Model[]> {
  try {
    const url = new URL('https://aiplatform.googleapis.com/v1beta1/publishers/google/models');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('listAllVersions', 'false');
    url.searchParams.set('languageCode', 'en');

    let headers: Record<string, string>;
    if (isApiKeyMode(config)) {
      headers = { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' };
    } else {
      const accessToken = await getAccessToken(env, config);
      headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    }

    const models: Model[] = [];
    let pageToken = '';
    for (let i = 0; i < 3; i++) {
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetch(url, { headers });
      const data = await resp.json() as Record<string, unknown>;
      if (!resp.ok) break;
      const items = Array.isArray(data.publisherModels)
        ? data.publisherModels as Array<{ name: string }>
        : [];
      for (const item of items) {
        const last = String(item.name || '').split('/').pop();
        if (last) models.push({ id: last, object: 'model', created: 0, owned_by: 'google' });
      }
      pageToken = String(data.nextPageToken || '');
      if (!pageToken) break;
    }
    return models;
  } catch { return []; }
}
