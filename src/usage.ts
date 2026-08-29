// src/usage.ts
// D1-based usage tracking with model-level granularity
// Call logs persisted in D1 with configurable retention limit (default 10000 rows,
// editable in the admin panel via config key `log_retention_limit`)

import type { Env, UsageRecord } from './types.js';
import { getLogRetentionLimit } from './config.js';

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Prune call_logs to the most recent `maxRows` rows (by timestamp), deleting all
 * older rows in a single statement. Used by recordUsage's probabilistic cleanup
 * and by the admin settings endpoint when the retention limit changes.
 */
export async function pruneCallLogs(env: Env, maxRows: number): Promise<void> {
  if (!Number.isFinite(maxRows) || maxRows < 0) return;
  await env.DB
    .prepare(
      `DELETE FROM call_logs WHERE id NOT IN (SELECT id FROM call_logs ORDER BY timestamp DESC LIMIT ?)`
    )
    .bind(maxRows)
    .run();
}

/**
 * Record usage after each API call. Fire-and-forget.
 * Inserts into usage_daily (aggregated) and call_logs (detail).
 * Probabilistic cleanup (~1% of calls) prunes old log rows beyond the configured retention limit.
 */
export async function recordUsage(
  env: Env,
  providerId: string,
  model: string,
  ip: string,
  usage: { prompt: number; completion: number },
  success: boolean,
  durationMs: number = 0,
  requestId: string = '',
  isStream: boolean = false,
  extra: Record<string, string> = {},
  cacheReadInputTokens: number = 0,
  cacheCreationInputTokens: number = 0,
  apiKeyName: string = '',
): Promise<void> {
  try {
    const today = isoDate();
    const now = new Date().toISOString();

    // Upsert daily aggregate
    await env.DB
      .prepare(
        `INSERT INTO usage_daily (date, provider_id, model, calls, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(date, provider_id, model) DO UPDATE SET
           calls = usage_daily.calls + 1,
           prompt_tokens = usage_daily.prompt_tokens + ?,
           completion_tokens = usage_daily.completion_tokens + ?`
      )
      .bind(today, providerId, model, usage.prompt, usage.completion, usage.prompt, usage.completion)
      .run();

    // Insert into call_logs (includes new columns from migration 0005 + 0008)
    await env.DB
      .prepare(
        `INSERT INTO call_logs (timestamp, ip, provider_id, model, prompt_tokens, completion_tokens, duration_ms, success, request_id, is_stream, extra, cache_read_input_tokens, cache_creation_input_tokens, api_key_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        now, ip, providerId, model,
        usage.prompt || 0, usage.completion || 0,
        durationMs, success ? 1 : 0,
        requestId, isStream ? 1 : 0,
        JSON.stringify(extra),
        cacheReadInputTokens, cacheCreationInputTokens,
        apiKeyName,
      )
      .run();

    // Per-key daily aggregate (quota enforcement + per-key report charts).
    // Keyed by key NAME (the only attribution available at every call site);
    // the auth middleware enforces quotas with the same lookup, so counts agree.
    if (apiKeyName) {
      const p = usage.prompt || 0;
      const co = usage.completion || 0;
      await env.DB
        .prepare(
          `INSERT INTO key_usage_daily (key_name, date, calls, prompt_tokens, completion_tokens)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(key_name, date) DO UPDATE SET
             calls = key_usage_daily.calls + 1,
             prompt_tokens = key_usage_daily.prompt_tokens + ?,
             completion_tokens = key_usage_daily.completion_tokens + ?`
        )
        .bind(apiKeyName, today, p, co, p, co)
        .run();
    }

    // Probabilistic cleanup: ~1% of calls. Retention limit is read from D1 config
    // (configurable in the admin panel), defaulting to 10000 rows.
    if (Math.random() < 0.01) {
      const maxRows = await getLogRetentionLimit(env);
      await pruneCallLogs(env, maxRows);
    }
  } catch (err) {
    console.error('Usage tracking error:', (err as Error).message);
  }
}

/**
 * Query call logs from D1. Supports optional search/filter.
 */
export async function getCallLogs(
  env: Env,
  opts: {
    search?: string;
    providerId?: string;
    isStream?: string;
    success?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ logs: Array<{
    id: number;
    timestamp: string;
    ip: string;
    providerId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    success: boolean;
    requestId: string;
    isStream: boolean;
    extra: Record<string, string>;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    apiKeyName: string;
  }>; total: number; hasMore: boolean }> {
  const MAX_PAGE_SIZE = 200;
  // Clamp client-supplied pagination: NaN/absent → defaults, negatives → 1/0,
  // oversized → MAX_PAGE_SIZE (prevents LIMIT -N (= unlimited in SQLite) and huge scans).
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(opts.limit!, 1), MAX_PAGE_SIZE) : 200;
  const offset = Number.isFinite(opts.offset) ? Math.max(opts.offset!, 0) : 0;

  try {
    let whereClauses = 'WHERE 1=1';
    const params: (string | number)[] = [];

    if (opts.search) {
      whereClauses += ' AND (ip LIKE ? OR provider_id LIKE ? OR model LIKE ? OR request_id LIKE ?)';
      const s = `%${opts.search}%`;
      params.push(s, s, s, s);
    }
    if (opts.providerId) {
      whereClauses += ' AND provider_id = ?';
      params.push(opts.providerId);
    }
    if (opts.isStream === '1') {
      whereClauses += ' AND is_stream = 1';
    } else if (opts.isStream === '0') {
      whereClauses += ' AND is_stream = 0';
    }
    if (opts.success === '1') {
      whereClauses += ' AND success = 1';
    } else if (opts.success === '0') {
      whereClauses += ' AND success = 0';
    }

    // Count total rows (for pagination page count)
    let total = 0;
    try {
      const countRow = await env.DB
        .prepare(`SELECT COUNT(*) as cnt FROM call_logs ${whereClauses}`)
        .bind(...params)
        .first<{ cnt: number }>();
      total = Number(countRow?.cnt) || 0;
    } catch {
      // COUNT failed — total stays 0, pagination falls back to hasMore
    }

    // Fetch rows (limit+1 to detect hasMore)
    const rows = await env.DB
      .prepare(
        `SELECT id, timestamp, ip, provider_id, model, prompt_tokens, completion_tokens, duration_ms, success, request_id, is_stream, extra, cache_read_input_tokens, cache_creation_input_tokens, api_key_name
         FROM call_logs ${whereClauses}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit + 1, offset)
      .all<{
        id: number;
        timestamp: string;
        ip: string;
        provider_id: string;
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        duration_ms: number;
        success: number;
        request_id: string;
        is_stream: number;
        extra: string;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
        api_key_name: string;
      }>();

    const results = rows.results || [];
    const hasMore = results.length > limit;
    const trimmed = results.slice(0, limit).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      ip: r.ip,
      providerId: r.provider_id,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      durationMs: r.duration_ms,
      success: r.success === 1,
      requestId: r.request_id || '',
      isStream: r.is_stream === 1,
      extra: (() => { try { return JSON.parse(r.extra || '{}'); } catch { return {}; } })(),
      cacheReadInputTokens: r.cache_read_input_tokens || 0,
      cacheCreationInputTokens: r.cache_creation_input_tokens || 0,
      apiKeyName: r.api_key_name || '',
    }));

    return { logs: trimmed, total, hasMore };
  } catch (err) {
    console.error('Call logs query error:', (err as Error).message);
    return { logs: [], total: 0, hasMore: false };
  }
}

