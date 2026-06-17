// src/config.ts
// D1-based configuration CRUD for providers, admin password, client API key

import type { Env, Provider, ProviderRow, ApiKeyInfo } from './types';
import { encrypt, decrypt, hashKey } from './crypto';

// ---- Config table helpers ----

async function getConfig(env: Env, key: string): Promise<string | null> {
  const row = await env.DB
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setConfig(env: Env, key: string, value: string): Promise<void> {
  await env.DB
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run();
}

async function deleteConfig(env: Env, key: string): Promise<void> {
  await env.DB
    .prepare('DELETE FROM config WHERE key = ?')
    .bind(key)
    .run();
}

// ---- Config version (for cache invalidation) ----

export async function getConfigVersion(env: Env): Promise<number> {
  const raw = await getConfig(env, 'config_version');
  return raw ? parseInt(raw, 10) : 0;
}

async function bumpConfigVersion(env: Env): Promise<void> {
  const current = await getConfigVersion(env);
  await setConfig(env, 'config_version', String(current + 1));
}

// ---- Providers ----

function rowToProvider(row: ProviderRow, decryptedConfig: Record<string, string>): Provider {
  return {
    id: row.id,
    type: row.type as Provider['type'],
    name: row.name,
    enabled: row.enabled === 1,
    config: decryptedConfig,
    models: JSON.parse(row.models || '[]'),
    weight: row.weight,
  };
}

/** Mask encrypted values in config object — replaces "enc:..." with "***encrypted***". */
function maskSensitiveConfig(config: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = { ...config };
  for (const [key, val] of Object.entries(masked)) {
    if (typeof val === 'string' && val.startsWith('enc:')) {
      masked[key] = '***encrypted***';
    }
  }
  return masked;
}

export async function listProviders(env: Env): Promise<Provider[]> {
  const rows = await env.DB
    .prepare('SELECT * FROM providers ORDER BY id')
    .all<ProviderRow>();
  if (!rows.results?.length) return [];

  const providers: Provider[] = [];
  for (const row of rows.results) {
    const config = JSON.parse(row.config || '{}');
    for (const [key, val] of Object.entries(config)) {
      if (typeof val === 'string' && val.startsWith('enc:')) {
        config[key] = await decrypt(env, val as string);
      }
    }
    providers.push(rowToProvider(row, config));
  }
  return providers;
}

export async function listProvidersMasked(env: Env): Promise<Provider[]> {
  const rows = await env.DB
    .prepare('SELECT * FROM providers ORDER BY id')
    .all<ProviderRow>();
  if (!rows.results?.length) return [];

  return rows.results.map(row => {
    const config = JSON.parse(row.config || '{}');
    return rowToProvider(row, maskSensitiveConfig(config));
  });
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const row = await env.DB
    .prepare('SELECT * FROM providers WHERE id = ?')
    .bind(id)
    .first<ProviderRow>();
  if (!row) return null;

  const config: Record<string, string> = JSON.parse(row.config || '{}');
  for (const [key, val] of Object.entries(config)) {
    if (typeof val === 'string' && val.startsWith('enc:')) {
      config[key] = await decrypt(env, val as string);
    }
  }
  return rowToProvider(row, config);
}

/** Get a single provider with sensitive fields masked (for admin API). */
export async function getProviderMasked(env: Env, id: string): Promise<Provider | null> {
  const row = await env.DB
    .prepare('SELECT * FROM providers WHERE id = ?')
    .bind(id)
    .first<ProviderRow>();
  if (!row) return null;

  const config = JSON.parse(row.config || '{}');
  return rowToProvider(row, maskSensitiveConfig(config));
}

async function getProviderRaw(env: Env, id: string): Promise<ProviderRow | null> {
  return env.DB
    .prepare('SELECT * FROM providers WHERE id = ?')
    .bind(id)
    .first<ProviderRow>();
}

export async function saveProvider(
  env: Env,
  provider: Partial<Provider> & { id: string }
): Promise<Provider> {
  const { id, type, name, enabled, config = {}, models = [], weight = 1 } = provider;

  if (!id || !type || !name) {
    throw new Error('Provider must have id, type, and name');
  }

  const VALID_TYPES = ['vertex_ai', 'google_ai_studio', 'openai', 'anthropic'];
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid provider type: ${type}`);
  }

  const encryptedConfig: Record<string, string> = { ...config };
  const sensitiveKeys = ['apiKey', 'privateKey'];

  const existing = await getProviderRaw(env, id);
  const oldConfig: Record<string, string> = existing
    ? JSON.parse(existing.config || '{}')
    : {};

  for (const key of sensitiveKeys) {
    const newVal = encryptedConfig[key];
    if (!newVal || newVal === '***encrypted***' || newVal.trim() === '') {
      if (oldConfig[key]) {
        encryptedConfig[key] = oldConfig[key];
      } else {
        delete encryptedConfig[key];
      }
    } else if (!newVal.startsWith('enc:')) {
      encryptedConfig[key] = await encrypt(env, newVal);
    }
  }

  const enabledInt = enabled !== false ? 1 : 0;

  await env.DB
    .prepare(
      `INSERT OR REPLACE INTO providers (id, type, name, enabled, config, models, weight)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, type, name, enabledInt, JSON.stringify(encryptedConfig), JSON.stringify(models), weight)
    .run();

  await bumpConfigVersion(env);
  return {
    id, type: type as Provider['type'], name,
    enabled: enabledInt === 1, config: maskSensitiveConfig(encryptedConfig), models, weight,
  };
}

