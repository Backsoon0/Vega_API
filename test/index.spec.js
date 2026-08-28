import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";
import { hashKey } from "../src/crypto.js";

describe("Vega API", () => {
  // Apply D1 migrations before tests run
  // D1 exec() in the test emulation works with properly semicolon-terminated single-line SQL.
  beforeAll(async () => {
    const migrations = [
      "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)",
      "CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))",
      "CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date)",
      "CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_daily(provider_id)",
      "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}')",
      "CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON call_logs(timestamp)",
      "CREATE INDEX IF NOT EXISTS idx_logs_provider ON call_logs(provider_id)",
      "CREATE INDEX IF NOT EXISTS idx_call_logs_request_id ON call_logs(request_id)",
      "CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, quota_calls INTEGER, quota_tokens INTEGER, quota_period TEXT NOT NULL DEFAULT 'day')",
      "CREATE TABLE IF NOT EXISTS key_usage_daily (key_name TEXT NOT NULL, date TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(key_name, date))",
    ];
    for (const stmt of migrations) {
      await env.DB.exec(stmt);
    }
  });

  // ---- Root (served by static assets via ASSETS binding) ----
  it("serves SPA index.html at / via static assets", async () => {
    const request = new Request("http://example.com/");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Vega API");
  });

  it("returns health check at /health", async () => {
    const request = new Request("http://example.com/health");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(data.routes).toBeDefined();
  });

  // ---- CORS ----
  it("handles CORS preflight", async () => {
    const request = new Request("http://example.com/v1/models", {
      method: "OPTIONS",
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeDefined();
  });

  // ---- /v1/models ----
  it("returns model list at /v1/models", async () => {
    const request = new Request("http://example.com/v1/models");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.object).toBe("list");
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("returns 404 for unknown model", async () => {
    const request = new Request("http://example.com/v1/models/nonexistent-model");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  // ---- /v1/chat/completions ----
  it("requires model in chat completions", async () => {
    const request = new Request("http://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.message).toContain("model");
  });

  // ---- 404 ----
  it("returns 404 for unknown POST routes", async () => {
    const request = new Request("http://example.com/unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  // ---- Admin routes ----
  it("rejects unauthenticated admin access", async () => {
    const request = new Request("http://example.com/admin/providers");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("handles admin setup with password", async () => {
    const request = new Request("http://example.com/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test123456" }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    // May succeed (first setup) or fail (already set)
    expect([200, 400]).toContain(response.status);
  });

  // ---- Per-key quota ----
  // NOTE: this test must stay last — inserting an api_keys row turns off public
  // mode, so the earlier unauthenticated tests must already have run.
  it("allows requests under the quota and blocks with 429 once exceeded", async () => {
    const keyValue = "sk-quota-test-key-123456789";
    const hash = await hashKey(keyValue);
    await env.DB.prepare(
      "INSERT INTO api_keys (name, key_hash, encrypted_key, created_at, quota_calls) VALUES ('quota-key', ?, 'x', ?, 2)"
    )
      .bind(hash, new Date().toISOString())
      .run();

    // 1. Under quota → allowed
    let request = new Request("http://example.com/v1/models", {
      headers: { Authorization: `Bearer ${keyValue}` },
    });
    let ctx = createExecutionContext();
    let response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);

    // 2. Simulate 2 calls already recorded today → quota reached
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO key_usage_daily (key_name, date, calls, prompt_tokens, completion_tokens) VALUES ('quota-key', ?, 2, 100, 50)"
    )
      .bind(today)
      .run();

    request = new Request("http://example.com/v1/models", {
      headers: { Authorization: `Bearer ${keyValue}` },
    });
    ctx = createExecutionContext();
    response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error.type).toBe("insufficient_quota");
    expect(response.headers.get("Retry-After")).toBe("86400");

    // 3. A different key (no quota) is unaffected
    const otherValue = "sk-quota-other-key-123456789";
    const otherHash = await hashKey(otherValue);
    await env.DB.prepare(
      "INSERT INTO api_keys (name, key_hash, encrypted_key, created_at) VALUES ('other-key', ?, 'x', ?)"
    )
      .bind(otherHash, new Date().toISOString())
      .run();
    request = new Request("http://example.com/v1/models", {
      headers: { Authorization: `Bearer ${otherValue}` },
    });
    ctx = createExecutionContext();
    response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  });
});
