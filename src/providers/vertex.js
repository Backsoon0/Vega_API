// src/providers/vertex.js
// Google Vertex AI backend proxy
// Supports two authentication modes:
//   1. Service Account (JWT RS256)
//   2. API Key
// Both modes use the OpenAI-compatible endpoint (pass-through, no format conversion).

const ACCESS_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_CACHE_SKEW_SECONDS = 60;

// Token cache keyed by service account email (supports multiple Vertex AI providers)
const tokenCache = new Map(); // email → { token, exp }
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

// ---- Token management (JWT mode) ----

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

// ---- Auth mode detection ----

function isApiKeyMode(config) {
	return !!(config.apiKey);
}

function isJwtMode(config) {
	return !!(config.serviceAccountEmail && config.privateKey);
}

// ---- Upstream URL building ----

/**
 * Build the upstream URL for Vertex AI OpenAI-compatible endpoint.
 * Both auth modes use the same endpoint.
 */
export function buildUpstreamUrl(config) {
	const { projectId, location } = config;
	if (!projectId) throw new Error("Vertex AI: Missing projectId");
	const loc = location || "us-central1";
	return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/endpoints/openapi`;
}

// ---- Request proxying ----

/**
 * Build and proxy a request to Vertex AI (pass-through, no format conversion).
 * Supports both API Key mode and JWT mode.
 */
export async function proxyRequest(request, env, provider, suffix) {
	const config = provider.config;

	const useApiKey = isApiKeyMode(config);
	const useJwt = isJwtMode(config);

	if (!useApiKey && !useJwt) {
		throw new Error(
			"Vertex AI: Missing authentication. Provide apiKey for API Key mode, or serviceAccountEmail + privateKey for JWT mode."
		);
	}

	const upstreamBase = buildUpstreamUrl(config);
	const upstreamUrl = new URL(upstreamBase);
	upstreamUrl.pathname += suffix;

	// Copy original URL search params
	const reqUrl = new URL(request.url);
	upstreamUrl.search = reqUrl.search;

	const headers = new Headers(request.headers);
	// Remove incoming Authorization — it's the client key, not the provider key
	headers.delete("Authorization");

	if (useApiKey) {
		// API Key mode
		headers.set("Authorization", `Bearer ${config.apiKey}`);
	} else {
		// JWT mode
		const accessToken = await getAccessToken(env, config);
		headers.set("Authorization", `Bearer ${accessToken}`);
		headers.set("x-goog-user-project", config.projectId);
	}

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

// ---- Model list ----

/**
 * Fetch available models from Vertex AI publisher API.
 * Supports both API Key and JWT modes.
 */
export async function fetchModelList(env, config) {
	try {
		const base = `https://aiplatform.googleapis.com/v1beta1/publishers/google/models`;
		const url = new URL(base);
		url.searchParams.set("pageSize", "100");
		url.searchParams.set("listAllVersions", "false");
		url.searchParams.set("languageCode", "en");

		let headers;
		if (isApiKeyMode(config)) {
			headers = {
				"x-goog-api-key": config.apiKey,
				"Content-Type": "application/json",
			};
		} else {
			const accessToken = await getAccessToken(env, config);
			headers = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			};
		}

		const models = [];
		let pageToken = "";
		for (let i = 0; i < 3; i++) {
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			const resp = await fetch(url, { headers });
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
		}

		return models;
	} catch {
		return [];
	}
}
