// Test coverage for the admin route-topology feature (GET /admin/routes).
//
// Requirements covered:
//   1. one model → one provider
//   2. one model → multiple providers
//   3. disabled provider (shown but marked disabled, never routed)
//   4. failover_enabled = true  → routingMode "failover"
//   5. failover_enabled = false → routingMode "priority"
//   6. weight sorting (weight desc = request order)
//   7. model prefix matching ("openai/gpt-4" → "openai/gpt-4-0613")
//   8. fallback to ALL enabled providers (via buildModelTopology)
//   9. Circuit Open provider surfaced in the topology
//  10. no apiKey/privateKey exposure
// Plus: admin auth on the endpoint, topology == findProviderForModel(), and
// live-model-list attribution.

import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import worker from "../src";
import {
	getRouteTopology,
	buildModelTopology,
	invalidateCaches,
	findProviderForModel,
} from "../src/router";
import { recordFailure, getCircuitState } from "../src/circuit-breaker";
import { sha256 } from "../src/crypto";
import { setFailoverEnabled } from "../src/config";

// ---- Helpers ----

async function setupTables() {
	const migrations = [
		"CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		"CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('vertex_ai', 'google_ai_studio', 'openai', 'anthropic')), name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', weight INTEGER NOT NULL DEFAULT 1)",
		"CREATE TABLE IF NOT EXISTS usage_daily (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(date, provider_id, model))",
		"CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL DEFAULT 0, banned_until INTEGER NOT NULL DEFAULT 0)",
		"CREATE TABLE IF NOT EXISTS call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, ip TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, success INTEGER NOT NULL DEFAULT 1, request_id TEXT NOT NULL DEFAULT '', is_stream INTEGER NOT NULL DEFAULT 0, extra TEXT NOT NULL DEFAULT '{}')",
		"CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, quota_calls INTEGER, quota_tokens INTEGER, quota_period TEXT NOT NULL DEFAULT 'day')",
		"CREATE TABLE IF NOT EXISTS key_usage_daily (key_name TEXT NOT NULL, date TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, UNIQUE(key_name, date))",
	];
	for (const stmt of migrations) {
		await env.DB.exec(stmt);
	}
}

