// src/admin.js
// Admin API routes for provider configuration management
// All routes under /admin/* require password authentication

import {
  listProvidersMasked,
  getProvider,
  saveProvider,
  deleteProvider,
  getAdminPasswordHash,
  setAdminPassword,
  getDefaultProviderId,
  setDefaultProvider,
  getClientApiKey,
  setClientApiKey,
} from "./config.js";
import { sha256 } from "./crypto.js";
import { checkBan, recordFailure, resetBan, getConfig } from "./fail2ban.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Verify the admin password or session token.
 * Returns null if valid, or a Response error if invalid.
 */
async function requireAuth(request, env) {
  // Check Bearer token (session token = SHA-256 of password)
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token) {
    const storedHash = await getAdminPasswordHash(env);
    if (storedHash && token === storedHash) {
      return null; // Valid session token
    }
  }

  return json({ error: "Unauthorized. Please login at /admin/auth" }, 401);
}

/**
 * Handle all /admin/* requests.
 */
export async function handleAdminRoutes(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Login endpoint (no auth required, but fail2ban applies)
  if (path === "/admin/auth" && request.method === "POST") {
    return handleLogin(request, env);
  }

  // Setup endpoint (set initial password, no auth required if no password set)
  if (path === "/admin/setup" && request.method === "POST") {
    return handleSetup(request, env);
  }

  // Get fail2ban config (for UI display)
  if (path === "/admin/fail2ban-config" && request.method === "GET") {
    return json(getConfig());
  }

  // All other routes require authentication
  const authError = await requireAuth(request, env);
  if (authError) return authError;

  // Provider management
  if (path === "/admin/providers") {
    if (request.method === "GET") {
      const providers = await listProvidersMasked(env);
      return json(providers);
    }
    if (request.method === "POST") {
      return handleCreateProvider(request, env);
    }
  }

  // Single provider routes
  const providerMatch = path.match(/^\/admin\/providers\/(.+)$/);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]);
    if (request.method === "GET") {
      const provider = await getProvider(env, providerId);
      if (!provider) return json({ error: "Provider not found" }, 404);
      return json(provider);
    }
    if (request.method === "PUT") {
      return handleUpdateProvider(request, env, providerId);
    }
    if (request.method === "DELETE") {
      await deleteProvider(env, providerId);
      return json({ ok: true });
    }
  }

  // Default provider
  if (path === "/admin/default-provider") {
    if (request.method === "GET") {
      const id = await getDefaultProviderId(env);
      return json({ defaultProviderId: id || null });
    }
    if (request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      await setDefaultProvider(env, body.defaultProviderId || "");
      return json({ ok: true });
    }
  }

  // Password change
  if (path === "/admin/change-password" && request.method === "POST") {
    return handleChangePassword(request, env);
  }

  // Client API key management
  if (path === "/admin/client-key") {
    if (request.method === "GET") {
      return handleGetClientKey(request, env);
    }
    if (request.method === "POST") {
      return handleSetClientKey(request, env);
    }
    if (request.method === "DELETE") {
      await setClientApiKey(env, null);
      return json({ ok: true, message: "Client API key removed. /v1/* routes are now public." });
    }
  }

  // Check auth status
  if (path === "/admin/check" && request.method === "GET") {
    return json({ authenticated: true });
  }

  return json({ error: "Not Found" }, 404);
}

/**
 * Handle login with fail2ban protection.
 */
