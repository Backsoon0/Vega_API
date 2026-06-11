// src/usage.ts
// D1-based usage tracking with model-level granularity
// Also records to in-memory log buffer

import type { Env, UsageRecord } from './types';
import { pushLog } from './log-buffer';

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record usage after each API call. Fire-and-forget.
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

    // Push to in-memory log buffer
    pushLog({
      timestamp: new Date().toISOString(),
      ip,
      providerId,
      model,
      promptTokens: usage.prompt || 0,
      completionTokens: usage.completion || 0,
      success,
    });
  } catch (err) {
    console.error('Usage tracking error:', (err as Error).message);
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