export async function deleteProvider(env: Env, id: string): Promise<void> {
  await env.DB
    .prepare('DELETE FROM providers WHERE id = ?')
    .bind(id)
    .run();
  await bumpConfigVersion(env);
}

// ---- Admin password ----

export async function getAdminPasswordHash(env: Env): Promise<string | null> {
  return getConfig(env, 'admin_password');
}

export async function setAdminPassword(env: Env, hash: string): Promise<void> {
  await setConfig(env, 'admin_password', hash);
}

// ---- Client API Key ----

export async function getClientApiKey(env: Env): Promise<string | null> {
  const raw = await getConfig(env, 'client_api_key');
  if (!raw) return null;
  return decrypt(env, raw);
}

export async function setClientApiKey(env: Env, key: string | null): Promise<void> {
	if (!key) {
		await deleteConfig(env, 'client_api_key');
	} else {
		const encrypted = await encrypt(env, key);
		await setConfig(env, 'client_api_key', encrypted);
	}
}

// ---- API Keys (multi-key) ----

export async function listApiKeys(env: Env): Promise<ApiKeyInfo[]> {
	const rows = await env.DB
		.prepare('SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY id')
		.all<{ id: number; name: string; created_at: string; last_used_at: string | null }>();
	return (rows.results || []).map((r) => ({
		id: r.id,
		name: r.name,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	}));
}

export async function createApiKey(env: Env, name: string, key: string): Promise<ApiKeyInfo> {
	const hash = await hashKey(key);
	const encrypted = await encrypt(env, key);
	const now = new Date().toISOString();
	await env.DB
		.prepare('INSERT INTO api_keys (name, key_hash, encrypted_key, created_at) VALUES (?, ?, ?, ?)')
		.bind(name, hash, encrypted, now)
		.run();
	const row = await env.DB
		.prepare('SELECT id, name, created_at, last_used_at FROM api_keys WHERE key_hash = ?')
		.bind(hash)
		.first<{ id: number; name: string; created_at: string; last_used_at: string | null }>();
	return { id: row!.id, name: row!.name, createdAt: row!.created_at, lastUsedAt: row!.last_used_at };
}

export async function deleteApiKey(env: Env, id: number): Promise<boolean> {
	const result = await env.DB
		.prepare('DELETE FROM api_keys WHERE id = ?')
		.bind(id)
		.run();
	return result.meta.changes > 0;
}

export async function renameApiKey(env: Env, id: number, name: string): Promise<boolean> {
	const result = await env.DB
		.prepare('UPDATE api_keys SET name = ? WHERE id = ?')
		.bind(name, id)
		.run();
	return result.meta.changes > 0;
}

/**
 * Migrate the legacy single key (config.client_api_key) into the api_keys table with a name.
 * Returns the new key info or null if no legacy key exists.
 */
export async function migrateLegacyApiKey(env: Env, name: string): Promise<ApiKeyInfo | null> {
	const legacyKey = await getClientApiKey(env);
	if (!legacyKey) return null;

	const hash = await hashKey(legacyKey);
	const encrypted = await encrypt(env, legacyKey);
	const now = new Date().toISOString();

	// Check if this key already exists in api_keys (by hash)
	const existing = await env.DB
		.prepare('SELECT id FROM api_keys WHERE key_hash = ?')
		.bind(hash)
		.first<{ id: number }>();
	if (existing) {
		// Key already migrated — just update the name and delete legacy
		await renameApiKey(env, existing.id, name);
		await setClientApiKey(env, null);
		return { id: existing.id, name, createdAt: now, lastUsedAt: null };
	}

	await env.DB
		.prepare('INSERT INTO api_keys (name, key_hash, encrypted_key, created_at) VALUES (?, ?, ?, ?)')
		.bind(name, hash, encrypted, now)
		.run();

	// Delete the legacy key from config
	await setClientApiKey(env, null);

	const row = await env.DB
		.prepare('SELECT id, name, created_at, last_used_at FROM api_keys WHERE key_hash = ?')
		.bind(hash)
		.first<{ id: number; name: string; created_at: string; last_used_at: string | null }>();
	if (!row) return null;
	return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

export async function updateApiKeyLastUsed(env: Env, keyHash: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB
		.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?')
		.bind(now, keyHash)
		.run();
}

/**
 * Look up an API key by its hash. Returns the key name if found, null otherwise.
 * Also updates last_used_at on successful lookup.
 */
export async function findApiKeyNameByHash(env: Env, keyHash: string): Promise<{ id: number; name: string } | null> {
	const row = await env.DB
		.prepare('SELECT id, name FROM api_keys WHERE key_hash = ?')
		.bind(keyHash)
		.first<{ id: number; name: string }>();
	if (!row) return null;
	await updateApiKeyLastUsed(env, keyHash);
	return { id: row.id, name: row.name };
}

// ---- Failover config ----

export async function getFailoverEnabled(env: Env): Promise<boolean> {
	const raw = await getConfig(env, 'failover_enabled');
	if (raw === null) return false;
	return raw === '1';
}

export async function setFailoverEnabled(env: Env, enabled: boolean): Promise<void> {
	await setConfig(env, 'failover_enabled', enabled ? '1' : '0');
}
