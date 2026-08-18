import { describe, it, expect } from "vitest";
import { formatLatency, buildLatencySeries, hasLatencyData } from "../admin-ui/src/lib/route-stats";

const base = {
	periodHours: 24,
	from: "2026-08-18T00:00:00.000Z",
	to: "2026-08-19T00:00:00.000Z",
	overview: { models: 2, upstreams: 2, healthyUpstreams: 2, trackedRequests: 3, averageLatencyMs: 200 },
	providers: [
		{ id: "p1", name: "Primary", type: "openai", enabled: true, requestCount: 2, averageLatencyMs: 200 },
		{ id: "p2", name: "Backup", type: "openai", enabled: true, requestCount: 1, averageLatencyMs: null },
	],
	latency: {
		providerIds: ["p1"],
		points: [
			{ timestamp: "2026-08-18T00:00:00.000Z", providers: { p1: 180 } },
			{ timestamp: "2026-08-18T02:00:00.000Z", providers: { p1: null } },
		],
	},
};

describe("route statistics helpers", () => {
	it("formats real latency and null as no data", () => {
		expect(formatLatency(123)).toBe("123 ms");
		expect(formatLatency(1234)).toBe("1.23 s");
		expect(formatLatency(null)).toBe("暂无数据");
	});

	it("builds provider latency series without converting null to zero", () => {
		const series = buildLatencySeries(base);
		expect(series).toHaveLength(1);
		expect(series[0].name).toBe("Primary");
		expect(series[0].values).toEqual([180, null]);
	});

	it("detects whether the chart has real latency samples", () => {
		expect(hasLatencyData(base)).toBe(true);
		expect(hasLatencyData({ ...base, latency: { providerIds: [], points: [{ timestamp: "x", providers: {} }] } })).toBe(false);
	});
});
