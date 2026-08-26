<script lang="ts">
	import { getRoutes } from "$lib/api";
	import type { RouteTopologyModel } from "$lib/api";
	import {
		emptyTreeState,
		expandAll,
		collapseAll,
		filterModels,
		modelStats,
		providerHealth,
		toggleSetKey,
		MODE_LABELS,
		MATCHED_BY_LABELS,
		HEALTH_LABELS,
		type StatusFilter,
		type ModeFilter,
		type TreeState,
	} from "$lib/route-topology";
	import { getRouteStats, formatLatency, type RouteStatsResponse } from "$lib/route-stats";
	import Spinner from "$lib/Spinner.svelte";
	import { RefreshCw, Search, ChevronDown, ChevronRight, ListTree, BarChart3, Activity, Network } from "lucide-svelte";

	let models = $state<RouteTopologyModel[]>([]);
	let failoverEnabledGlobal = $state(true);
	let generatedAt = $state("");
	let loading = $state(true);
	let statsLoading = $state(true);
	let error = $state("");
	let statsError = $state("");
	let lastRefreshed = $state("");
	let periodHours = $state(24);
	let routeStats = $state<RouteStatsResponse | null>(null);
	let statsInitialized = false;

	let query = $state("");
	let statusFilter = $state<StatusFilter>("all");
	let modeFilter = $state<ModeFilter>("all");
	let expanded = $state<TreeState>(emptyTreeState());

	function groupKey(modelId: string) { return `route:${modelId}`; }
	function providerKey(modelId: string, providerId: string) { return `${modelId}::${providerId}`; }
	function toggleModel(id: string) { expanded = { ...expanded, models: toggleSetKey(expanded.models, id) }; }
	function toggleGroup(id: string) { expanded = { ...expanded, groups: toggleSetKey(expanded.groups, groupKey(id)) }; }
	function toggleProvider(modelId: string, providerId: string) {
		expanded = { ...expanded, providers: toggleSetKey(expanded.providers, providerKey(modelId, providerId)) };
	}
	function handleExpandAll() { expanded = expandAll(filtered); }
	function handleCollapseAll() { expanded = collapseAll(); }

	async function loadRoutes() {
		loading = true;
		error = "";
		try {
			const res = await getRoutes();
			models = res.models || [];
			failoverEnabledGlobal = res.failoverEnabled;
			generatedAt = res.generatedAt || "";
			lastRefreshed = generatedAt
				? new Date(generatedAt).toLocaleTimeString("zh-CN", { hour12: false })
				: new Date().toLocaleTimeString("zh-CN", { hour12: false });
		} catch (err: any) {
			error = err?.message || "加载路由拓扑失败";
		} finally {
			loading = false;
		}
	}

	async function loadStats() {
		statsLoading = true;
		statsError = "";
		try {
			routeStats = await getRouteStats(periodHours);
		} catch (err: any) {
			statsError = err?.message || "加载路由统计失败";
		} finally {
			statsLoading = false;
		}
	}

	async function loadAll() {
		await Promise.all([loadRoutes(), loadStats()]);
	}

	$effect(() => { loadAll(); });
	$effect(() => {
		const hours = periodHours;
		if (!statsInitialized) {
			statsInitialized = true;
			return;
		}
		if (hours) loadStats();
	});

	const filtered = $derived(filterModels(models, { query, status: statusFilter, mode: modeFilter }));
	const barProviders = $derived(
		[...(routeStats?.providers || [])]
			.filter((provider) => Number.isFinite(provider.requestCount) && provider.requestCount >= 0)
			.sort((a, b) => b.requestCount - a.requestCount)
			.slice(0, 10),
	);
	const maxRequests = $derived(Math.max(1, ...barProviders.map((provider) => provider.requestCount)));
	const chartProviders = $derived(
		[...(routeStats?.providers || [])]
			.filter((provider) => provider.averageLatencyMs != null && Number.isFinite(provider.averageLatencyMs))
			.sort((a, b) => b.requestCount - a.requestCount)
			.slice(0, 6),
	);
	const chartPoints = $derived(routeStats?.latency.points || []);
	const maxLatency = $derived(Math.max(
		1,
		...chartPoints.flatMap((point) =>
			Object.values(point.providers).filter((value): value is number => value != null && Number.isFinite(value)),
		),
	));

	function xFor(index: number) {
		return chartPoints.length <= 1 ? 50 : (index / (chartPoints.length - 1)) * 100;
	}
	function yFor(value: number) {
		return 100 - (value / maxLatency) * 82 - 8;
	}
	function lineSegments(providerId: string) {
		const segments: string[] = [];
		let current: string[] = [];
		for (let i = 0; i < chartPoints.length; i++) {
			const value = chartPoints[i].providers[providerId];
			if (value == null || !Number.isFinite(value)) {
				if (current.length > 1) segments.push(current.join(" "));
				current = [];
				continue;
			}
			current.push(`${xFor(i)},${yFor(value)}`);
		}
		if (current.length > 1) segments.push(current.join(" "));
		return segments;
	}
	function pointValues(providerId: string) {
		return chartPoints.map((point, index) => {
			const value = point.providers[providerId];
			return value == null || !Number.isFinite(value) ? null : { x: xFor(index), y: yFor(value), value };
		}).filter(Boolean) as Array<{ x: number; y: number; value: number }>;
	}
	function typeLabel(type: string) {
		return type === "vertex_ai" ? "Vertex" : type === "google_ai_studio" ? "Studio" : type === "anthropic" ? "Anthropic" : "OpenAI";
	}

	const TYPE_TAG: Record<string, string> = {
		openai: "tag-openai",
		vertex_ai: "tag-vertex",
		google_ai_studio: "tag-studio",
		anthropic: "tag-anthropic",
	};
	const HEALTH_DOT: Record<string, string> = {
		healthy: "var(--success)",
		"half-open": "var(--warning)",
		open: "var(--danger)",
		disabled: "var(--muted)",
	};
	const HEALTH_COLOR: Record<string, string> = {
		healthy: "var(--success)",
		"half-open": "var(--warning)",
		open: "var(--danger)",
		disabled: "var(--muted)",
	};
	const MODE_TAG: Record<string, string> = {
		failover: "chip-cta",
		weighted: "chip-accent",
		priority: "chip-muted",
	};
	const CHART_COLORS = [
		"var(--color-cta)",
		"var(--color-accent)",
		"var(--color-warning)",
		"var(--color-danger)",
		"#a78bfa",
		"#38bdf8",
	];
