// src/config.js
// KV-based configuration CRUD for API providers

import { encrypt, decrypt } from "./crypto.js";

// Cache version counter stored in KV (cross-isolate safe).
// Incremented on every save/delete so index.js can detect stale cache.
const KV_PREFIX = "config:";
const KEY_PROVIDERS = `${KV_PREFIX}providers`;
const KEY_ADMIN_PASSWORD = `${KV_PREFIX}admin_password`;
const KEY_DEFAULT_PROVIDER = `${KV_PREFIX}default_provider`;
const KEY_CONFIG_VERSION = `${KV_PREFIX}version`;

export async function getConfigVersion(env) {
  const raw = await env.VEGA_API_CONFIG.get(KEY_CONFIG_VERSION);
  return raw ? parseInt(raw, 10) : 0;
}

async function bumpConfigVersion(env) {
  const current = await getConfigVersion(env);
  await env.VEGA_API_CONFIG.put(KEY_CONFIG_VERSION, String(current + 1));
}

function providerKey(id) {
  return `${KV_PREFIX}provider:${id}`;
}

/**
 * Get the list of all provider IDs.
 */
async function getProviderIds(env) {
  const raw = await env.VEGA_API_CONFIG.get(KEY_PROVIDERS);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Save the list of provider IDs.
 */
async function saveProviderIds(env, ids) {
  await env.VEGA_API_CONFIG.put(KEY_PROVIDERS, JSON.stringify(ids));
}

/**
 * List all providers with their full config (decrypted).
 * Uses parallel KV reads for performance.
 */
export async function listProviders(env) {
  const ids = await getProviderIds(env);
  const providers = [];

  // Parallel read all providers
  const records = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await env.VEGA_API_CONFIG.get(providerKey(id), "json");
        if (!raw) return null;
        return { id, raw };
      } catch {
        // Corrupted data, skip
        console.error(`Failed to parse provider ${id} from KV`);
        return null;
      }
    })
  );

  // Decrypt sensitive fields
  for (const record of records) {
    if (!record) continue;
    try {
      const config = { ...record.raw };
      if (config.config) {
        for (const [key, val] of Object.entries(config.config)) {
          if (typeof val === "string" && val.startsWith("enc:")) {
            config.config[key] = await decrypt(env, val);
          }
        }
      }
      providers.push(config);
    } catch (err) {
      console.error(`Failed to load provider ${record.id}:`, err.message);
    }
  }

  return providers;
}

/**
 * List providers without decrypting sensitive fields (for admin list display).
 * Uses parallel KV reads.
 */
export async function listProvidersMasked(env) {
  const ids = await getProviderIds(env);
  const providers = [];

  const records = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await env.VEGA_API_CONFIG.get(providerKey(id), "json");
        if (!raw) return null;
        return { id, raw };
      } catch {
        console.error(`Failed to parse provider ${id} from KV`);
        return null;
      }
    })
  );

  for (const record of records) {
    if (!record) continue;
    const masked = { ...record.raw };
    if (masked.config) {
      masked.config = { ...masked.config };
      for (const [key, val] of Object.entries(masked.config)) {
        if (typeof val === "string" && val.startsWith("enc:")) {
          masked.config[key] = "***encrypted***";
        }
      }
    }
    providers.push(masked);
  }

  return providers;
}

/**
 * Get a single provider by ID (decrypted).
 */
export async function getProvider(env, id) {
  let raw;
  try {
    raw = await env.VEGA_API_CONFIG.get(providerKey(id), "json");
  } catch {
    // Corrupted data
    return null;
  }
  if (!raw) return null;

  const config = { ...raw };
  if (config.config) {
    for (const [key, val] of Object.entries(config.config)) {
      if (typeof val === "string" && val.startsWith("enc:")) {
        config.config[key] = await decrypt(env, val);
      }
    }
  }
  return config;
}

/**
 * Get a provider without decrypting (for internal use: merging during save).
 */
