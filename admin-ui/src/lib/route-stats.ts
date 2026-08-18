export interface RouteStatsProvider {
	id: string;
	name: string;
	type: string;
	enabled: boolean;
	requestCount: number;
	averageLatencyMs: number | null;
}

export interface RouteStatsTrendPoint {
	timestamp: string;
	providers: Record<string, number | null>;
}

export interface RouteStatsResponse {
	periodHours: number;
	from: string;
	to: string;
	overview: {
		models: number;
		upstreams: number;
		healthyUpstreams: number;
		trackedRequests: number;
		averageLatencyMs: number | null;
	};
	providers: RouteStatsProvider[];
	latency: {
		providerIds: string[];
		points: RouteStatsTrendPoint[];
	};
}

export async function getRouteStats(periodHours = 24, signal?: AbortSignal): Promise<RouteStatsResponse> {
	const params = new URLSearchParams({ hours: String(periodHours) });
	const headers: Record<string, string> = {};
	const token = typeof localStorage !== 'undefined' ? localStorage.getItem('admin_token') : '';
	if (token) headers.Authorization = `Bearer ${token}`;

	const response = await fetch(`/admin/routes/stats?${params}`, { headers, signal });
	let data: any = {};
	try {
		data = await response.json();
	} catch {
		// keep empty payload for a useful HTTP error below
	}
	if (!response.ok) {
		throw new Error(data.error || `获取路由统计失败（HTTP ${response.status}）`);
	}
	return data as RouteStatsResponse;
}

export function formatLatency(value: number | null): string {
	if (value == null || !Number.isFinite(value)) return '暂无数据';
	if (value < 1000) return `${Math.round(value)} ms`;
	return `${(value / 1000).toFixed(2)} s`;
}

export function buildLatencySeries(stats: RouteStatsResponse): Array<{
	providerId: string;
	name: string;
	values: Array<number | null>;
}> {
	const names = new Map(stats.providers.map((provider) => [provider.id, provider.name]));
	return stats.latency.providerIds.map((providerId) => ({
		providerId,
		name: names.get(providerId) || providerId,
		values: stats.latency.points.map((point) => point.providers[providerId] ?? null),
	}));
}

export function hasLatencyData(stats: RouteStatsResponse): boolean {
	return stats.latency.points.some((point) =>
		Object.values(point.providers).some((value) => value != null && Number.isFinite(value)),
	);
}
