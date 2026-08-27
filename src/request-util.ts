// src/request-util.ts
// Portable request helpers shared by Cloudflare Workers and Vercel.

import type { Context } from 'hono';

/**
 * Resolve the client IP across deployment platforms:
 *   - Cloudflare: `CF-Connecting-IP`
 *   - Vercel:     `x-forwarded-for` (first entry) or `x-real-ip`
 * Falls back to "unknown".
 */
export function getClientIp(c: Context<any>): string {
	const cfIp = c.req.header('CF-Connecting-IP');
	if (cfIp) return cfIp;

	const fwd = c.req.header('x-forwarded-for');
	if (fwd) {
		const first = fwd.split(',')[0]?.trim();
		if (first) return first;
	}

	const realIp = c.req.header('x-real-ip');
	if (realIp) return realIp;

	return 'unknown';
}
