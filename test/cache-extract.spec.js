// Unit tests for cache-token extraction (extractOpenAICacheTokens / extractCacheTokens).
// Covers the various third-party OpenAI-compatible usage shapes (DeepSeek,
// OpenAI standard, top-level cached_tokens, Anthropic-style) plus regression
// coverage for the AI SDK providerMetadata path.
import { describe, it, expect } from "vitest";
import { extractOpenAICacheTokens, extractCacheTokens } from "../src/usage";

describe("extractOpenAICacheTokens", () => {
	it("extracts DeepSeek-style prompt_cache_hit_tokens", () => {
		const cache = extractOpenAICacheTokens({
			prompt_tokens: 1234,
			completion_tokens: 56,
			prompt_cache_hit_tokens: 1111,
			prompt_cache_miss_tokens: 123,
		});
		expect(cache.cacheReadInputTokens).toBe(1111);
	});

	it("extracts OpenAI-standard prompt_tokens_details.cached_tokens", () => {
		const cache = extractOpenAICacheTokens({
			prompt_tokens: 500,
			completion_tokens: 30,
			prompt_tokens_details: { cached_tokens: 456 },
		});
		expect(cache.cacheReadInputTokens).toBe(456);
	});

	it("takes the max when both DeepSeek and OpenAI shapes are present", () => {
		const cache = extractOpenAICacheTokens({
			prompt_cache_hit_tokens: 80,
			prompt_tokens_details: { cached_tokens: 90 },
		});
		expect(cache.cacheReadInputTokens).toBe(90);
	});

	it("extracts top-level cached_tokens", () => {
		const cache = extractOpenAICacheTokens({ cached_tokens: 50 });
		expect(cache.cacheReadInputTokens).toBe(50);
	});

	it("extracts Anthropic-style cache_read_input_tokens", () => {
		const cache = extractOpenAICacheTokens({
			cache_read_input_tokens: 70,
			cache_creation_input_tokens: 12,
		});
		expect(cache.cacheReadInputTokens).toBe(70);
		expect(cache.cacheCreationInputTokens).toBe(12);
	});

	it("coerces string token counts", () => {
		const cache = extractOpenAICacheTokens({ prompt_cache_hit_tokens: "200" });
		expect(cache.cacheReadInputTokens).toBe(200);
	});

	it("returns zeros when no cache fields are present", () => {
		const cache = extractOpenAICacheTokens({ prompt_tokens: 10, completion_tokens: 5 });
		expect(cache.cacheReadInputTokens).toBe(0);
		expect(cache.cacheCreationInputTokens).toBe(0);
	});

	it("returns zeros for null / undefined / non-object input", () => {
		expect(extractOpenAICacheTokens(null)).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
		expect(extractOpenAICacheTokens(undefined)).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
		expect(extractOpenAICacheTokens("nope")).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
	});
});

describe("extractCacheTokens (AI SDK providerMetadata)", () => {
	it("extracts DeepSeek-style cache from metadata.openai.usage", () => {
		const cache = extractCacheTokens({
			openai: {
				usage: { prompt_cache_hit_tokens: 999 },
			},
		});
		expect(cache.cacheReadInputTokens).toBe(999);
	});

	it("extracts OpenAI-standard cache from metadata.openai.usage", () => {
		const cache = extractCacheTokens({
			openai: {
				usage: { prompt_tokens_details: { cached_tokens: 321 } },
			},
		});
		expect(cache.cacheReadInputTokens).toBe(321);
	});

	it("still extracts Anthropic cache_read_input_tokens (regression)", () => {
		const cache = extractCacheTokens({
			anthropic: {
				usage: { cache_read_input_tokens: 888, cache_creation_input_tokens: 44 },
			},
		});
		expect(cache.cacheReadInputTokens).toBe(888);
		expect(cache.cacheCreationInputTokens).toBe(44);
	});

	it("returns zeros when metadata is empty", () => {
		expect(extractCacheTokens(undefined)).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
		expect(extractCacheTokens({})).toEqual({ cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
	});
});