async function insertProvider(
	id,
	{ type = "anthropic", name, models = [], weight = 1, enabled = 1, config = {} } = {},
) {
	await env.DB
		.prepare("INSERT INTO providers (id, type, name, enabled, config, models, weight) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(id, type, name ?? `Provider ${id}`, enabled, JSON.stringify(config), JSON.stringify(models), weight)
		.run();
	invalidateCaches();
}

/** Pull one model's topology row out of a full topology response. */
async function topologyFor(modelId) {
	const data = await getRouteTopology(env);
	return data.models.find((m) => m.id === modelId);
}

/** Minimal Provider-shaped object for pure unit tests (no D1). */
function mkProvider(id, { models = [], weight = 1, enabled = true, type = "anthropic" } = {}) {
	return {
		id,
		type,
		name: `Provider ${id}`,
		enabled,
		config: {},
		models,
		weight,
	};
}

beforeAll(async () => {
	await setupTables();
	await env.DB.exec("DELETE FROM providers");
	await env.DB.exec("DELETE FROM config WHERE key = 'failover_enabled'");
});

beforeEach(async () => {
	await env.DB.exec("DELETE FROM providers");
	await env.DB.exec("DELETE FROM config WHERE key IN ('failover_enabled', 'admin_password')");
	invalidateCaches();
});

afterEach(async () => {
	await env.DB.exec("DELETE FROM providers");
	await env.DB.exec("DELETE FROM config WHERE key IN ('failover_enabled', 'admin_password')");
	invalidateCaches();
	try {
		fetchMock.deactivate();
	} catch { /* not active */ }
});

// ---- Integration: getRouteTopology over D1 ----

describe("route topology - provider matching", () => {
	it("1+2. one model maps to one / multiple providers with correct mode", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-b", { models: ["gpt-4o"], weight: 5 });
		await insertProvider("prov-2", { models: ["gpt-4o"], weight: 3 });

		const single = await topologyFor("gpt-4");
		expect(single).toBeDefined();
		expect(single.providers).toHaveLength(1);
		expect(single.providers[0].id).toBe("prov-a");
		expect(single.providers[0].matchedBy).toBe("configured");
		expect(single.providers[0].modelConfigured).toBe(true);
		expect(single.routingMode).toBe("priority"); // single candidate

		const multi = await topologyFor("gpt-4o");
		expect(multi.providers.map((p) => p.id)).toEqual(["prov-b", "prov-2"]);
		expect(multi.routingMode).toBe("failover"); // 2 candidates + failover default on
	});

	it("3. disabled providers are appended but flagged unusable", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-b", { models: ["gpt-4"], enabled: 0, weight: 1 });

		const m = await topologyFor("gpt-4");
		expect(m.providers.map((p) => p.id)).toEqual(["prov-a", "prov-b"]);
		expect(m.providers[0].enabled).toBe(true);
		expect(m.providers[1].enabled).toBe(false);
		expect(m.providers[1].matchedBy).toBe("configured");
		expect(m.providers[1].circuitState).toBe("closed");
	});

	it("3b. disabled provider with no explicit model match is NOT shown", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"] });
		await insertProvider("prov-b", { models: ["claude-3"], enabled: 0 });

		const m = await topologyFor("gpt-4");
		expect(m.providers.map((p) => p.id)).toEqual(["prov-a"]); // prov-b doesn't mention gpt-4
	});

	it("4. failover_enabled=true -> routingMode failover", async () => {
		await setFailoverEnabled(env, true);
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-b", { models: ["gpt-4"], weight: 5 });

		const data = await getRouteTopology(env);
		expect(data.failoverEnabled).toBe(true);
		const m = data.models.find((x) => x.id === "gpt-4");
		expect(m.routingMode).toBe("failover");
	});

	it("5. failover_enabled=false -> routingMode priority", async () => {
		await setFailoverEnabled(env, false);
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-b", { models: ["gpt-4"], weight: 5 });

		const m = await topologyFor("gpt-4");
		expect(m.routingMode).toBe("priority");
		expect(m.failoverEnabled).toBe(false);
	});

	it("6. candidates are sorted by weight desc (request order)", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 1 });
		await insertProvider("prov-b", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-c", { models: ["gpt-4"], weight: 5 });

		const m = await topologyFor("gpt-4");
		expect(m.providers.map((p) => p.id)).toEqual(["prov-b", "prov-c", "prov-a"]);
	});

	it("7. prefix matching with '/' delimiter is attributed as prefix", async () => {
		// The routing rule requires the configured prefix to be followed by '/':
		// "openai/gpt-4o" matches "openai/gpt-4o/vision-preview" but NOT
		// "openai/gpt-4o-vision".
		await insertProvider("prov-prefix", { models: ["openai/gpt-4o"] });
		await insertProvider("prov-exact", { models: ["openai/gpt-4o/vision-preview"] });

		const m = await topologyFor("openai/gpt-4o/vision-preview");
		const prefixProvider = m.providers.find((p) => p.id === "prov-prefix");
		expect(prefixProvider).toBeDefined();
		expect(prefixProvider.matchedBy).toBe("prefix");
		expect(prefixProvider.matchedPattern).toBe("openai/gpt-4o");
		expect(prefixProvider.modelConfigured).toBe(false);
		const exactProvider = m.providers.find((p) => p.id === "prov-exact");
		expect(exactProvider.matchedBy).toBe("configured");
		expect(exactProvider.modelConfigured).toBe(true);

		// No '/' after the pattern → no prefix attribution for
		// "openai/gpt-4o-vision": it matches only via the global fallback.
		// (Checked through the pure builder — the model isn't in the aggregated
		// universe because no provider configures it.)
		const pure = buildModelTopology(
			"openai/gpt-4o-vision",
			[mkProvider("prov-prefix", { models: ["openai/gpt-4o"] })],
			[],
			[],
			true,
		);
		const fb = pure.providers.find((p) => p.id === "prov-prefix");
		expect(fb).toBeDefined();
		expect(fb.matchedBy).toBe("fallback");
		expect(fb.matchedPattern).toBeUndefined();
	});

	it("topology candidates match findProviderForModel() exactly (visualization == real path)", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		await insertProvider("prov-b", { models: ["gpt-4", "gpt-4o"], weight: 5 });
		await insertProvider("prov-c", { models: ["openai/gpt-4"], weight: 3 });

		const data = await getRouteTopology(env);
		expect(data.models.length).toBeGreaterThan(0);

		for (const m of data.models) {
			const requestPath = (await findProviderForModel(env, m.id))
				.map((x) => x.provider.id)
				.sort();
			const topologyPath = m.providers.filter((p) => p.enabled).map((p) => p.id).sort();
			expect(topologyPath).toEqual(requestPath);
		}
	});
});