/**
 * Query usage for a date range, optionally filtered by provider.
 */
export async function getUsage(
  env: Env,
  from: string,
  to: string,
  providerId: string | null
): Promise<{
  total: UsageRecord;
  byProvider: Record<string, UsageRecord>;
  daily: Record<string, UsageRecord>;
}> {
  const total: UsageRecord = { calls: 0, promptTokens: 0, completionTokens: 0 };
  const byProvider: Record<string, UsageRecord> = {};
  const daily: Record<string, UsageRecord> = {};

  try {
    let sql =
      'SELECT date, provider_id, calls, prompt_tokens, completion_tokens FROM usage_daily WHERE 1=1';
    const params: (string | number)[] = [];

    if (from) {
      sql += ' AND date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND date <= ?';
      params.push(to);
    }
    if (providerId) {
      sql += ' AND provider_id = ?';
      params.push(providerId);
    }
    sql += ' ORDER BY date DESC';

    const rows = await env.DB
      .prepare(sql)
      .bind(...params)
      .all<{
        date: string;
        provider_id: string;
        calls: number;
        prompt_tokens: number;
        completion_tokens: number;
      }>();

    for (const r of rows.results || []) {
      const calls = Number(r.calls) || 0;
      const prompt = Number(r.prompt_tokens) || 0;
      const completion = Number(r.completion_tokens) || 0;

      total.calls += calls;
      total.promptTokens += prompt;
      total.completionTokens += completion;

      if (!byProvider[r.provider_id]) {
        byProvider[r.provider_id] = { calls: 0, promptTokens: 0, completionTokens: 0 };
      }
      byProvider[r.provider_id].calls += calls;
      byProvider[r.provider_id].promptTokens += prompt;
      byProvider[r.provider_id].completionTokens += completion;

      if (!daily[r.date]) {
        daily[r.date] = { calls: 0, promptTokens: 0, completionTokens: 0 };
      }
      daily[r.date].calls += calls;
      daily[r.date].promptTokens += prompt;
      daily[r.date].completionTokens += completion;
    }
  } catch (err) {
    console.error('Usage query error:', (err as Error).message);
  }
  return { total, byProvider, daily };
}

