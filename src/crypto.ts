// src/crypto.ts
// AES-256-GCM encryption + SHA-256 hashing (Web Crypto API)
// TypeScript port of crypto.js

import type { Env } from './types.js';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getKey(env: Env): Promise<CryptoKey> {
  const keyHex = (env.ENCRYPTION_KEY || '').trim();
  if (!keyHex) throw new Error('ENCRYPTION_KEY is not configured');

  if (!/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error('ENCRYPTION_KEY must be a hex string (got non-hex characters).');
  }
  if (keyHex.length % 2 !== 0) {
    throw new Error(`ENCRYPTION_KEY has an odd hex length (${keyHex.length} chars). It must be 64 hex chars = 32 bytes.`);
  }
  const bytes = hexToBytes(keyHex);
  if (bytes.length !== 16 && bytes.length !== 24 && bytes.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 16/24/32 bytes for AES-GCM (the project expects 64 hex chars = 32 bytes). Got ${bytes.length} bytes (${keyHex.length} chars). Regenerate with: openssl rand -hex 32`,
    );
  }

  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext → "enc:<iv_hex>:<ciphertext_hex>"
 */
export async function encrypt(env: Env, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  return `enc:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

/**
 * Decrypt "enc:<iv_hex>:<ciphertext_hex>" → plaintext
 * Returns the input unchanged if it doesn't start with "enc:"
 */
export async function decrypt(env: Env, value: string): Promise<string> {
  if (!value || !value.startsWith('enc:')) return value;
  const parts = value.slice(4).split(':');
  if (parts.length < 2) return value;
  const [ivHex, ...cipherParts] = parts;
  const cipherHex = cipherParts.join(':');
  const key = await getKey(env);
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(cipherHex);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    console.warn('Decryption failed — ENCRYPTION_KEY may have been rotated. Returning raw value.');
    return value;
  }
}

/**
 * SHA-256 hash — returns hex string.
 */
export async function sha256(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', encoded);
	return bytesToHex(new Uint8Array(hash));
}

/**
 * Hash an API key for lookup — uses SHA-256.
 */
export async function hashKey(key: string): Promise<string> {
	return sha256(key);
}