describe("route topology - pure buildModelTopology (fallback and circuit)", () => {
	it("8. fallback: unknown model -> ALL enabled providers, weight desc", () => {
		const providers = [
			mkProvider("p1", { weight: 1 }),
			mkProvider("p2", { weight: 10 }),
			mkProvider("p3", { weight: 5 }),
		];
		const m = buildModelTopology("never-seen-model", providers, [], [], true);
		expect(m.providers.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
		expect(m.providers.every((p) => p.matchedBy === "fallback")).toBe(true);
		expect(m.routingMode).toBe("failover");
	});

	it("9. Circuit Open provider is surfaced as circuitState open", async () => {
		await insertProvider("prov-circuit", { models: ["gpt-4"] });
		// Open the circuit (threshold defaults to 5)
		for (let i = 0; i < 5; i++) recordFailure("prov-circuit");
		expect(getCircuitState("prov-circuit")).toBe("open");

		const m = await topologyFor("gpt-4");
		expect(m.providers[0].circuitState).toBe("open");
	});

	it("9b. healthy provider -> closed circuit state", async () => {
		await insertProvider("prov-healthy", { models: ["gpt-4"] });
		const m = await topologyFor("gpt-4");
		expect(m.providers[0].circuitState).toBe("closed");
	});
});

describe("GET /admin/routes (HTTP)", () => {
	it("rejects unauthenticated requests with 401", async () => {
		const req = new Request("http://example.com/admin/routes");
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(401);
	});

	it("returns topology JSON for an authenticated admin", async () => {
		await insertProvider("prov-a", { models: ["gpt-4"], weight: 10 });
		const token = await sha256("adminpass-route-test");
		await env.DB.prepare("INSERT INTO config (key, value) VALUES ('admin_password', ?)").bind(token).run();

		const req = new Request("http://example.com/admin/routes", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);

		const data = await resp.json();
		expect(Array.isArray(data.models)).toBe(true);
		expect(typeof data.failoverEnabled).toBe("boolean");
		expect(typeof data.generatedAt).toBe("string");
		const gpt4 = data.models.find((m) => m.id === "gpt-4");
		expect(gpt4).toBeDefined();
		expect(gpt4.providers[0].id).toBe("prov-a");
	});

	it("10. never exposes apiKey / privateKey / config in the response", async () => {
		await insertProvider("prov-secret", {
			models: ["gpt-4"],
			config: { apiKey: "sk-super-secret-value-xyz", privateKey: "pk-super-secret-value-xyz", baseUrl: "https://example.com" },
		});
		const token = await sha256("adminpass-route-test-2");
		await env.DB.prepare("INSERT INTO config (key, value) VALUES ('admin_password', ?)").bind(token).run();

		const req = new Request("http://example.com/admin/routes", {
			headers: { Authorization: `Bearer ${token}` },
		});
		const ctx = createExecutionContext();
		const resp = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(resp.status).toBe(200);

		const text = JSON.stringify(await resp.json());
		expect(text).not.toContain("sk-super-secret-value-xyz");
		expect(text).not.toContain("pk-super-secret-value-xyz");
		expect(text).not.toContain("apiKey");
		expect(text).not.toContain("privateKey");
		expect(text).not.toContain('"config"');
		expect(text).not.toContain("enc:");
	});
});

describe("route topology - live-model-list attribution", () => {
	it("tags providers whose model came from a live fetch as 'live'", async () => {
		// prov-live does NOT configure the model — it appears via the mocked
		// live /v1/models fetch. prov-cfg configures it explicitly.
		fetchMock.activate();
		fetchMock.disableNetConnect();
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/models", method: "GET" })
			.reply(200, {
				object: "list",
				data: [{ id: "live-only-model", object: "model", created: 0, owned_by: "openai" }],
			});

		await insertProvider("prov-live", { type: "openai", models: [], config: { apiKey: "sk-live" } });
		await insertProvider("prov-cfg", { models: ["live-only-model"] });

		const m = await topologyFor("live-only-model");
		expect(m).toBeDefined();
		expect(m.providers.find((p) => p.id === "prov-live")?.matchedBy).toBe("live");
		expect(m.providers.find((p) => p.id === "prov-live")?.modelConfigured).toBe(false);
		expect(m.providers.find((p) => p.id === "prov-cfg")?.matchedBy).toBe("configured");
		expect(m.providers.find((p) => p.id === "prov-cfg")?.modelConfigured).toBe(true);
	});
});