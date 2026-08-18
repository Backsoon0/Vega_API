import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src";
import { sha256 } from "../src/crypto";
import { invalidateCaches } from "../src/router";

async function setup() {
	await env.DB.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	await env.DB.exec("CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)");
	await env.DB.exec("CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}')");
}

async function provider(id, name = id, enabled = 1) {
	await env.DB.prepare("INSERT INTO providers (id, type, name, enabled, config, models, weight) VALUES (?, 'openai', ?, ?, '{}', ?, 1)")
		.bind(id, name, enabled, JSON.stringify(["gpt-4o"]))
		.run();
}

async function auth() {
	const token = await sha256("route-stats-test-password");
	await env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('admin_password', ?)").bind(token).run();
	return token;
}

beforeEach(async () => {
	await setup();
	await env.DB.exec("DELETE FROM providers");
	await env.DB.exec("DELETE FROM call_logs");
	await env.DB.exec("DELETE FROM config WHERE key = 'admin_password'");
	invalidateCaches();
});

describe("GET /admin/routes/stats", () => {
	it("rejects unauthenticated requests", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/admin/routes/stats"), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("aggregates real provider_id request counts and latency", async () => {
		await provider("p1", "Primary");
		await provider("p2", "Backup");
		const now = Date.now();
		const rows = [
			["p1", 100], ["p1", 300], ["p2", 500],
		];
		for (const [id, duration] of rows) {
			await env.DB.prepare("INSERT INTO call_logs (timestamp, ip, provider_id, model, duration_ms, success) VALUES (?, '127.0.0.1', ?, 'gpt-4o', ?, 1)")
				.bind(new Date(now - 10 * 60 * 1000).toISOString(), id, duration).run();
		}
		const token = await auth();
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/admin/routes/stats?hours=24", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.overview.trackedRequests).toBe(3);
		expect(data.providers.find((p) => p.id === "p1").requestCount).toBe(2);
		expect(data.providers.find((p) => p.id === "p1").averageLatencyMs).toBe(200);
		expect(data.providers.find((p) => p.id === "p2").requestCount).toBe(1);
		expect(data.providers.find((p) => p.id === "p2").averageLatencyMs).toBe(500);
	});

	it("returns null latency when no positive duration is available, without inventing a value", async () => {
		await provider("p1", "Primary");
		await env.DB.prepare("INSERT INTO call_logs (timestamp, ip, provider_id, model, duration_ms, success) VALUES (?, '127.0.0.1', 'p1', 'gpt-4o', 0, 1)")
			.bind(new Date().toISOString()).run();
		const token = await auth();
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/admin/routes/stats", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
		await waitOnExecutionContext(ctx);
		const data = await response.json();
		expect(data.providers.find((p) => p.id === "p1").requestCount).toBe(1);
		expect(data.providers.find((p) => p.id === "p1").averageLatencyMs).toBeNull();
		expect(data.overview.averageLatencyMs).toBeNull();
		expect(data.latency.providerIds).toEqual([]);
	});

	it("does not infer requests for providers without directly attributable call_logs", async () => {
		await provider("p1", "Primary");
		await provider("p2", "No Logs");
		const token = await auth();
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/admin/routes/stats", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
		await waitOnExecutionContext(ctx);
		const data = await response.json();
		expect(data.providers.find((p) => p.id === "p1").requestCount).toBe(0);
		expect(data.providers.find((p) => p.id === "p1").averageLatencyMs).toBeNull();
		expect(data.providers.find((p) => p.id === "p2").requestCount).toBe(0);
		expect(data.providers.find((p) => p.id === "p2").averageLatencyMs).toBeNull();
	});

	it("clamps the requested period and keeps old logs outside the window", async () => {
		await provider("p1", "Primary");
		await env.DB.prepare("INSERT INTO call_logs (timestamp, ip, provider_id, model, duration_ms) VALUES (?, '127.0.0.1', 'p1', 'gpt-4o', 100)")
			.bind(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()).run();
		const token = await auth();
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request("http://example.com/admin/routes/stats?hours=9999", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
		await waitOnExecutionContext(ctx);
		const data = await response.json();
		expect(data.periodHours).toBe(168);
		expect(data.overview.trackedRequests).toBe(1);
	});
});
