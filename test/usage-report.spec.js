import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import worker from "../src";
import { sha256 } from "../src/crypto";
import { invalidateCaches } from "../src/router";

// End-to-end check of GET /admin/usage/report — the overview page charts read
// from this endpoint (usage_daily series + byModel + key_usage_daily byKey).

async function setup() {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}', cache_read_input_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, api_key_name TEXT NOT NULL DEFAULT '')");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS key_usage_daily (key_name TEXT NOT NULL, date TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(key_name, date))");
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function auth() {
  const token = await sha256("usage-report-test-password");
  await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('admin_password', ?)").bind(token).run();
  return token;
}

beforeEach(async () => {
  await setup();
  await env.DB.exec("DELETE FROM usage_daily");
  await env.DB.exec("DELETE FROM call_logs");
  await env.DB.exec("DELETE FROM key_usage_daily");
  await env.DB.exec("DELETE FROM config WHERE key = 'admin_password'");
  invalidateCaches();
});

describe("GET /admin/usage/report", () => {
  it("rejects unauthenticated requests", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("http://example.com/admin/usage/report"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("returns zero-filled series + byModel + byKey when tables have rows", async () => {
    // usage_daily: today (aliyun/qwen) + 3 days ago (vertex/gemini)
    await env.DB.prepare("INSERT INTO usage_daily (date, provider_id, model, calls, prompt_tokens, completion_tokens) VALUES (?, 'aliyun', 'qwen3.8-flash', 3, 88, 404)")
      .bind(isoDaysAgo(0)).run();
    await env.DB.prepare("INSERT INTO usage_daily (date, provider_id, model, calls, prompt_tokens, completion_tokens) VALUES (?, 'vertex', 'gemini-3', 1, 50, 10)")
      .bind(isoDaysAgo(3)).run();
    await env.DB.prepare("INSERT INTO key_usage_daily (key_name, date, calls, prompt_tokens, completion_tokens) VALUES ('Cherry Studio', ?, 2, 88, 400)")
      .bind(isoDaysAgo(0)).run();

    const token = await auth();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/admin/usage/report?days=7", { headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();

    // series: 8 entries (now-7d .. today, zero-filled), today has 3 calls / 492 tokens
    expect(data.series.length).toBe(8);
    const today = data.series.find((s) => s.date === isoDaysAgo(0));
    expect(today.calls).toBe(3);
    expect(today.tokens).toBe(492); // 88 + 404

    // byModel: top 12 by calls, today's model first
    expect(data.byModel.length).toBe(2);
    expect(data.byModel[0].model).toBe("qwen3.8-flash");
    expect(data.byModel[0].calls).toBe(3);

    // byKey from key_usage_daily
    expect(data.byKey.length).toBe(1);
    expect(data.byKey[0].keyName).toBe("Cherry Studio");
    expect(data.byKey[0].calls).toBe(2);
  });

  it("returns empty arrays (not errors) when no usage exists", async () => {
    const token = await auth();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/admin/usage/report?days=7", { headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.series.length).toBe(8); // zero-filled even with no rows (now-7d .. today)
    expect(data.byModel).toEqual([]);
    expect(data.byKey).toEqual([]);
  });

  it("days=1 (最近 24 小时) includes usage dated yesterday — daily-granularity fix", async () => {
    // A call at 23:00 local yesterday is UTC yesterday: within a rolling 24h window
    // but stored under yesterday's date. days=1 must surface it (series [yesterday, today]).
    await env.DB.prepare("INSERT INTO usage_daily (date, provider_id, model, calls, prompt_tokens, completion_tokens) VALUES (?, 'aliyun', 'qwen3.8-flash', 5, 100, 200)")
      .bind(isoDaysAgo(1)).run();
    await env.DB.prepare("INSERT INTO key_usage_daily (key_name, date, calls, prompt_tokens, completion_tokens) VALUES ('Cherry Studio', ?, 5, 100, 200)")
      .bind(isoDaysAgo(1)).run();

    const token = await auth();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/admin/usage/report?days=1", { headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();

    // series covers [yesterday, today]; yesterday carries the usage, today is zero
    expect(data.series.length).toBe(2);
    const yesterday = data.series.find((s) => s.date === isoDaysAgo(1));
    expect(yesterday.calls).toBe(5);
    expect(yesterday.tokens).toBe(300);
    const today = data.series.find((s) => s.date === isoDaysAgo(0));
    expect(today.calls).toBe(0);

    // byModel / byKey surface yesterday's rows in the 24h view
    expect(data.byModel.length).toBe(1);
    expect(data.byModel[0].model).toBe("qwen3.8-flash");
    expect(data.byModel[0].calls).toBe(5);
    expect(data.byKey.length).toBe(1);
    expect(data.byKey[0].keyName).toBe("Cherry Studio");
    expect(data.byKey[0].calls).toBe(5);
  });

  it("hours=24 returns an hourly series (24 buckets) sourced from call_logs", async () => {
    const insert =
      "INSERT INTO call_logs (timestamp, ip, provider_id, model, prompt_tokens, completion_tokens, duration_ms, success, request_id, is_stream, extra, cache_read_input_tokens, cache_creation_input_tokens, api_key_name) VALUES (?, '1.1.1.1', 'aliyun', ?, ?, ?, 12, 1, 'req', 0, '{}', 0, 0, ?)";
    const nowMs = Date.now();
    const currentHourMs = nowMs - (nowMs % 3600000);
    const at = (offsetHours, minutes = 0) =>
      new Date(currentHourMs + offsetHours * 3600000 + minutes * 60000).toISOString();
    const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);

    // 2 calls in the current hour (named key), 1 four hours ago (anonymous key),
    // 1 well outside the 24h window (must be ignored)
    await env.DB.prepare(insert).bind(at(0, 1), "qwen3.8-flash", 10, 20, "Cherry Studio").run();
    await env.DB.prepare(insert).bind(at(0, 2), "qwen3.8-flash", 30, 40, "Cherry Studio").run();
    await env.DB.prepare(insert).bind(at(-4), "gemini-3", 5, 5, "").run();
    await env.DB.prepare(insert).bind(at(-30), "gemini-3", 999, 999, "").run();

    const token = await auth();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/admin/usage/report?hours=24", { headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.granularity).toBe("hour");
    expect(data.hours).toBe(24);
    // 24 hourly buckets, zero-filled, ending with the current hour
    expect(data.series.length).toBe(24);
    expect(data.series[23].date).toBe(hourKey(currentHourMs));
    expect(data.series[23].calls).toBe(2);
    expect(data.series[23].tokens).toBe(100); // 10+20 and 30+40
    expect(data.series[19].calls).toBe(1); // now - 4h
    expect(data.series[10].calls).toBe(0); // empty hour

    // byModel / byKey come from the same window → the 30h-old row is excluded
    expect(data.byModel.map((m) => m.model).sort()).toEqual(["gemini-3", "qwen3.8-flash"]);
    expect(data.byModel.find((m) => m.model === "gemini-3").calls).toBe(1);
    expect(data.byKey).toEqual([{ keyName: "Cherry Studio", calls: 2, tokens: 100 }]);
  });

  it("hours=168 stays on daily granularity (30d and 7d views unchanged)", async () => {
    await env.DB.prepare("INSERT INTO usage_daily (date, provider_id, model, calls, prompt_tokens, completion_tokens) VALUES (?, 'aliyun', 'qwen3.8-flash', 3, 88, 404)")
      .bind(isoDaysAgo(0)).run();

    const token = await auth();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/admin/usage/report?hours=168", { headers: { Authorization: `Bearer ${token}` } }),
      env, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.granularity).toBe("day");
    expect(data.days).toBe(7);
    expect(data.series.length).toBe(8);
    expect(data.series.every((s) => s.date.length === 10)).toBe(true);
    expect(data.series.find((s) => s.date === isoDaysAgo(0)).calls).toBe(3);
  });
});