async function getProviderRaw(env, id) {
  try {
    return await env.VEGA_API_CONFIG.get(providerKey(id), "json");
  } catch {
    return null;
  }
}

/**
 * Create or update a provider. Encrypts sensitive fields automatically.
 * Preserves existing encrypted values when the new value is empty or masked.
 */
export async function saveProvider(env, provider) {
  const { id, type, name, enabled, config, models, weight } = provider;

  if (!id || !type || !name) {
    throw new Error("Provider must have id, type, and name");
  }

  const VALID_TYPES = ["vertex_ai", "google_ai_studio", "openai"];
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid provider type: ${type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }

  // Encrypt sensitive config fields (apiKey, privateKey, etc.)
  const encryptedConfig = { ...config };
  const sensitiveKeys = ["apiKey", "privateKey"];

  // Merge with existing record: keep old encrypted values for empty/masked fields
  const existing = await getProviderRaw(env, id);
  const oldConfig = existing ? (existing.config || {}) : {};

  for (const key of sensitiveKeys) {
    const newVal = encryptedConfig[key];
    if (!newVal || newVal === "***encrypted***" || newVal.trim() === "") {
      // Keep existing encrypted value (user didn't change this field)
      if (oldConfig[key]) {
        encryptedConfig[key] = oldConfig[key];
      } else {
        delete encryptedConfig[key];
      }
    } else if (!newVal.startsWith("enc:")) {
      // New plaintext value → encrypt it
      encryptedConfig[key] = await encrypt(env, newVal);
    }
    // If it already starts with "enc:", keep as-is
  }

  const record = {
    id,
    type,
    name,
    enabled: enabled !== false, // default true
    config: encryptedConfig,
    models: models || [],
    weight: weight || 1,
  };

  await env.VEGA_API_CONFIG.put(providerKey(id), JSON.stringify(record));

  // Update provider ID list if this is new
  const ids = await getProviderIds(env);
  if (!ids.includes(id)) {
    ids.push(id);
    await saveProviderIds(env, ids);
  }

  bumpConfigVersion(env);
  return record;
}

/**
 * Delete a provider.
 */
export async function deleteProvider(env, id) {
  await env.VEGA_API_CONFIG.delete(providerKey(id));

  const ids = await getProviderIds(env);
  const filtered = ids.filter((x) => x !== id);
  await saveProviderIds(env, filtered);
  bumpConfigVersion();
}

/**
 * Get the admin password hash.
 */
export async function getAdminPasswordHash(env) {
  return env.VEGA_API_CONFIG.get(KEY_ADMIN_PASSWORD);
}

/**
 * Set the admin password hash.
 */
export async function setAdminPassword(env, hash) {
  await env.VEGA_API_CONFIG.put(KEY_ADMIN_PASSWORD, hash);
}

/**
 * Get the default provider ID.
 */
export async function getDefaultProviderId(env) {
  return env.VEGA_API_CONFIG.get(KEY_DEFAULT_PROVIDER);
}

/**
 * Set the default provider ID.
 */
export async function setDefaultProvider(env, id) {
  await env.VEGA_API_CONFIG.put(KEY_DEFAULT_PROVIDER, id);
}

// ---- Client API Key (for /v1/* access control) ----

const KEY_CLIENT_API_KEY = `${KV_PREFIX}client_api_key`;

/**
 * Get the client API key (decrypted). Returns null if not set.
 * This key is used to authenticate requests to /v1/* routes.
 */
export async function getClientApiKey(env) {
  const raw = await env.VEGA_API_CONFIG.get(KEY_CLIENT_API_KEY);
  if (!raw) return null;
  return decrypt(env, raw);
}

/**
 * Set the client API key (encrypted storage).
 * Pass null to remove the key (disable auth).
 */
export async function setClientApiKey(env, key) {
  if (!key) {
    await env.VEGA_API_CONFIG.delete(KEY_CLIENT_API_KEY);
  } else {
    const encrypted = await encrypt(env, key);
    await env.VEGA_API_CONFIG.put(KEY_CLIENT_API_KEY, encrypted);
  }
}
