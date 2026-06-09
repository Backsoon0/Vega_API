// src/crypto.js
// AES-GCM encryption/decryption for API keys stored in KV
//
// Requires ENCRYPTION_KEY secret (64 hex chars = 32 bytes for AES-256)
// Set via: wrangler secret put ENCRYPTION_KEY

const ENC_PREFIX = "enc:";

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

let cachedKey = null;

/**
 * Get or create the AES-GCM CryptoKey from the ENCRYPTION_KEY secret.
 */
async function getEncryptionKey(env) {
  if (cachedKey) return cachedKey;

  const hexKey = env.ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error(
      "ENCRYPTION_KEY secret is not set. Run: wrangler secret put ENCRYPTION_KEY"
    );
  }

  const rawKey = hexToBytes(hexKey.trim());
  if (rawKey.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 64 hex characters (32 bytes), got ${rawKey.length} bytes. ` +
      `Generate one with: openssl rand -hex 32`
    );
  }

  cachedKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  return cachedKey;
}

/**
 * Encrypt a plaintext string. Returns "enc:<base64>" format.
 * Format: enc:base64(iv(12 bytes) + ciphertext + auth_tag)
 */
export async function encrypt(env, plaintext) {
  if (!plaintext) return "";

  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return ENC_PREFIX + bytesToBase64(combined);
}

/**
 * Decrypt an "enc:<base64>" string back to plaintext.
 * If the value doesn't start with "enc:", it's returned as-is (not encrypted).
 */
export async function decrypt(env, value) {
  if (!value) return "";
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) {
    return value; // Not encrypted, return as-is
  }

  const key = await getEncryptionKey(env);
  const combined = base64ToBytes(value.slice(ENC_PREFIX.length));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch (err) {
    throw new Error(`Decryption failed: ${err.message}. The ENCRYPTION_KEY may have changed.`);
  }
}

/**
 * Hash a string with SHA-256 (for admin password storage).
 */
export async function sha256(text) {
  const encoded = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToBase64(new Uint8Array(hash));
}

/**
 * Clear the cached encryption key (useful for testing).
 */
export function clearKeyCache() {
  cachedKey = null;
}
