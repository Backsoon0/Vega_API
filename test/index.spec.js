import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src";

describe("AI API Multi-Provider Proxy", () => {
  // ---- Root / Health ----
  it("serves admin UI at /", async () => {
    const request = new Request("http://example.com/");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("<!DOCTYPE html>");
    expect(text).toContain("AI API 统一代理");
    expect(text).toContain("</html>");
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
  it("returns 404 for unknown routes", async () => {
    const request = new Request("http://example.com/unknown");
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
});
