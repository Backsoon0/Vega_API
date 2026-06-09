// src/providers/vertex.js
// Google Vertex AI backend proxy
// Uses JWT service account authentication (RS256)

const ACCESS_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_CACHE_SKEW_SECONDS = 60;

// Token cache keyed by service account email (supports multiple Vertex AI providers)
const tokenCache = new Map();  // email → { token, exp }
const tokenPromises = new Map(); // email → Promise

// ---- JWT helpers ----

function normalizePem(pem) {
  return String(pem || "")
    .replace(/\\n/g, "\n")
    .trim();
}

function pemToArrayBuffer(pem) {
  let clean = normalizePem(pem)
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  // Remove any non-base64 characters that might have slipped in
  clean = clean.replace(/[^A-Za-z0-9+/=]/g, "");

  if (!clean) {
    throw new Error("Vertex AI: Invalid private key — PEM is empty after cleaning");
  }

  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

// ---- Token management ----

async function getSigningKey(env, privateKey) {
  const imported = crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return imported;
}

async function getAccessToken(env, config) {
  const now = Math.floor(Date.now() / 1000);
  const { serviceAccountEmail, privateKey } = config;

  if (!serviceAccountEmail) throw new Error("Vertex AI: Missing serviceAccountEmail");
  if (!privateKey) throw new Error("Vertex AI: Missing privateKey");

  const cacheKey = serviceAccountEmail;

  // Check cache (per service account)
  const cached = tokenCache.get(cacheKey);
  if (cached && now < cached.exp - TOKEN_CACHE_SKEW_SECONDS) {
    return cached.token;
  }

  // Deduplicate concurrent token requests
  const pending = tokenPromises.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    const key = await getSigningKey(env, privateKey);

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: serviceAccountEmail,
      scope: ACCESS_TOKEN_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    const unsignedJwt =
      `${base64UrlEncodeString(JSON.stringify(header))}.` +
      `${base64UrlEncodeString(JSON.stringify(payload))}`;

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsignedJwt)
    );

    const jwt = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    const data = await tokenResp.json().catch(() => ({}));

    if (!tokenResp.ok) {
      throw new Error(
        `Vertex AI token exchange failed (${tokenResp.status}): ${JSON.stringify(data)}`
      );
    }

    tokenCache.set(cacheKey, {
      token: data.access_token,
      exp: now + (data.expires_in || 3600),
    });
    return data.access_token;
  })().finally(() => {
    tokenPromises.delete(cacheKey);
  });

  tokenPromises.set(cacheKey, promise);
  return promise;
}

// ---- Upstream request building ----

/**
 * Build the upstream URL for Vertex AI.
 */
export function buildUpstreamUrl(config) {
  const { projectId, location } = config;
  if (!projectId) throw new Error("Vertex AI: Missing projectId");
  const loc = location || "us-central1";
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/endpoints/openapi`;
}

/**
 * Build and proxy a request to Vertex AI.
 */
export async function proxyRequest(request, env, provider, suffix) {
  const config = provider.config;
  const accessToken = await getAccessToken(env, config);
  const upstreamBase = buildUpstreamUrl(config);
  const upstreamUrl = new URL(upstreamBase);
  upstreamUrl.pathname += suffix;

  // Copy original URL search params
  const reqUrl = new URL(request.url);
  upstreamUrl.search = reqUrl.search;

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("x-goog-user-project", config.projectId);
  // Vertex AI requires Content-Type, but we keep original
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const upstreamReq = new Request(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
  });

  return fetch(upstreamReq);
}

/**
 * Fetch available models from Vertex AI publisher API.
 */
export async function fetchModelList(env, config) {
  const accessToken = await getAccessToken(env, config);
  const loc = config.location || "us-central1";
  const base = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models`;
  const url = new URL(base);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("listAllVersions", "false");
  url.searchParams.set("languageCode", "en");

  const models = [];

  let pageToken = "";
  for (let i = 0; i < 3; i++) {
    try {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) break;

      const items = Array.isArray(data.publisherModels) ? data.publisherModels : [];
      for (const item of items) {
        const raw = String(item.name || "").trim();
        const last = raw.split("/").pop();
        if (last) {
          models.push({
            id: `google/${last}`,
            object: "model",
            created: 0,
            owned_by: "google",
          });
        }
      }

      pageToken = String(data.nextPageToken || "");
      if (!pageToken) break;
    } catch {
      break;
    }
  }

  return models;
}
