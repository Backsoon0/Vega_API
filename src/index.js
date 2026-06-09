// src/index.js
const ACCESS_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_CACHE_SKEW_SECONDS = 60;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_FALLBACK_MODELS = [
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "google/gemini-2.0-flash",
  "google/gemini-2.0-flash-lite",
];

let cachedAccessToken = null;
let cachedAccessTokenExp = 0;
let accessTokenPromise = null;

let cachedModels = null;
let cachedModelsAt = 0;
let modelsPromise = null;

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

function normalizePem(pem) {
  return String(pem || "")
    .replace(/\\n/g, "\n")
    .trim();
}

function pemToArrayBuffer(pem) {
  const clean = normalizePem(pem)
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

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

function splitModelList(input) {
  if (!input) return [];
  const raw = String(input).trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      // fall through to delimiter split
    }
  }

  return raw
    .split(/[,\n\r\t ]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeModelId(model, env) {
  let id = String(model || "").trim();

  if (!id) {
    id = env.DEFAULT_MODEL || DEFAULT_FALLBACK_MODELS[0];
  }

  if (id.startsWith("publishers/google/models/")) {
    id = `google/${id.split("/").pop()}`;
  }

  if (id.startsWith("models/")) {
    id = `google/${id.split("/").pop()}`;
  }

  if (!id.includes("/")) {
    id = `google/${id}`;
  }

  return id;
}

function extractModelIdFromPublisherName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const last = raw.split("/").pop();
  if (!last) return "";
  return `google/${last}`;
}

async function getSigningKey(env) {
  if (!env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing GOOGLE_PRIVATE_KEY");
  }

  const imported = crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return imported;
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);

  if (cachedAccessToken && now < cachedAccessTokenExp - TOKEN_CACHE_SKEW_SECONDS) {
    return cachedAccessToken;
  }

  if (accessTokenPromise) return accessTokenPromise;

  accessTokenPromise = (async () => {
    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL");
    }

    const key = await getSigningKey(env);

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const payload = {
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    const data = await tokenResp.json().catch(() => ({}));

    if (!tokenResp.ok) {
      throw new Error(
        `Token exchange failed (${tokenResp.status}): ${JSON.stringify(data)}`
      );
    }

    cachedAccessToken = data.access_token;
    cachedAccessTokenExp = now + (data.expires_in || 3600);
    return cachedAccessToken;
  })().finally(() => {
    accessTokenPromise = null;
  });

  return accessTokenPromise;
}

function buildUpstreamBaseUrl(env) {
  const projectId = env.GOOGLE_PROJECT_ID;
  const location = env.GOOGLE_LOCATION || "us-central1";
  if (!projectId) throw new Error("Missing GOOGLE_PROJECT_ID");

//   return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/endpoints/openapi`;
}