/**
 * Quick totals for all providers.
 */
export async function getUsageTotals(env: Env): Promise<Record<string, UsageRecord>> {
  const result: Record<string, UsageRecord> = {};
  try {
    const rows = await env.DB
      .prepare(
        `SELECT provider_id, SUM(calls) as calls, SUM(prompt_tokens) as prompt_tokens, SUM(completion_tokens) as completion_tokens
         FROM usage_daily GROUP BY provider_id`
      )
      .all<{
        provider_id: string;
        calls: number;
        prompt_tokens: number;
        completion_tokens: number;
      }>();
    for (const r of rows.results || []) {
      result[r.provider_id] = {
        calls: Number(r.calls) || 0,
        promptTokens: Number(r.prompt_tokens) || 0,
        completionTokens: Number(r.completion_tokens) || 0,
      };
    }
  } catch (err) {
    console.error('Usage totals error:', (err as Error).message);
  }
  return result;
}

/**
 * Report payload for the admin "用量报表": daily series + per-model breakdown
 * (from usage_daily) + per-key breakdown (from key_usage_daily).
 */
export async function getUsageReport(env: Env, days: number): Promise<{
	days: number;
	series: Array<{ date: string; calls: number; tokens: number }>;
	byModel: Array<{ model: string; calls: number; tokens: number }>;
	byKey: Array<{ keyName: string; calls: number; tokens: number }>;
}> {
	const n = Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 365) : 7;
	// usage_daily is date-granular (UTC dates): a call inside a rolling window can
	// fall on the calendar day BEFORE the window start (e.g. 23:00 yesterday is
	// within "最近 24 小时"). Start the window n full days back and include that
	// whole first day, so days=1 covers [yesterday, today] instead of only today —
	// fixes the "24h view empty in the morning" case while keeping the same
	// daily-granularity semantics for n>1 (e.g. days=7 → now-7d .. today).
	const from = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

	const series: Array<{ date: string; calls: number; tokens: number }> = [];
	const byModel: Array<{ model: string; calls: number; tokens: number }> = [];
	const byKey: Array<{ keyName: string; calls: number; tokens: number }> = [];

	try {
		// Daily series — reuse the date-range query shape, then zero-fill every day
		// in the range so the trend line is continuous (charts need full timeline).
		const dailyRows = await env.DB
			.prepare(
				'SELECT date, SUM(calls) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM usage_daily WHERE date >= ? GROUP BY date ORDER BY date',
			)
			.bind(from)
			.all<{ date: string; calls: number; pt: number; ct: number }>();
		const byDate = new Map<string, { calls: number; tokens: number }>();
		for (const r of dailyRows.results || []) {
			byDate.set(r.date, {
				calls: Number(r.calls) || 0,
				tokens: (Number(r.pt) || 0) + (Number(r.ct) || 0),
			});
		}
		for (let i = 0; i <= n; i++) {
			const day = new Date(Date.now() - (n - i) * 86400000).toISOString().slice(0, 10);
			const v = byDate.get(day);
			series.push({ date: day, calls: v?.calls ?? 0, tokens: v?.tokens ?? 0 });
		}
	} catch (err) {
		console.error('Usage report series error:', (err as Error).message);
	}

	try {
		const modelRows = await env.DB
			.prepare(
				'SELECT model, SUM(calls) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM usage_daily WHERE date >= ? GROUP BY model ORDER BY calls DESC LIMIT 12',
			)
			.bind(from)
			.all<{ model: string; calls: number; pt: number; ct: number }>();
		for (const r of modelRows.results || []) {
			byModel.push({
				model: r.model,
				calls: Number(r.calls) || 0,
				tokens: (Number(r.pt) || 0) + (Number(r.ct) || 0),
			});
		}
	} catch (err) {
		console.error('Usage report byModel error:', (err as Error).message);
	}

	try {
		const keyRows = await env.DB
			.prepare(
				'SELECT key_name, SUM(calls) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM key_usage_daily WHERE date >= ? GROUP BY key_name ORDER BY calls DESC LIMIT 12',
			)
			.bind(from)
			.all<{ key_name: string; calls: number; pt: number; ct: number }>();
		for (const r of keyRows.results || []) {
			byKey.push({
				keyName: r.key_name,
				calls: Number(r.calls) || 0,
				tokens: (Number(r.pt) || 0) + (Number(r.ct) || 0),
			});
		}
	} catch (err) {
		console.error('Usage report byKey error:', (err as Error).message);
	}

	return { days: n, series, byModel, byKey };
}

