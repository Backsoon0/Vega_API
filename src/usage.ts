// src/usage.ts
// D1-based usage tracking with model-level granularity
// Call logs persisted in D1 with retention limit (10000 rows)

import type { Env, UsageRecord } from './types';

const MAX_LOG_ROWS = 10000;

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record usage after each API call. Fire-and-forget.
 * Inserts into usage_daily (aggregated) and call_logs (detail).
 * Probabilistic cleanup (~1% of calls) prunes old log rows when exceeding MAX_LOG_ROWS.
 */
export async function recordUsage(
  env: Env,
  providerId: string,
  model: string,
  ip: string,
  usage: { prompt: number; completion: number },
  success: boolean
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
           calls = calls + 1,
           prompt_tokens = prompt_tokens + ?,
           completion_tokens = completion_tokens + ?`
      )
      .bind(today, providerId, model, usage.prompt, usage.completion, usage.prompt, usage.completion)
      .run();

    // Insert into call_logs
    await env.DB
      .prepare(
        `INSERT INTO call_logs (timestamp, ip, provider_id, model, prompt_tokens, completion_tokens, success)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(now, ip, providerId, model, usage.prompt || 0, usage.completion || 0, success ? 1 : 0)
      .run();

    // Probabilistic cleanup: ~1% of calls (roughly every 100 requests)
    // Avoids full table scan on every single API call
    if (Math.random() < 0.01) {
      await env.DB
        .prepare(
          `DELETE FROM call_logs WHERE id NOT IN (SELECT id FROM call_logs ORDER BY timestamp DESC LIMIT ?)`
        )
        .bind(MAX_LOG_ROWS)
        .run();
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
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ logs: Array<{
    timestamp: string;
    ip: string;
    providerId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    success: boolean;
  }>; total: number }> {
  const limit = opts.limit || 200;
  const offset = opts.offset || 0;

  try {
    let whereClauses = 'WHERE 1=1';
    const params: (string | number)[] = [];

    if (opts.search) {
      whereClauses += ' AND (ip LIKE ? OR provider_id LIKE ? OR model LIKE ?)';
      const s = `%${opts.search}%`;
      params.push(s, s, s);
    }
    if (opts.providerId) {
      whereClauses += ' AND provider_id = ?';
      params.push(opts.providerId);
    }

    // Count total
    const countRow = await env.DB
      .prepare(`SELECT COUNT(*) as cnt FROM call_logs ${whereClauses}`)
      .bind(...params)
      .first<{ cnt: number }>();
    const total = countRow?.cnt || 0;

    // Fetch rows
    const rows = await env.DB
      .prepare(
        `SELECT timestamp, ip, provider_id, model, prompt_tokens, completion_tokens, success
         FROM call_logs ${whereClauses}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<{
        timestamp: string;
        ip: string;
        provider_id: string;
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        success: number;
      }>();

    const logs = (rows.results || []).map(r => ({
      timestamp: r.timestamp,
      ip: r.ip,
      providerId: r.provider_id,
      model: r.model,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      success: r.success === 1,
    }));

    return { logs, total };
  } catch (err) {
    console.error('Call logs query error:', (err as Error).message);
    return { logs: [], total: 0 };
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
      total.calls += r.calls;
      total.promptTokens += r.prompt_tokens;
      total.completionTokens += r.completion_tokens;

      if (!byProvider[r.provider_id]) {
        byProvider[r.provider_id] = { calls: 0, promptTokens: 0, completionTokens: 0 };
      }
      byProvider[r.provider_id].calls += r.calls;
      byProvider[r.provider_id].promptTokens += r.prompt_tokens;
      byProvider[r.provider_id].completionTokens += r.completion_tokens;

      if (!daily[r.date]) {
        daily[r.date] = { calls: 0, promptTokens: 0, completionTokens: 0 };
      }
      daily[r.date].calls += r.calls;
      daily[r.date].promptTokens += r.prompt_tokens;
      daily[r.date].completionTokens += r.completion_tokens;
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
        calls: r.calls,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
      };
    }
  } catch (err) {
    console.error('Usage totals error:', (err as Error).message);
  }
  return result;
}
