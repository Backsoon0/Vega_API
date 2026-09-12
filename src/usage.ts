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
 * How long `usage_hourly` rows are kept: the panel's longest range is 30 days, so
 * 35 days covers it with a margin. At one row per UTC hour this is ≤ 840 rows —
 * the table exists only to make the daily report local-day exact, so anything
 * older is dead weight. Pruning is safe: a missing hour bucket simply makes that
 * UTC day fall back to its `usage_daily` remainder (see `getUsageReport`).
 */
export const USAGE_HOURLY_RETENTION_HOURS = 24 * 35;

/**
 * Delete `usage_hourly` rows older than `keepHours` (one ranged DELETE on the
 * `bucket` primary key). Called from recordUsage's probabilistic cleanup.
 */
export async function pruneUsageHourly(env: Env, keepHours: number = USAGE_HOURLY_RETENTION_HOURS): Promise<void> {
  if (!Number.isFinite(keepHours) || keepHours <= 0) return;
  const cutoff = new Date(Date.now() - keepHours * 3600000).toISOString().slice(0, 13);
  await env.DB.prepare('DELETE FROM usage_hourly WHERE bucket < ?').bind(cutoff).run();
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
    // (configurable in the admin panel), defaulting to 10000 rows. The hourly
    // aggregate is trimmed in the same pass so it cannot grow without bound.
    if (Math.random() < 0.01) {
      const maxRows = await getLogRetentionLimit(env);
      await pruneCallLogs(env, maxRows);
      await pruneUsageHourly(env, USAGE_HOURLY_RETENTION_HOURS);
    }

    // Hour-granular totals (UTC hour key) — lets the admin report re-bucket by the
    // VIEWER's local day, which usage_daily (UTC dates) cannot do on its own.
    // Written last on purpose: if this table is ever missing, the day/key/log
    // writes above have already landed.
    await env.DB
      .prepare(
        `INSERT INTO usage_hourly (bucket, calls, prompt_tokens, completion_tokens)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           calls = usage_hourly.calls + 1,
           prompt_tokens = usage_hourly.prompt_tokens + ?,
           completion_tokens = usage_hourly.completion_tokens + ?`
      )
      .bind(now.slice(0, 13), usage.prompt || 0, usage.completion || 0, usage.prompt || 0, usage.completion || 0)
      .run();
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

/** Ranges up to this many hours render an hourly series; longer ranges stay daily. */
export const HOURLY_SERIES_MAX_HOURS = 24;

/** Cap for the hourly/day window (365 days). */
const MAX_REPORT_HOURS = 365 * 24;

export interface UsageReportOptions {
	/** Rolling window in hours — preferred. `hours <= HOURLY_SERIES_MAX_HOURS` → hourly series. */
	hours?: number;
	/** Legacy day-granularity window (`?days=`) — always keeps day granularity. */
	days?: number;
	/**
	 * Viewer's UTC offset in **minutes east of UTC** (`-new Date().getTimezoneOffset()`,
	 * e.g. `480` for UTC+8). Only the daily buckets use it: hourly buckets stay
	 * UTC-aligned and the panel renders their labels in the local timezone.
	 */
	tzOffsetMinutes?: number;
}

export type UsageGranularity = 'hour' | 'day';

export interface UsageReport {
	granularity: UsageGranularity;
	/** Requested hours (`null` in the legacy `?days=` mode). */
	hours: number | null;
	days: number;
	/** Viewer's UTC offset in minutes east of UTC (clamped to UTC-12:00 … UTC+14:00). */
	tzOffsetMinutes: number;
	/** `date` is `YYYY-MM-DDTHH` (UTC) when granularity is 'hour', a **local** `YYYY-MM-DD` when 'day'. */
	series: Array<{ date: string; calls: number; tokens: number }>;
	byModel: Array<{ model: string; calls: number; tokens: number }>;
	byKey: Array<{ keyName: string; calls: number; tokens: number }>;
}

/** Clamp a client-supplied UTC offset to the real-world range (UTC-12:00 … UTC+14:00). */
function clampTzOffset(minutes: number | undefined): number {
	if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 0;
	return Math.min(Math.max(Math.round(minutes), -720), 840);
}

/**
 * Report payload for the admin "用量报表".
 *
 * Granularity follows the selected range so short windows stay readable:
 * - `hours <= HOURLY_SERIES_MAX_HOURS` (24) → **hourly** buckets read from
 *   `call_logs` (which carries the timestamp); "最近 24 小时" renders 24 points
 *   instead of the 2 daily ones a date-granular table could offer.
 * - anything longer (or the legacy `days` form) → **daily** buckets, split by the
 *   *viewer's* local day (see `tzOffsetMinutes`).
 *
 * In hourly mode `byModel` / `byKey` are read from the SAME rolling window so the
 * breakdown bars always add up to the trend chart.
 */
export async function getUsageReport(env: Env, options: UsageReportOptions = {}): Promise<UsageReport> {
	const hoursParam = options.hours;
	const requestedHours =
		typeof hoursParam === 'number' && Number.isFinite(hoursParam)
			? Math.min(Math.max(Math.floor(hoursParam), 1), MAX_REPORT_HOURS)
			: null;
	const hourly = requestedHours !== null && requestedHours <= HOURLY_SERIES_MAX_HOURS;
	const tzOffsetMinutes = clampTzOffset(options.tzOffsetMinutes);

	const daysParam = options.days;
	const n = hourly
		? requestedHours!
		: typeof daysParam === 'number' && Number.isFinite(daysParam)
			? Math.min(Math.max(Math.floor(daysParam), 1), 365)
			: 7;

	const series: Array<{ date: string; calls: number; tokens: number }> = [];
	const byModel: Array<{ model: string; calls: number; tokens: number }> = [];
	const byKey: Array<{ keyName: string; calls: number; tokens: number }> = [];

	// ---- Hourly mode: rolling window of `n` clock hours (UTC), ending with the
	// current hour; sourced from call_logs because usage_daily is date-granular.
	// Buckets line up with `substr(timestamp, 1, 13)` (= 'YYYY-MM-DDTHH'), which is
	// valid on both SQLite and Postgres, so no per-platform SQL is needed.
	if (hourly) {
		const nowMs = Date.now();
		const currentHourMs = nowMs - (nowMs % 3600000);
		const startMs = currentHourMs - (n - 1) * 3600000;
		const from = new Date(startMs).toISOString();
		const hourKey = (ms: number) => new Date(ms).toISOString().slice(0, 13);

		try {
			const rows = await env.DB
				.prepare(
					'SELECT substr(timestamp, 1, 13) as bucket, COUNT(*) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM call_logs WHERE timestamp >= ? GROUP BY substr(timestamp, 1, 13) ORDER BY bucket',
				)
				.bind(from)
				.all<{ bucket: string; calls: number; pt: number; ct: number }>();
			const byBucket = new Map<string, { calls: number; tokens: number }>();
			for (const r of rows.results || []) {
				byBucket.set(String(r.bucket), {
					calls: Number(r.calls) || 0,
					tokens: (Number(r.pt) || 0) + (Number(r.ct) || 0),
				});
			}
			// Zero-fill every hour so the trend line is continuous.
			for (let i = 0; i < n; i++) {
				const key = hourKey(startMs + i * 3600000);
				const v = byBucket.get(key);
				series.push({ date: key, calls: v?.calls ?? 0, tokens: v?.tokens ?? 0 });
			}
		} catch (err) {
			console.error('Usage report hourly series error:', (err as Error).message);
		}

		try {
			const modelRows = await env.DB
				.prepare(
					'SELECT model, COUNT(*) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM call_logs WHERE timestamp >= ? GROUP BY model ORDER BY calls DESC LIMIT 12',
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
			console.error('Usage report hourly byModel error:', (err as Error).message);
		}

		try {
			const keyRows = await env.DB
				.prepare(
					"SELECT api_key_name, COUNT(*) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM call_logs WHERE timestamp >= ? AND api_key_name <> '' GROUP BY api_key_name ORDER BY calls DESC LIMIT 12",
				)
				.bind(from)
				.all<{ api_key_name: string; calls: number; pt: number; ct: number }>();
			for (const r of keyRows.results || []) {
				byKey.push({
					keyName: r.api_key_name,
					calls: Number(r.calls) || 0,
					tokens: (Number(r.pt) || 0) + (Number(r.ct) || 0),
				});
			}
		} catch (err) {
			console.error('Usage report hourly byKey error:', (err as Error).message);
		}

		return {
			granularity: 'hour',
			hours: requestedHours,
			days: Math.max(1, Math.ceil(n / 24)),
			tzOffsetMinutes,
			series,
			byModel,
			byKey,
		};
	}

	// ---- Daily mode — bucketed by the VIEWER's local day.
	//
	// A local day cannot be derived from `usage_daily` alone (UTC dates). So the
	// series is built from `usage_hourly` (one row per UTC hour, written per call):
	// each hour goes to the local day it falls in. `usage_daily` is then used only
	// as a *legacy remainder* — a UTC day with no (or partial) hourly coverage,
	// i.e. every day predating migration 0010, still owes `dailyTotal - hourlySum`,
	// and that remainder is attributed to the UTC date, exactly as before 0010.
	// Every UTC day is therefore counted once, and the chart keeps its history
	// across the upgrade instead of dropping to zero.
	const offsetMs = tzOffsetMinutes * 60000;
	const nowMs = Date.now();
	// Local midnight of "today", in shifted-UTC space (adding the offset to any UTC
	// instant yields its local wall clock, so ISO date slices read as local dates).
	const localTodayStartMs = Math.floor((nowMs + offsetMs) / 86400000) * 86400000;
	const utcStartHour = new Date(localTodayStartMs - n * 86400000 - offsetMs).toISOString().slice(0, 13);
	const utcEndHour = new Date(nowMs).toISOString().slice(0, 13);
	const localDateOf = (hourKey: string) =>
		new Date(Date.parse(`${hourKey}:00:00Z`) + offsetMs).toISOString().slice(0, 10);

	const byLocalDate = new Map<string, { calls: number; tokens: number }>();
	/** Hourly totals per UTC date — only needed to compute the legacy remainder. */
	const hourlyByUtcDate = new Map<string, { calls: number; tokens: number }>();

	try {
		const hourRows = await env.DB
			.prepare(
				'SELECT bucket, calls, prompt_tokens as pt, completion_tokens as ct FROM usage_hourly WHERE bucket >= ? AND bucket <= ?',
			)
			.bind(utcStartHour, utcEndHour)
			.all<{ bucket: string; calls: number; pt: number; ct: number }>();
		for (const r of hourRows.results || []) {
			const bucket = String(r.bucket);
			const calls = Number(r.calls) || 0;
			const tokens = (Number(r.pt) || 0) + (Number(r.ct) || 0);
			if (!calls && !tokens) continue;

			const localKey = localDateOf(bucket);
			const local = byLocalDate.get(localKey) || { calls: 0, tokens: 0 };
			byLocalDate.set(localKey, { calls: local.calls + calls, tokens: local.tokens + tokens });

			const utcKey = bucket.slice(0, 10);
			const utc = hourlyByUtcDate.get(utcKey) || { calls: 0, tokens: 0 };
			hourlyByUtcDate.set(utcKey, { calls: utc.calls + calls, tokens: utc.tokens + tokens });
		}
	} catch (err) {
		console.error('Usage report hourly series error:', (err as Error).message);
	}

	try {
		const fromUtcDate = new Date(localTodayStartMs - n * 86400000 - offsetMs).toISOString().slice(0, 10);
		const dailyRows = await env.DB
			.prepare(
				'SELECT date, SUM(calls) as calls, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM usage_daily WHERE date >= ? GROUP BY date ORDER BY date',
			)
			.bind(fromUtcDate)
			.all<{ date: string; calls: number; pt: number; ct: number }>();
		for (const r of dailyRows.results || []) {
			const date = String(r.date);
			const covered = hourlyByUtcDate.get(date);
			// Already-counted hours are subtracted; a negative residue would mean the two
			// aggregates disagree, so clamp at 0 rather than drawing a negative bar.
			const calls = Math.max(0, (Number(r.calls) || 0) - (covered?.calls ?? 0));
			const tokens = Math.max(0, (Number(r.pt) || 0) + (Number(r.ct) || 0) - (covered?.tokens ?? 0));
			if (!calls && !tokens) continue;
			const cur = byLocalDate.get(date) || { calls: 0, tokens: 0 };
			byLocalDate.set(date, { calls: cur.calls + calls, tokens: cur.tokens + tokens });
		}
	} catch (err) {
		console.error('Usage report series error:', (err as Error).message);
	}

	// Zero-fill the n+1 local days so the trend line is continuous.
	for (let i = 0; i <= n; i++) {
		const day = new Date(localTodayStartMs - (n - i) * 86400000).toISOString().slice(0, 10);
		const v = byLocalDate.get(day);
		series.push({ date: day, calls: v?.calls ?? 0, tokens: v?.tokens ?? 0 });
	}

	// byModel / byKey keep the UTC-date window (usage_daily stays date-granular):
	// a call inside the rolling window can fall on the calendar day BEFORE the window
	// start (e.g. 23:00 yesterday is within "最近 24 小时"). Start the window n full
	// days back and include that whole first day, so days=1 covers [yesterday, today]
	// instead of only today — fixes the "24h view empty in the morning" case.
	const from = new Date(nowMs - n * 86400000).toISOString().slice(0, 10);

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

	return { granularity: 'day', hours: null, days: n, tzOffsetMinutes, series, byModel, byKey };
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