async function handleLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Check if banned
  const banStatus = await checkBan(env, ip);
  if (banStatus.banned) {
    const minutes = Math.ceil(banStatus.remainingSeconds / 60);
    return json(
      {
        error: `Too many failed attempts. Try again in ${minutes} minute(s).`,
        banned: true,
        remainingSeconds: banStatus.remainingSeconds,
      },
      429
    );
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body;

  if (!password) {
    return json({ error: "Password is required" }, 400);
  }

  const storedHash = await getAdminPasswordHash(env);

  // If no password is set, the first login sets it
  if (!storedHash) {
    // Record the setup password
    const hash = await sha256(password);
    await setAdminPassword(env, hash);
    return json({ ok: true, token: hash, message: "Password set successfully" });
  }

  const inputHash = await sha256(password);

  if (inputHash !== storedHash) {
    // Record failed attempt
    const result = await recordFailure(env, ip);
    if (result.banned) {
      const minutes = Math.ceil(result.remainingSeconds / 60);
      return json(
        {
          error: `Too many failed attempts. Try again in ${minutes} minute(s).`,
          banned: true,
          remainingSeconds: result.remainingSeconds,
        },
        429
      );
    }
    return json(
      {
        error: `Invalid password. ${result.remaining} attempt(s) remaining.`,
        remaining: result.remaining,
      },
      401
    );
  }

  // Successful login
  await resetBan(env, ip);
  return json({ ok: true, token: storedHash });
}

/**
 * Handle initial setup (set password without existing one).
 */
async function handleSetup(request, env) {
  const storedHash = await getAdminPasswordHash(env);
  if (storedHash) {
    return json({ error: "Password already set. Use /admin/auth to login." }, 400);
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body;

  if (!password || password.length < 6) {
    return json({ error: "Password must be at least 6 characters" }, 400);
  }

  const hash = await sha256(password);
  await setAdminPassword(env, hash);
  return json({ ok: true, token: hash, message: "Admin password set successfully" });
}

/**
 * Handle creating a new provider.
 */
async function handleCreateProvider(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const record = await saveProvider(env, body);
    return json(record, 201);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

/**
 * Handle updating an existing provider.
 */
async function handleUpdateProvider(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Ensure ID in body matches URL
  body.id = id;

  try {
    const record = await saveProvider(env, body);
    return json(record);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

/**
 * Handle password change (requires current password).
 */
async function handleChangePassword(request, env) {
  const body = await request.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return json({ error: "currentPassword and newPassword are required" }, 400);
  }

  if (newPassword.length < 6) {
    return json({ error: "New password must be at least 6 characters" }, 400);
  }

  const storedHash = await getAdminPasswordHash(env);
  const currentHash = await sha256(currentPassword);

  if (currentHash !== storedHash) {
    return json({ error: "Current password is incorrect" }, 401);
  }

  const newHash = await sha256(newPassword);
  await setAdminPassword(env, newHash);
  return json({ ok: true, token: newHash, message: "Password changed successfully" });
}

// ---- Client API Key management ----

/**
 * Get the current client API key.
 * Pass ?reveal=true to get the full key (otherwise masked).
 */
async function handleGetClientKey(request, env) {
  const key = await getClientApiKey(env);
  if (!key) {
    return json({ configured: false, message: "No client API key set. /v1/* routes are public." });
  }

  const url = new URL(request.url);
  const reveal = url.searchParams.get("reveal") === "true";

  const masked = key.length > 8
    ? "*".repeat(key.length - 4) + key.slice(-4)
    : "****";

  const result = {
    configured: true,
    masked,
    length: key.length,
    prefix: key.substring(0, 4),
  };

  if (reveal) {
    result.fullKey = key;
  }

  return json(result);
}

/**
 * Set or generate a client API key.
 * Body: { key?: "custom-key", generate?: true }
 */
async function handleSetClientKey(request, env) {
  const body = await request.json().catch(() => ({}));
  let { key, generate } = body;

  if (generate || !key) {
    // Generate a cryptographically random API key
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    key = "sk-" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }

  if (key.length < 8) {
    return json({ error: "API key must be at least 8 characters" }, 400);
  }

  await setClientApiKey(env, key);

  const masked = key.length > 8
    ? "*".repeat(key.length - 4) + key.slice(-4)
    : "****";

  return json({
    ok: true,
    message: "Client API key set successfully",
    masked,
    fullKey: key,  // Return full key so admin can copy it
    configured: true,
  });
}
