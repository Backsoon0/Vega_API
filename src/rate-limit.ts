// src/rate-limit.ts
// D1-backed rate limiter for admin login
// 5 attempts per 5-minute window → 15-minute ban
// Uses dedicated rate_limits table (not config table)

import type { Context, Next } from 'hono';
import type { Env } from './types';

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 300;       // 5 minutes
const BAN_DURATION_SECONDS = 900;  // 15 minutes

interface RateEntry {
  attempts: number;
  reset_at: number;
  banned_until: number;
}

export async function rateLimitLogin(c: Context<{ Bindings: Env }>, next: Next) {
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const key = `login:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.DB
    .prepare('SELECT attempts, reset_at, banned_until FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ attempts: number; reset_at: number; banned_until: number }>();

  let entry: RateEntry = row
    ? { attempts: row.attempts, reset_at: row.reset_at, banned_until: row.banned_until }
    : { attempts: 0, reset_at: now + WINDOW_SECONDS, banned_until: 0 };

  // Check if currently banned
  if (entry.banned_until && now < entry.banned_until) {
    const remaining = Math.ceil((entry.banned_until - now) / 60);
    return c.json(
      {
        error: `Too many attempts. Try again in ${remaining} minute(s).`,
        banned: true,
        remainingSeconds: entry.banned_until - now,
      },
      429
    );
  }

  // Reset window if expired
  if (now > entry.reset_at) {
    entry = { attempts: 0, reset_at: now + WINDOW_SECONDS, banned_until: 0 };
  }

  c.set('rateEntry', entry);
  c.set('rateKey', key);

  await next();
}

export async function recordLoginFailure(c: Context<{ Bindings: Env }>) {
  const key = c.get('rateKey') as string;
  let entry = c.get('rateEntry') as RateEntry;
  const now = Math.floor(Date.now() / 1000);

  entry.attempts++;

  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.banned_until = now + BAN_DURATION_SECONDS;
  }

  await c.env.DB
    .prepare('INSERT OR REPLACE INTO rate_limits (key, attempts, reset_at, banned_until) VALUES (?, ?, ?, ?)')
    .bind(key, entry.attempts, entry.reset_at, entry.banned_until)
    .run();

  if (entry.banned_until) {
    const remaining = Math.ceil(BAN_DURATION_SECONDS / 60);
    return c.json(
      {
        error: `Too many attempts. Try again in ${remaining} minute(s).`,
        banned: true,
        remainingSeconds: BAN_DURATION_SECONDS,
      },
      429
    );
  }

  const remaining = MAX_ATTEMPTS - entry.attempts;
  return c.json(
    { error: `Invalid password. ${remaining} attempt(s) remaining.`, remaining },
    401
  );
}

export async function resetLoginRate(c: Context<{ Bindings: Env }>) {
  const key = c.get('rateKey') as string;
  if (key) {
    await c.env.DB
      .prepare('DELETE FROM rate_limits WHERE key = ?')
      .bind(key)
      .run();
  }
}

export function getRateLimitConfig() {
  return {
    maxAttempts: MAX_ATTEMPTS,
    banDurationSeconds: BAN_DURATION_SECONDS,
    windowSeconds: WINDOW_SECONDS,
  };
}