function buildPublisherModelsUrl(env, pageToken = "") {
  const location = env.GOOGLE_LOCATION || "us-central1";
//   const base = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/google/models`;
  const base = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models`;
  const url = new URL(base);
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("listAllVersions", "false");
  url.searchParams.set("languageCode", "en");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

async function loadModels(env, accessToken) {
  const now = Date.now();
  if (cachedModels && now - cachedModelsAt < MODEL_CACHE_TTL_MS) {
    return cachedModels;
  }
  if (modelsPromise) return modelsPromise;

  modelsPromise = (async () => {
    const seen = new Set();
    const out = [];

    const pushModel = (id, source = "google") => {
      const clean = String(id || "").trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      out.push({
        id: clean,
        object: "model",
        created: 0,
        owned_by: source,
      });
    };

    for (const fallback of splitModelList(env.MODEL_IDS) || DEFAULT_FALLBACK_MODELS) {
      pushModel(normalizeModelId(fallback, env), "configured");
    }

    let pageToken = "";
    for (let i = 0; i < 3; i++) {
      try {
        const url = buildPublisherModelsUrl(env, pageToken);
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
          const id =
            extractModelIdFromPublisherName(item.name) ||
            normalizeModelId(item.displayName, env);

          if (!id) continue;
          pushModel(id, "google");
        }

        pageToken = String(data.nextPageToken || "");
        if (!pageToken) break;
      } catch {
        break;
      }
    }

    if (out.length === 0) {
      for (const fallback of DEFAULT_FALLBACK_MODELS) {
        pushModel(fallback, "fallback");
      }
    }

    cachedModels = out;
    cachedModelsAt = Date.now();
    return out;
  })().finally(() => {
    modelsPromise = null;
  });

  return modelsPromise;
}

async function handleModelsRoute(request, env) {
  const accessToken = await getAccessToken(env);
  const models = await loadModels(env, accessToken);

  const url = new URL(request.url);
  const modelId = url.pathname.startsWith("/v1/models/")
    ? decodeURIComponent(url.pathname.slice("/v1/models/".length))
    : "";

  if (modelId) {
    const found = models.find((m) => m.id === modelId);
    if (!found) {
      return json(
        { error: { message: `Model not found: ${modelId}`, type: "invalid_request_error" } },
        404
      );
    }
    return json(found, 200);
  }

  return json({
    object: "list",
    data: models,
  });
}

async function buildOpenAiCompatUpstreamRequest(request, env) {
  const url = new URL(request.url);
  const suffix = url.pathname.slice("/v1".length); // e.g. /chat/completions

  const upstreamUrl = new URL(buildUpstreamBaseUrl(env));
  upstreamUrl.pathname += suffix;
  upstreamUrl.search = url.search;

  // For chat completions we can make the common case friendlier:
  // inject a default model and normalize plain IDs.
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { error: json({ error: { message: "Invalid JSON body" } }, 400) };
    }

    body.model = normalizeModelId(body.model, env);

	console.log("model =", body.model);

    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${await getAccessToken(env)}`);
    headers.set("Content-Type", "application/json");
    headers.set("x-goog-user-project", env.GOOGLE_PROJECT_ID);

    return {
      upstreamUrl: upstreamUrl.toString(),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  }

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${await getAccessToken(env)}`);
  headers.set("x-goog-user-project", env.GOOGLE_PROJECT_ID);

  // Keep original body/stream for all other routes.
  const upstreamReq = new Request(upstreamUrl.toString(), request);
  for (const [k, v] of headers.entries()) {
    upstreamReq.headers.set(k, v);
  }

  return { upstreamReq };
}

function checkClientAuth(request, env) {
  if (!env.OPENAI_API_KEY) return true;

  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.OPENAI_API_KEY}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (!checkClientAuth(request, env)) {
      return withCors(
        json({ error: { message: "Unauthorized" } }, 401),
        request
      );
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return withCors(
        json({
          ok: true,
          message: "Vertex AI OpenAI-compatible proxy is running",
          routes: [
            "/v1/chat/completions",
            "/v1/models",
            "/v1/models/{model}",
          ],
        }),
        request
      );
    }

    if (url.pathname === "/v1/models" || url.pathname.startsWith("/v1/models/")) {
      try {
        const resp = await handleModelsRoute(request, env);
        return withCors(resp, request);
      } catch (err) {
        return withCors(
          json(
            {
              error: {
                message: err?.message || "Failed to list models",
                type: "server_error",
              },
            },
            500
          ),
          request
        );
      }
    }

    if (!url.pathname.startsWith("/v1/")) {
      return withCors(
        json({ error: { message: "Not Found" } }, 404),
        request
      );
    }

    try {
      const built = await buildOpenAiCompatUpstreamRequest(request, env);
      if (built.error) return withCors(built.error, request);

      const upstreamResp = built.upstreamReq
        ? await fetch(built.upstreamReq)
        : await fetch(built.upstreamUrl, built.init);

      return withCors(upstreamResp, request);
    } catch (err) {
      return withCors(
        json(
          {
            error: {
              message: err?.message || "Upstream request failed",
              type: "server_error",
            },
          },
          502
        ),
        request
      );
    }
  },
};