// src/usage.js
// API usage tracking — records call counts and token usage per provider per day
// Stored in KV with keys: usage:{YYYY-MM-DD}:{providerId}
// TTL: 90 days retention for daily records, 365 for monthly aggregates

const DAILY_TTL = 90 * 24 * 3600; // 90 days
const MONTHLY_TTL = 365 * 24 * 3600; // 365 days

/**
 * Record one API call's usage. Fire-and-forget — errors are logged but never thrown.
 */
export async function recordUsage(env, providerId, usage) {
	if (!providerId) return;
	try {
		const today = isoDate();
		await updateDaily(env, providerId, today, usage);
		await updateMonthly(env, providerId, today.slice(0, 7), usage); // YYYY-MM
		await updateTotal(env, providerId, usage);
	} catch (err) {
		// Never let usage tracking break the request
		console.error("Usage tracking error:", err.message);
	}
}

/**
 * Query usage for a date range, optionally filtered by provider.
 * Returns { total: {...}, daily: {...}, byProvider: {...} }
 */
export async function getUsage(env, from, to, providerId) {
	const total = { calls: 0, promptTokens: 0, completionTokens: 0 };
	const byProvider = {};
	const daily = {};

	try {
		// List all daily usage keys
		const list = await env.VEGA_API_CONFIG.list({ prefix: "usage:daily:" });
		const keys = list.keys || [];

		for (const k of keys) {
			// Key format: usage:daily:{YYYY-MM-DD}:{providerId}
			const parts = k.name.split(":");
			if (parts.length < 4) continue;
			const date = parts[2];
			const pid = parts.slice(3).join(":"); // provider ID may contain colons

			// Filter by date range
			if (from && date < from) continue;
			if (to && date > to) continue;

			// Filter by provider
			if (providerId && pid !== providerId) continue;

			const raw = await env.VEGA_API_CONFIG.get(k.name, "json");
			if (!raw) continue;

			const c = raw.calls || 0;
			const p = raw.promptTokens || 0;
			const ct = raw.completionTokens || 0;

			total.calls += c;
			total.promptTokens += p;
			total.completionTokens += ct;

			if (!byProvider[pid]) {
				byProvider[pid] = { calls: 0, promptTokens: 0, completionTokens: 0 };
			}
			byProvider[pid].calls += c;
			byProvider[pid].promptTokens += p;
			byProvider[pid].completionTokens += ct;

			if (!daily[date]) {
				daily[date] = { calls: 0, promptTokens: 0, completionTokens: 0 };
			}
			daily[date].calls += c;
			daily[date].promptTokens += p;
			daily[date].completionTokens += ct;
		}
	} catch (err) {
		console.error("Usage query error:", err.message);
	}

	return { total, byProvider, daily };
}

// ---- Internal helpers ----

function isoDate(ts) {
	return (ts ? new Date(ts) : new Date()).toISOString().slice(0, 10);
}

async function updateDaily(env, providerId, date, usage) {
	const key = `usage:daily:${date}:${providerId}`;
	const existing = (await env.VEGA_API_CONFIG.get(key, "json")) || {
		calls: 0,
		promptTokens: 0,
		completionTokens: 0,
	};
	existing.calls += 1;
	existing.promptTokens += usage.prompt || 0;
	existing.completionTokens += usage.completion || 0;
	await env.VEGA_API_CONFIG.put(key, JSON.stringify(existing), { expirationTtl: DAILY_TTL });
}

async function updateMonthly(env, providerId, month, usage) {
	const key = `usage:monthly:${month}:${providerId}`;
	const existing = (await env.VEGA_API_CONFIG.get(key, "json")) || {
		calls: 0,
		promptTokens: 0,
		completionTokens: 0,
	};
	existing.calls += 1;
	existing.promptTokens += usage.prompt || 0;
	existing.completionTokens += usage.completion || 0;
	await env.VEGA_API_CONFIG.put(key, JSON.stringify(existing), { expirationTtl: MONTHLY_TTL });
}

async function updateTotal(env, providerId, usage) {
	const key = `usage:total:${providerId}`;
	const existing = (await env.VEGA_API_CONFIG.get(key, "json")) || {
		calls: 0,
		promptTokens: 0,
		completionTokens: 0,
	};
	existing.calls += 1;
	existing.promptTokens += usage.prompt || 0;
	existing.completionTokens += usage.completion || 0;
	// Total has no TTL — keeps accumulating
	await env.VEGA_API_CONFIG.put(key, JSON.stringify(existing));
}

/**
 * Get quick totals for all providers (used for dashboard summary).
 * Does NOT scan daily keys — reads only the aggregate total keys.
 */
export async function getUsageTotals(env) {
	const result = {};
	try {
		const list = await env.VEGA_API_CONFIG.list({ prefix: "usage:total:" });
		for (const k of list.keys || []) {
			const pid = k.name.slice("usage:total:".length);
			const raw = await env.VEGA_API_CONFIG.get(k.name, "json");
			if (raw) result[pid] = raw;
		}
	} catch (err) {
		console.error("Usage totals error:", err.message);
	}
	return result;
}