</script>

<svelte:head><title>路由拓扑 — Vega API</title></svelte:head>

<div class="page-head">
	<div>
		<h1>路由拓扑</h1>
		<p class="lead">模型 → Provider 路由关系与实时统计</p>
	</div>
	<div class="actions">
		<select
			class="select"
			style="width:auto;font-size:12.5px"
			value={periodHours}
			onchange={(event) => (periodHours = Number((event.target as HTMLSelectElement).value))}
		>
			<option value={6}>最近 6 小时</option>
			<option value={24}>最近 24 小时</option>
			<option value={72}>最近 3 天</option>
			<option value={168}>最近 7 天</option>
		</select>
		<button class="btn btn-ghost" onclick={loadAll} disabled={loading || statsLoading}>
			<RefreshCw class={loading || statsLoading ? "animate-spin" : ""} stroke-width={1.8} />
			刷新
		</button>
	</div>
</div>

{#if loading && models.length === 0}
	<div class="empty" style="min-height:40vh;display:grid;place-items:center">
		<div class="flex items-center justify-center min-h-[40vh]">
			<div class="flex flex-col items-center gap-4"><Spinner class="text-cta" /><span class="mono" style="font-size:13px;color:var(--muted)">加载路由拓扑...</span></div>
		</div>
	</div>
{:else if error && models.length === 0}
	<div class="empty" style="padding:40px;color:var(--danger)">{error}
		<div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick={loadRoutes}>重试</button></div>
	</div>
{:else}
	<!-- Overview stat cards -->
	<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px">
		<div class="card card-pad rise" style="--d:40ms">
			<div style="font-size:11px;color:var(--muted);margin-bottom:8px">模型</div>
			<div class="kpi-val" style="font-size:20px">{routeStats?.overview.models ?? models.length}</div>
		</div>
		<div class="card card-pad rise" style="--d:90ms">
			<div style="font-size:11px;color:var(--muted);margin-bottom:8px">上游 Provider</div>
			<div class="kpi-val" style="font-size:20px">{routeStats?.overview.upstreams ?? "—"}</div>
		</div>
		<div class="card card-pad rise" style="--d:140ms">
			<div style="font-size:11px;color:var(--muted);margin-bottom:8px">健康上游</div>
			<div class="kpi-val" style="font-size:20px;color:var(--success)">{routeStats ? routeStats.overview.healthyUpstreams : "—"}</div>
		</div>
		<div class="card card-pad rise" style="--d:190ms">
			<div style="font-size:11px;color:var(--muted);margin-bottom:8px">跟踪请求</div>
			<div class="kpi-val" style="font-size:20px">{routeStats ? routeStats.overview.trackedRequests.toLocaleString() : "—"}</div>
			<div style="font-size:10px;color:var(--muted);margin-top:4px">最近 {periodHours}h</div>
		</div>
		<div class="card card-pad rise" style="--d:240ms">
			<div style="font-size:11px;color:var(--muted);margin-bottom:8px">平均时延</div>
			<div class="kpi-val" style="font-size:20px">{formatLatency(routeStats?.overview.averageLatencyMs ?? null)}</div>
		</div>
	</div>

	<div class="grid grid-2 mb-lg">
		<!-- Provider request volume -->
		<div class="card rise" style="--d:280ms">
			<div class="card-head">
				<div>
					<h2><BarChart3 stroke-width={1.5} />Provider 请求量</h2>
					<div class="sub">按调用记录聚合</div>
				</div>
			</div>
			<div style="padding:18px 20px" id="reqBars">
				{#if statsLoading && !routeStats}
					<div style="height:200px;display:grid;place-items:center"><Spinner /></div>
				{:else if statsError && !routeStats}
					<div class="empty" style="padding:30px">{statsError}</div>
				{:else if barProviders.length === 0}
					<div class="empty" style="padding:30px">暂无数据</div>
				{:else}
					{#each barProviders as provider}
						<div style="margin-bottom:14px">
							<div class="between" style="font-size:12px;margin-bottom:6px">
								<span style="color:var(--fg-2)">{provider.name}</span>
								<span class="mono">{provider.requestCount.toLocaleString()}</span>
							</div>
							<div style="height:8px;border-radius:6px;background:var(--surface-3);overflow:hidden">
								<div style="height:100%;border-radius:6px;background:linear-gradient(90deg,var(--cta),color-mix(in srgb,var(--cta) 70%,transparent));transform-origin:left;transition:width .6s var(--ease);width:{Math.round((provider.requestCount / maxRequests) * 100)}%"></div>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- Latency trend -->
		<div class="card rise" style="--d:320ms">
			<div class="card-head">
				<div>
					<h2><Activity stroke-width={1.5} />延迟趋势 (ms)</h2>
					<div class="sub">真实 duration_ms 样本</div>
				</div>
				<span style="font-size:12px;color:var(--muted)">平均 {formatLatency(routeStats?.overview.averageLatencyMs ?? null)}</span>
			</div>
			<div style="padding:18px 20px">
				{#if !routeStats || chartProviders.length === 0 || chartPoints.length === 0}
					<div class="empty" style="padding:30px">暂无数据</div>
				{:else}
					<div style="overflow-x:auto">
						<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:180px;min-width:520px;border-radius:10px;background:var(--surface-2)">
							{#each [0.25, 0.5, 0.75] as t}
								<line x1="0" y1={t * 100} x2="100" y2={t * 100} stroke="var(--b-def)" vector-effect="non-scaling-stroke" />
							{/each}
							{#each chartProviders as provider, providerIndex}
								{#each lineSegments(provider.id) as segment}
									<polyline points={segment} fill="none" stroke={CHART_COLORS[providerIndex % CHART_COLORS.length]} stroke-width="0.9" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
								{/each}
								{#each pointValues(provider.id) as point}
									<circle cx={point.x} cy={point.y} r="1.1" fill={CHART_COLORS[providerIndex % CHART_COLORS.length]} />
								{/each}
							{/each}
						</svg>
					</div>
					<div class="legend" id="latLegend">
						{#each chartProviders as provider, providerIndex}
							<span><span class="sw" style="background:{CHART_COLORS[providerIndex % CHART_COLORS.length]}"></span>{provider.name}</span>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Search & filters -->
	<div class="row mb" style="flex-wrap:wrap">
		<div class="input-search" style="flex:1;min-width:200px">
			<Search stroke-width={1.8} />
			<input placeholder="搜索模型 ID / Provider 名称..." bind:value={query} />
		</div>
		<div class="row" style="flex-wrap:wrap">
			<div class="select-wrap" style="min-width:176px">
				<Network stroke-width={1.6} />
				<select class="select" style="border:none;background:none" value={statusFilter} onchange={(event) => (statusFilter = (event.target as HTMLSelectElement).value as StatusFilter)}>
					<option value="all">全部状态</option>
					<option value="healthy">Healthy</option>
					<option value="half-open">Half Open</option>
					<option value="open">Circuit Open</option>
					<option value="disabled">Disabled</option>
				</select>
			</div>
			<div class="select-wrap" style="min-width:176px">
				<Network stroke-width={1.6} />
				<select class="select" style="border:none;background:none" value={modeFilter} onchange={(event) => (modeFilter = (event.target as HTMLSelectElement).value as ModeFilter)}>
					<option value="all">全部路由模式</option>
					<option value="priority">Priority</option>
					<option value="failover">Failover</option>
					<option value="weighted">Weighted</option>
				</select>
			</div>
			<button class="btn btn-ghost btn-sm" onclick={() => { query = ""; statusFilter = "all"; modeFilter = "all"; }}>清除</button>
		</div>
	</div>

	<!-- Route tree -->
	<div class="card rise" style="--d:360ms">
		<div class="card-head">
			<div>
				<h2><ListTree stroke-width={1.5} />模型路由关系</h2>
				<div class="sub">点击展开每个模型的 Provider 参与链</div>
			</div>
			<div class="row">
				<button class="btn btn-ghost btn-sm" onclick={handleExpandAll}>展开全部</button>
				<button class="btn btn-ghost btn-sm" onclick={handleCollapseAll}>收起全部</button>
			</div>
		</div>
		<div style="padding:6px 0">
			{#if models.length === 0}
				<div class="empty" style="padding:30px">暂无模型路由数据 — 请先到 API 设置页面添加并启用 Provider</div>
			{:else if filtered.length === 0}
				<div class="empty" style="padding:30px">没有符合当前筛选条件的模型</div>
			{:else}
				{#each filtered as model (model.id)}
					{@const stats = modelStats(model)}
					{@const modelExpanded = expanded.models.has(model.id)}
					{@const isFailoverChain = model.routingMode === "failover" && model.failoverEnabled}
					<div class="tree-model {modelExpanded ? 'open' : ''}">
						<button type="button" class="tree-row" aria-expanded={modelExpanded} onclick={() => toggleModel(model.id)}>
							{#if modelExpanded}
								<ChevronDown class="chev" stroke-width={2} />
							{:else}
								<ChevronRight class="chev" stroke-width={2} />
							{/if}
							<span class="mono" style="font-weight:600;color:var(--fg)">{model.id}</span>
							<span class="chip {MODE_TAG[model.routingMode]}" style="margin-left:8px">{MODE_LABELS[model.routingMode]}</span>
							<span class="tag tag-muted" style="margin-left:auto">{stats.total} upstream{stats.total === 1 ? "" : "s"}</span>
						</button>
						{#if modelExpanded}
							<div class="tree-depth">
								{#each model.providers as p, index (p.id)}
									{@const health = providerHealth(p)}
									{@const providerExpanded = expanded.providers.has(providerKey(model.id, p.id))}
									<button type="button" class="tree-row" style="padding-left:22px" aria-expanded={providerExpanded} onclick={() => toggleProvider(model.id, p.id)}>
										<span class="mono" style="font-size:11px;color:var(--muted);width:18px;text-align:center">{index === 0 ? "P" : index + 1}</span>
										<span style="width:8px;height:8px;border-radius:50%;background:{HEALTH_DOT[health]};box-shadow:0 0 8px {HEALTH_DOT[health]}"></span>
										<span style="color:var(--fg-2);font-size:13px">{p.name}</span>
										<span class="tag {TYPE_TAG[p.type]}">{typeLabel(p.type)}</span>
										<span class="tag tag-muted">{MATCHED_BY_LABELS[p.matchedBy]}</span>
										<span class="mono" style="margin-left:auto;font-size:11px;color:{HEALTH_COLOR[health]}">{HEALTH_LABELS[health]}</span>
									</button>
									{#if providerExpanded}
										<div style="margin-left:45px;margin-bottom:10px;margin-top:6px;padding:14px 16px;border-radius:12px;background:var(--surface-3);border:1px solid var(--b-sub)">
											<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 24px;font-size:12px">
												<div><div style="color:var(--muted);margin-bottom:2px">Provider</div><div style="color:var(--primary);font-weight:500;word-break:break-all">{p.name}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">ID</div><div style="color:var(--fg-2);font-family:var(--font-mono);word-break:break-all">{p.id}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Type</div><div style="color:var(--fg-2);font-family:var(--font-mono);text-transform:uppercase">{p.type}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Weight</div><div style="color:var(--fg-2);font-family:var(--font-mono)">{p.weight}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Enabled</div><div style="color:{p.enabled ? "var(--success)" : "var(--muted)"}">{p.enabled ? "是" : "否"}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Matched Model</div><div style="color:var(--fg-2);font-family:var(--font-mono);word-break:break-all">{p.matchedModel}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Matched By</div><div style="color:var(--fg-2)">{MATCHED_BY_LABELS[p.matchedBy]}{#if p.matchedPattern}<span style="color:var(--muted);font-family:var(--font-mono)">（{p.matchedPattern}）</span>{/if}</div></div>
												<div><div style="color:var(--muted);margin-bottom:2px">Circuit</div><div style="color:{HEALTH_COLOR[health]}">{HEALTH_LABELS[health]}</div></div>
											</div>
										</div>
									{/if}
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}
