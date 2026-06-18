import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker from "../src";
import { findProviderForModel, invalidateCaches } from "../src/router";
import { saveProvider, getProvider, deleteProvider } from "../src/config";

// Helper: clear all auth-related state
async function clearAuthState() {
	await env.DB.exec("DELETE FROM api_keys");
	await env.DB.exec("DELETE FROM config WHERE key IN ('client_api_key', 'admin_password')");
}

// Helper: insert a fake api_keys row (no real encryption needed for auth-denial tests)
async function insertApiKey(name, keyHash) {
	await env.DB
		.prepare("INSERT INTO api_keys (name, key_hash, encrypted_key, created_at) VALUES (?, ?, ?, ?)")
		.bind(name, keyHash, "enc:fake", new Date().toISOString())
		.run();
}

// Helper: insert a provider row directly into D1
async function insertProvider(id, models, weight = 1, enabled = 1) {
	await env.DB
		.prepare(
			"INSERT INTO providers (id, type, name, enabled, config, models, weight) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(id, "openai", `Provider ${id}`, enabled, "{}", JSON.stringify(models), weight)
		.run();
}

// Shared table setup for all describe blocks
async function setupTables() {
	const migrations = [
		"CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		"CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)",
		"CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))",
		"CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)",
		"CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}')",
		"CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)",
	];
	for (const stmt of migrations) {
		await env.DB.exec(stmt);
	}
}

describe("Critical fix #1: multi-key auth bypass", () => {
	beforeAll(async () => {
		await setupTables();
	});

	beforeEach(async () => {
		await clearAuthState();
	});

	afterEach(async () => {
		await clearAuthState();
	});

	it("rejects unauthenticated request when api_keys table has rows (no legacy key)", async () => {
		await insertApiKey("test-key", "somefakehash123456");

		const request = new Request("http://example.com/v1/models");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it("rejects wrong-key request when api_keys table has rows (no legacy key)", async () => {
		await insertApiKey("test-key", "somefakehash123456");

		const request = new Request("http://example.com/v1/models", {
			headers: { Authorization: "Bearer wrong-key-value" },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it("still allows public mode when NO keys configured anywhere", async () => {
		const request = new Request("http://example.com/v1/models");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
	});
});

describe("Critical fix #2: provider prefix match over-matching", () => {
	beforeAll(async () => {
		await setupTables();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM providers");
		invalidateCaches();
	});

	afterEach(async () => {
		await env.DB.exec("DELETE FROM providers");
		invalidateCaches();
	});

	it("does NOT prefix-match 'gpt-4' to 'gpt-4o' when exact match provider exists", async () => {
		// Provider A lists "gpt-4", Provider B lists "gpt-4o"
		await insertProvider("prov-a", ["gpt-4"], 1);
		await insertProvider("prov-b", ["gpt-4o"], 2);
		invalidateCaches();

		const matches = await findProviderForModel(env, "gpt-4o");
		const matchedIds = matches.map((m) => m.provider.id);

		// Should match only prov-b (exact), NOT prov-a (prefix)
		expect(matchedIds).toContain("prov-b");
		expect(matchedIds).not.toContain("prov-a");
	});

	it("does NOT prefix-match 'claude-3' to 'claude-3.5-sonnet'", async () => {
		await insertProvider("prov-claude3", ["claude-3"], 1);
		await insertProvider("prov-claude35", ["claude-3.5-sonnet"], 2);
		invalidateCaches();

		const matches = await findProviderForModel(env, "claude-3.5-sonnet");
		const matchedIds = matches.map((m) => m.provider.id);

		expect(matchedIds).toContain("prov-claude35");
		expect(matchedIds).not.toContain("prov-claude3");
	});

	it("DOES prefix-match with '/' delimiter (openai/gpt-4 matches openai/gpt-4-0613)", async () => {
		await insertProvider("prov-openai", ["openai/gpt-4"], 1);
		invalidateCaches();

		const matches = await findProviderForModel(env, "openai/gpt-4-0613");
		const matchedIds = matches.map((m) => m.provider.id);

		// "/" delimiter prefix match should still work
		expect(matchedIds).toContain("prov-openai");
	});

	it("exact match still works", async () => {
		await insertProvider("prov-exact", ["gpt-4"], 1);
		invalidateCaches();

		const matches = await findProviderForModel(env, "gpt-4");
		const matchedIds = matches.map((m) => m.provider.id);
		expect(matchedIds).toContain("prov-exact");
	});
});

describe("Critical fix #3: saveProvider partial update preserves fields", () => {
	beforeAll(async () => {
		await setupTables();
	});

	beforeEach(async () => {
		await env.DB.exec("DELETE FROM providers");
	});

	afterEach(async () => {
		await env.DB.exec("DELETE FROM providers");
	});

	it("preserves enabled/weight/models when only name is updated", async () => {
		// Create provider with enabled=false, weight=5, models=["gpt-4"]
		await saveProvider(env, {
			id: "test-partial",
			type: "openai",
			name: "Original",
			enabled: false,
			weight: 5,
			models: ["gpt-4"],
			config: { apiKey: "sk-test123" },
		});

		// Partial update: only change name, use ***encrypted*** to preserve apiKey
		await saveProvider(env, {
			id: "test-partial",
			type: "openai",
			name: "Updated Name",
			config: { apiKey: "***encrypted***" },
		});

		const provider = await getProvider(env, "test-partial");
		expect(provider).not.toBeNull();
		expect(provider.name).toBe("Updated Name");
		expect(provider.enabled).toBe(false); // MUST preserve false, not reset to true
		expect(provider.weight).toBe(5); // MUST preserve 5, not reset to 1
		expect(provider.models).toEqual(["gpt-4"]); // MUST preserve, not reset to []
	});

	it("preserves enabled when updating config only", async () => {
		await saveProvider(env, {
			id: "test-config",
			type: "openai",
			name: "Test",
			enabled: false,
			weight: 3,
			models: ["claude-3"],
			config: { apiKey: "sk-original" },
		});

		// Update only config (e.g., rotating API key)
		await saveProvider(env, {
			id: "test-config",
			type: "openai",
			name: "Test",
			config: { apiKey: "sk-new-key" },
		});

		const provider = await getProvider(env, "test-config");
		expect(provider.enabled).toBe(false);
		expect(provider.weight).toBe(3);
		expect(provider.models).toEqual(["claude-3"]);
		expect(provider.config.apiKey).toBe("sk-new-key");
	});
});

describe("Critical fix #6: v1beta route conflict", () => {
	beforeAll(async () => {
		await setupTables();
	});

	it("does NOT return 'Missing action' for POST /v1beta/models/:modelId without action", async () => {
		const request = new Request("http://example.com/v1beta/models/gemini-2.5-flash", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ contents: [{ parts: [{ text: "Hi" }] }] }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Should NOT return 400 "Missing action" — should default to generateContent
		// (May return 400 "No enabled provider" or 502, but NOT "Missing action")
		const data = await response.json();
		expect(JSON.stringify(data)).not.toContain("Missing action");
	});
});
