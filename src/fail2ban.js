// src/fail2ban.js
// Rate limiting for admin login attempts
// Tracks failed attempts per IP in KV with automatic expiry

const KV_PREFIX = "config:fail2ban:";
const MAX_ATTEMPTS = 5;        // Max failures before ban
const BAN_DURATION_SECONDS = 900; // 15 minutes
const WINDOW_SECONDS = 300;    // 5 minute sliding window for counting failures

function banKey(ip) {
  return `${KV_PREFIX}${ip}`;
}

/**
 * Check if an IP is currently banned.
 * Returns { banned: true, remainingSeconds: number } or { banned: false }
 */
export async function checkBan(env, ip) {
  const raw = await env.AI_API_CONFIG.get(banKey(ip), "json");
  if (!raw) return { banned: false };

  const now = Math.floor(Date.now() / 1000);

  // Check if there's an active ban
  if (raw.banned_until && now < raw.banned_until) {
    return {
      banned: true,
      remainingSeconds: raw.banned_until - now,
      attempts: raw.attempts || 0,
    };
  }

  // Ban expired, clean up old entries from the window
  if (raw.attempts_window) {
    const recentAttempts = raw.attempts_window.filter((t) => now - t < WINDOW_SECONDS);
    if (recentAttempts.length === 0) {
      await env.AI_API_CONFIG.delete(banKey(ip));
      return { banned: false };
    }
    // Update with cleaned window
    raw.attempts_window = recentAttempts;
    raw.attempts = recentAttempts.length;
    raw.banned_until = 0;
    await env.AI_API_CONFIG.put(banKey(ip), JSON.stringify(raw), { expirationTtl: WINDOW_SECONDS });
  }

  return { banned: false };
}

/**
 * Record a failed login attempt for an IP.
 * Returns { banned: true, remainingSeconds: number } if now banned.
 */
export async function recordFailure(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const raw = (await env.AI_API_CONFIG.get(banKey(ip), "json")) || {
    attempts: 0,
    attempts_window: [],
    banned_until: 0,
  };

  // Clean old attempts outside the window
  raw.attempts_window = (raw.attempts_window || []).filter(
    (t) => now - t < WINDOW_SECONDS
  );

  // Add this attempt
  raw.attempts_window.push(now);
  raw.attempts = raw.attempts_window.length;

  // Check if should ban
  if (raw.attempts >= MAX_ATTEMPTS) {
    raw.banned_until = now + BAN_DURATION_SECONDS;
    await env.AI_API_CONFIG.put(banKey(ip), JSON.stringify(raw), {
      expirationTtl: BAN_DURATION_SECONDS + 60,
    });
    return {
      banned: true,
      remainingSeconds: BAN_DURATION_SECONDS,
      attempts: raw.attempts,
    };
  }

  // Update record
  await env.AI_API_CONFIG.put(banKey(ip), JSON.stringify(raw), {
    expirationTtl: WINDOW_SECONDS + 60,
  });

  return {
    banned: false,
    attempts: raw.attempts,
    remaining: MAX_ATTEMPTS - raw.attempts,
  };
}

/**
 * Reset fail2ban for an IP (called on successful login).
 */
export async function resetBan(env, ip) {
  await env.AI_API_CONFIG.delete(banKey(ip));
}

/**
 * Get the fail2ban configuration for the UI.
 */
export function getConfig() {
  return {
    maxAttempts: MAX_ATTEMPTS,
    banDurationSeconds: BAN_DURATION_SECONDS,
    windowSeconds: WINDOW_SECONDS,
  };
}
