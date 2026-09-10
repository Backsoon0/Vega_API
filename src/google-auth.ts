// src/google-auth.ts
// Google auth utilities (app-wide, not tied to any single consumer):
// service-account JWT → OAuth access token exchange for Vertex AI, plus
// API-key/JWT mode detection. No internal imports — Web Crypto only.
// Consumers: src/ai-providers.ts (AI SDK factory), src/providers/vertex.ts
// (model-list fetch), src/routes/* (Vertex passthrough).

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

async function getSigningKey(privateKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		pemToArrayBuffer(privateKey),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
}

// ---- Access token (JWT service account → OAuth access token) ----

export async function getVertexAccessToken(config: Record<string, string>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const { serviceAccountEmail, privateKey } = config;
	if (!serviceAccountEmail) throw new Error('Vertex AI: Missing serviceAccountEmail');
	if (!privateKey) throw new Error('Vertex AI: Missing privateKey');

	// Cache key includes a fingerprint of the private key so a rotated key
	// (same service account email) does not reuse the old token until expiry.
	const cacheKey = `${serviceAccountEmail}:${normalizePem(privateKey).slice(-64)}`;

	// Periodic eviction of expired entries
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
		const key = await getSigningKey(privateKey);
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
			'RSASSA-PKCS1-v1_5',
			key,
			new TextEncoder().encode(unsignedJwt),
		);
		const jwt = `${unsignedJwt}.${base64UrlEncode(new Uint8Array(signature))}`;
		const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: jwt,
			}),
			signal: AbortSignal.timeout(30_000),
		});
		const data = (await tokenResp.json()) as Record<string, unknown>;
		if (!tokenResp.ok)
			throw new Error(`Vertex AI token exchange failed (${tokenResp.status}): ${JSON.stringify(data)}`);
		tokenCache.set(cacheKey, {
			token: data.access_token as string,
			exp: now + ((data.expires_in as number) || 3600),
		});
		return data.access_token as string;
	})().finally(() => {
		tokenPromises.delete(cacheKey);
	});

	tokenPromises.set(cacheKey, promise);
	return promise;
}

// ---- Auth mode detection ----

export function isVertexApiKeyMode(config: Record<string, string>): boolean {
	return !!(config.apiKey);
}