/** Coerce a token count from number/string/undefined — returns 0 for invalid values. */
function toTokenNum(v: unknown): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Extract cache hit tokens from a raw OpenAI-compatible `usage` object
 * (as returned by upstream /chat/completions responses).
 *
 * Different third-party OpenAI-compatible providers expose cache info in
 * different shapes, so several are probed and the maximum is taken:
 * - OpenAI / OpenRouter / Groq / Moonshot: usage.prompt_tokens_details.cached_tokens
 * - DeepSeek / GLM / Kimi-style:           usage.prompt_cache_hit_tokens
 * - Some services:                         usage.cached_tokens (top-level)
 * - Anthropic-style compat endpoints:      usage.cache_read_input_tokens
 *
 * Returns { cacheReadInputTokens, cacheCreationInputTokens }.
 */
export function extractOpenAICacheTokens(
	usage: Record<string, unknown> | undefined | null,
): { cacheReadInputTokens: number; cacheCreationInputTokens: number } {
	if (!usage || typeof usage !== 'object') {
		return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
	}

	let cacheRead = 0;

	// 1. OpenAI standard: usage.prompt_tokens_details.cached_tokens
	const details = usage.prompt_tokens_details;
	if (details && typeof details === 'object') {
		cacheRead = Math.max(
			cacheRead,
			toTokenNum((details as Record<string, unknown>).cached_tokens),
		);
	}

	// 2. DeepSeek / GLM / Kimi-style: usage.prompt_cache_hit_tokens
	cacheRead = Math.max(cacheRead, toTokenNum(usage.prompt_cache_hit_tokens));

	// 3. Top-level cached_tokens (rare)
	cacheRead = Math.max(cacheRead, toTokenNum(usage.cached_tokens));

	// 4. Anthropic-style on a compatible endpoint
	cacheRead = Math.max(cacheRead, toTokenNum(usage.cache_read_input_tokens));

	const cacheCreation = toTokenNum(usage.cache_creation_input_tokens);

	return {
		cacheReadInputTokens: cacheRead,
		cacheCreationInputTokens: cacheCreation,
	};
}

/**
 * Extract cache hit tokens from AI SDK provider metadata.
 * Different providers expose cache info in different shapes.
 * Returns { cacheReadInputTokens, cacheCreationInputTokens }.
 */
export function extractCacheTokens(providerMetadata: Record<string, Record<string, unknown>> | undefined): {
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
} {
	if (!providerMetadata) return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

	// Anthropic: metadata.anthropic.usage.{cache_read_input_tokens, cache_creation_input_tokens}
	const anthropic = providerMetadata.anthropic;
	if (anthropic?.usage && typeof anthropic.usage === 'object') {
		const usage = anthropic.usage as Record<string, number>;
		if (usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
			return {
				cacheReadInputTokens: usage.cache_read_input_tokens || 0,
				cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
			};
		}
	}

	// OpenAI: metadata.openai.usage may carry cache info in several shapes
	// (prompt_tokens_details.cached_tokens, prompt_cache_hit_tokens, ...) — probe
	// all common third-party shapes via extractOpenAICacheTokens.
	const openai = providerMetadata.openai;
	if (openai?.usage && typeof openai.usage === 'object') {
		const cache = extractOpenAICacheTokens(openai.usage as Record<string, unknown>);
		if (cache.cacheReadInputTokens > 0 || cache.cacheCreationInputTokens > 0) {
			return cache;
		}
	}

	// Google: may appear as metadata.google.usageMetadata.{cachedContentTokenCount, ...}
	const google = providerMetadata.google;
	if (google?.usageMetadata && typeof google.usageMetadata === 'object') {
		const um = google.usageMetadata as Record<string, number>;
		if (um.cachedContentTokenCount) {
			return {
				cacheReadInputTokens: um.cachedContentTokenCount || 0,
				cacheCreationInputTokens: 0,
			};
		}
	}

	return { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}
