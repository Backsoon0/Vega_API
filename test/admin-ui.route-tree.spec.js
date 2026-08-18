// Pure-logic tests for the route-topology tree UI helpers.
// These run in the worker test pool — route-topology.ts is framework-free
// (no Svelte runtime), so no DOM is involved.
//
// Covers: model expand/collapse, provider expand/collapse, Expand All,
// Collapse All, search, status filter, mode filter.

import { describe, it, expect } from "vitest";
import {
	providerHealth,
	modelStats,
	toggleSetKey,
	expandAll,
	collapseAll,
	filterModels,
	matchesSearch,
	MODE_LABELS,
} from "../admin-ui/src/lib/route-topology";

// ---- Fixtures ----

/** Minimal RouteTopologyProvider-shaped object. */
function mkProvider(
	id,
	{ enabled = true, weight = 1, circuitState = "closed", matchedBy = "configured", name } = {},
) {
	return {
		id,
		name: name ?? `Provider ${id}`,
		type: "openai",
		enabled,
		weight,
		matchedBy,
		matchedModel: "gpt-4o",
		modelConfigured: true,
		circuitState,
	};
}

/** Minimal RouteTopologyModel-shaped object. */
function mkModel(id, providers, routingMode = "priority", failoverEnabled = false) {
	return { id, routingMode, failoverEnabled, providers };
}

const fixture = () => [
	mkModel("gpt-4o", [
		mkProvider("openai-main", { weight: 10 }),
		mkProvider("openrouter", { weight: 5, circuitState: "open" }),
		mkProvider("backup-api", { enabled: false, weight: 1 }),
	], "failover", true),
	mkModel("claude-sonnet-4", [
		mkProvider("anthropic-main", { circuitState: "half-open" }),
	], "priority", false),
	mkModel("gemini-2.0", [], "priority", false),
];

// ---- Health mapping ----

describe("providerHealth", () => {
	it("maps circuit state + enabled flag to a display health", () => {
		expect(providerHealth(mkProvider("a"))).toBe("healthy");
		expect(providerHealth(mkProvider("a", { circuitState: "open" }))).toBe("open");
		expect(providerHealth(mkProvider("a", { circuitState: "half-open" }))).toBe("half-open");
		expect(providerHealth(mkProvider("a", { enabled: false }))).toBe("disabled");
		// disabled wins over any circuit state
		expect(providerHealth(mkProvider("a", { enabled: false, circuitState: "open" }))).toBe("disabled");
	});
});

describe("modelStats", () => {
	it("counts total / available / disabled / open / half-open", () => {
		const s = modelStats(fixture()[0]);
		expect(s.total).toBe(3);
		expect(s.available).toBe(2);
		expect(s.disabled).toBe(1);
		expect(s.open).toBe(1);
		expect(s.halfOpen).toBe(0);
	});
});

// ---- Expand / collapse (Set-based tree state) ----

describe("tree expansion state", () => {
	it("toggles a key on and off (returns new Sets)", () => {
		let s = new Set(["a"]);
		s = toggleSetKey(s, "b");
		expect([...s]).toEqual(["a", "b"]);
		s = toggleSetKey(s, "a");
		expect([...s]).toEqual(["b"]);
		// immutability: original set untouched
		const original = new Set(["x"]);
		toggleSetKey(original, "y");
		expect(original.has("y")).toBe(false);
	});

	it("expandAll expands every model, group and provider", () => {
		const state = expandAll(fixture());
		expect([...state.models].sort()).toEqual(["claude-sonnet-4", "gemini-2.0", "gpt-4o"]);
		expect([...state.groups].sort()).toEqual(["route:claude-sonnet-4", "route:gemini-2.0", "route:gpt-4o"]);
		expect([...state.providers].sort()).toEqual([
			"claude-sonnet-4::anthropic-main",
			"gpt-4o::backup-api",
			"gpt-4o::openai-main",
			"gpt-4o::openrouter",
		]);
	});

	it("collapseAll clears every level", () => {
		const state = collapseAll();
		expect(state.models.size).toBe(0);
		expect(state.groups.size).toBe(0);
		expect(state.providers.size).toBe(0);
	});
});

// ---- Search ----

describe("matchesSearch", () => {
	it("matches model id, provider name and provider id (case-insensitive)", () => {
		const model = fixture()[0];
		expect(matchesSearch(model, "")).toBe(true);
		expect(matchesSearch(model, "gpt")).toBe(true);
		expect(matchesSearch(model, "openrouter")).toBe(true); // provider name
		expect(matchesSearch(model, "openai-MAIN")).toBe(true); // provider id, case-insensitive
		expect(matchesSearch(model, "claude")).toBe(false);
	});
});

// ---- Filters ----

describe("filterModels", () => {
	it("mode filter keeps only matching routing modes", () => {
		const r = filterModels(fixture(), { query: "", status: "all", mode: "failover" });
		expect(r.map((m) => m.id)).toEqual(["gpt-4o"]);
		const r2 = filterModels(fixture(), { query: "", status: "all", mode: "priority" });
		expect(r2.map((m) => m.id)).toEqual(["claude-sonnet-4", "gemini-2.0"]);
	});

	it("status=open keeps only providers with an open circuit and drops empty models", () => {
		const r = filterModels(fixture(), { query: "", status: "open", mode: "all" });
		expect(r.map((m) => m.id)).toEqual(["gpt-4o"]);
		expect(r[0].providers.map((p) => p.id)).toEqual(["openrouter"]);
	});

	it("status=disabled keeps only disabled providers", () => {
		const r = filterModels(fixture(), { query: "", status: "disabled", mode: "all" });
		expect(r.map((m) => m.id)).toEqual(["gpt-4o"]);
		expect(r[0].providers.map((p) => p.id)).toEqual(["backup-api"]);
	});

	it("status=half-open keeps half-open providers", () => {
		const r = filterModels(fixture(), { query: "", status: "half-open", mode: "all" });
		expect(r.map((m) => m.id)).toEqual(["claude-sonnet-4"]);
	});

	it("search + mode + status combine", () => {
		const r = filterModels(fixture(), { query: "gpt", status: "open", mode: "failover" });
		expect(r.map((m) => m.id)).toEqual(["gpt-4o"]);
		expect(r[0].providers.map((p) => p.id)).toEqual(["openrouter"]);
	});

	it("never mutates input models", () => {
		const models = fixture();
		filterModels(models, { query: "", status: "open", mode: "all" });
		expect(models[0].providers).toHaveLength(3); // original intact
	});
});

describe("MODE_LABELS", () => {
	it("exposes the three modes incl. reserved weighted", () => {
		expect(MODE_LABELS.priority).toBe("Priority Route");
		expect(MODE_LABELS.failover).toBe("Failover");
		expect(MODE_LABELS.weighted).toBe("Weighted");
	});
});