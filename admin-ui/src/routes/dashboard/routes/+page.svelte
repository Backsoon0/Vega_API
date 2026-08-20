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
	import Alert from "$lib/Alert.svelte";
	import Spinner from "$lib/Spinner.svelte";
	import {
		Network,
		RefreshCw,
		Search,
		ChevronDown,
		ChevronRight,
		Maximize2,
		Minimize2,
		ListTree,
		BarChart3,
		Activity,
		Clock3,
	} from "lucide-svelte";

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
	const showCount = $derived(filtered.length);
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

	const TYPE_BADGES: Record<string, string> = {
		openai: "text-openai bg-openai-subtle",
		vertex_ai: "text-vertex bg-vertex-subtle",
		google_ai_studio: "text-studio bg-studio-subtle",
		anthropic: "text-anthropic bg-anthropic-subtle",
	};
	const HEALTH_DOTS: Record<string, string> = {
		healthy: "bg-accent",
		"half-open": "bg-warning",
		open: "bg-danger",
		disabled: "bg-muted",
	};
	const HEALTH_TEXT: Record<string, string> = {
		healthy: "text-accent",
		"half-open": "text-warning",
		open: "text-danger",
		disabled: "text-muted",
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

<div class="max-w-6xl mx-auto">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between flex-wrap gap-4">
		<div>
			<h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
				<Network class="w-5 h-5" stroke-width={1.5} />
				路由拓扑
			</h1>
			<p class="text-xs text-muted mt-1">模型路由关系与实时 Provider 统计概览</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<button class="px-2.5 sm:px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={handleExpandAll} disabled={loading} title="展开全部" aria-label="展开全部">
				<Maximize2 class="w-4 h-4 shrink-0" /><span class="hidden sm:inline">展开全部</span>
			</button>
			<button class="px-2.5 sm:px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={handleCollapseAll} disabled={loading} title="收起全部" aria-label="收起全部">
				<Minimize2 class="w-4 h-4 shrink-0" /><span class="hidden sm:inline">收起全部</span>
			</button>
			<button class="px-2.5 sm:px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={loadAll} disabled={loading || statsLoading} title="刷新" aria-label="刷新">
				<RefreshCw class={`w-4 h-4 shrink-0 ${loading || statsLoading ? "animate-spin" : ""}`} /><span class="hidden sm:inline">刷新</span>
			</button>
		</div>
	</div>

	<!-- Overview: state cards + request/latency charts are intentionally one section -->
	<section class="bg-surface rounded-2xl border border-white/[0.06] shadow-card overflow-hidden mb-6">
		<div class="px-5 pt-5 pb-4 flex items-center justify-between gap-4 flex-wrap">
			<div>
				<div class="text-sm font-semibold text-primary">Overview</div>
				<div class="text-[11px] text-muted mt-1">当前路由状态 + 所选时间窗口的真实请求统计</div>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<span class={`px-2 py-1 rounded-md text-[11px] font-mono ${failoverEnabledGlobal ? "bg-accent-subtle text-accent" : "bg-white/[0.04] text-muted"}`}>
					Failover {failoverEnabledGlobal ? "Enabled" : "Disabled"}
				</span>
				<select
					class="px-3 py-2 bg-input border border-white/[0.06] rounded-lg text-xs text-secondary"
					value={periodHours}
					onchange={(event) => (periodHours = Number((event.target as HTMLSelectElement).value))}
				>
					<option value={6}>最近 6 小时</option>
					<option value={24}>最近 24 小时</option>
					<option value={72}>最近 3 天</option>
					<option value={168}>最近 7 天</option>
				</select>
			</div>
		</div>

		<div class="px-5 pb-5">
			<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
				<div class="rounded-xl bg-background/60 border border-white/[0.05] p-4">
					<div class="flex items-center justify-between"><span class="text-xs text-muted">Models</span><Network class="w-4 h-4 text-muted" /></div>
					<div class="mt-2 text-xl font-bold font-mono text-primary">{routeStats?.overview.models ?? models.length}</div>
				</div>
				<div class="rounded-xl bg-background/60 border border-white/[0.05] p-4">
					<div class="flex items-center justify-between"><span class="text-xs text-muted">Upstreams</span><ListTree class="w-4 h-4 text-muted" /></div>
					<div class="mt-2 text-xl font-bold font-mono text-primary">{routeStats?.overview.upstreams ?? "—"}</div>
				</div>
				<div class="rounded-xl bg-background/60 border border-white/[0.05] p-4">
					<div class="flex items-center justify-between"><span class="text-xs text-muted">Healthy</span><Activity class="w-4 h-4 text-muted" /></div>
					<div class="mt-2 text-xl font-bold font-mono text-primary">{routeStats ? routeStats.overview.healthyUpstreams : "—"}</div>
				</div>
				<div class="rounded-xl bg-background/60 border border-white/[0.05] p-4">
					<div class="flex items-center justify-between"><span class="text-xs text-muted">Requests</span><BarChart3 class="w-4 h-4 text-muted" /></div>
					<div class="mt-2 text-xl font-bold font-mono text-primary">{routeStats ? routeStats.overview.trackedRequests : "—"}</div>
					<div class="text-[10px] text-muted mt-1">最近 {periodHours}h</div>
				</div>
				<div class="rounded-xl bg-background/60 border border-white/[0.05] p-4">
					<div class="flex items-center justify-between"><span class="text-xs text-muted">Average Latency</span><Clock3 class="w-4 h-4 text-muted" /></div>
					<div class="mt-2 text-xl font-bold font-mono text-primary">{formatLatency(routeStats?.overview.averageLatencyMs ?? null)}</div>
					<div class="text-[10px] text-muted mt-1">真实有效 duration_ms</div>
				</div>
			</div>

			<div class="grid lg:grid-cols-2 gap-4 mt-4">
				<!-- Provider request volume -->
				<div class="rounded-xl bg-background/40 border border-white/[0.05] p-4 min-h-[300px]">
					<div class="mb-4">
						<h2 class="text-sm font-semibold text-primary flex items-center gap-2"><BarChart3 class="w-4 h-4" />Provider 请求量</h2>
						<p class="text-[11px] text-muted mt-1">直接按 <span class="font-mono">call_logs.provider_id</span> 聚合</p>
					</div>
					{#if statsLoading && !routeStats}
						<div class="h-52 flex items-center justify-center"><Spinner /></div>
					{:else if statsError && !routeStats}
						<Alert type="error">{statsError}</Alert>
					{:else if barProviders.length === 0}
						<div class="h-52 flex items-center justify-center text-sm text-muted">暂无数据</div>
					{:else}
						<div class="space-y-3">
							{#each barProviders as provider}
								<div class="flex flex-col gap-1.5 sm:grid sm:grid-cols-[minmax(96px,160px)_1fr_auto] sm:items-center sm:gap-3 text-xs">
									<div class="flex items-center justify-between gap-2 sm:contents">
										<div class="truncate text-secondary" title={provider.name}>{provider.name}</div>
										<span class="sm:hidden font-mono text-primary shrink-0">{provider.requestCount}</span>
									</div>
									<div class="h-7 bg-surface rounded-md overflow-hidden">
										<div class="h-full rounded-md bg-cta/80 transition-all duration-500" style={`width:${(provider.requestCount / maxRequests) * 100}%`}></div>
									</div>
									<span class="hidden sm:inline font-mono text-primary min-w-12 text-right">{provider.requestCount}</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Provider latency trend -->
				<div class="rounded-xl bg-background/40 border border-white/[0.05] p-4 min-h-[300px]">
					<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
						<div>
							<h2 class="text-sm font-semibold text-primary flex items-center gap-2"><Activity class="w-4 h-4" />延迟趋势</h2>
							<p class="text-[11px] text-muted mt-1">仅显示能直接关联 Provider 且 <span class="font-mono">duration_ms &gt; 0</span> 的样本</p>
						</div>
						<span class="text-xs text-muted whitespace-nowrap">平均 {formatLatency(routeStats?.overview.averageLatencyMs ?? null)}</span>
					</div>
					{#if statsLoading && !routeStats}
						<div class="h-52 flex items-center justify-center"><Spinner /></div>
					{:else if !routeStats || chartProviders.length === 0 || chartPoints.length === 0}
						<div class="h-52 flex items-center justify-center text-sm text-muted">暂无数据</div>
					{:else}
						<div class="overflow-x-auto">
							<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-64 sm:h-56 lg:h-52 min-w-0 sm:min-w-[520px] rounded-lg bg-surface/70">
								<line x1="0" y1="25" x2="100" y2="25" stroke="currentColor" class="text-white/[0.06]" vector-effect="non-scaling-stroke" />
								<line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" class="text-white/[0.06]" vector-effect="non-scaling-stroke" />
								<line x1="0" y1="75" x2="100" y2="75" stroke="currentColor" class="text-white/[0.06]" vector-effect="non-scaling-stroke" />
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
						<div class="flex flex-wrap gap-x-5 gap-y-2 mt-3 text-[11px]">
							{#each chartProviders as provider, providerIndex}
								<span class="flex items-center gap-1.5 text-secondary">
									<span class="w-2 h-2 rounded-full" style={`background:${CHART_COLORS[providerIndex % CHART_COLORS.length]}`}></span>
									{provider.name}
								</span>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	</section>

	<!-- Search & filters remain below the overview -->
	<div class="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-3">
		<div class="flex-1 flex items-center gap-2 bg-input border border-white/[0.06] rounded-xl px-3 focus-within:ring-2 focus-within:ring-cta/50 transition-all">
			<Search class="w-4 h-4 shrink-0 text-muted" stroke-width={1.5} />
			<input type="text" placeholder="搜索模型 ID / Provider 名称..." class="flex-1 py-2.5 bg-transparent text-sm text-primary placeholder:text-placeholder focus:outline-none" bind:value={query} />
		</div>
		<div class="flex flex-wrap gap-2">
			<select class="flex-1 min-w-28 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary" value={statusFilter} onchange={(event) => (statusFilter = (event.target as HTMLSelectElement).value as StatusFilter)}>
				<option value="all">全部状态</option>
				<option value="healthy">Healthy</option>
				<option value="half-open">Half Open</option>
				<option value="open">Circuit Open</option>
				<option value="disabled">Disabled</option>
			</select>
			<select class="flex-1 min-w-28 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary" value={modeFilter} onchange={(event) => (modeFilter = (event.target as HTMLSelectElement).value as ModeFilter)}>
				<option value="all">全部路由模式</option>
				<option value="priority">Priority</option>
				<option value="failover">Failover</option>
				<option value="weighted">Weighted</option>
			</select>
			<button class="w-full sm:w-auto px-3 py-2.5 rounded-xl text-sm text-muted hover:text-secondary transition-all border border-white/[0.06]" onclick={() => { query = ""; statusFilter = "all"; modeFilter = "all"; }} title="清除筛选">清除</button>
		</div>
	</div>

	{#if loading && models.length === 0}
		<div class="flex items-center justify-center min-h-[40vh]">
			<div class="flex flex-col items-center gap-4"><Spinner class="text-cta" /><span class="text-sm text-muted font-mono">加载路由拓扑...</span></div>
		</div>
	{:else if error && models.length === 0}
		<div class="max-w-xl mx-auto"><Alert type="error"><span class="flex items-center justify-between gap-3"><span>{error}</span><button class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cta hover:bg-cta-hover text-white transition-all shrink-0" onclick={loadRoutes}>重试</button></span></Alert></div>
	{:else if models.length === 0}
		<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">暂无模型路由数据 — 请先到 <span class="text-cta">API 设置</span> 页面添加并启用 Provider</div>
	{:else if filtered.length === 0}
		<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">没有符合当前筛选条件的模型</div>
	{:else}
		<!-- Tree topology -->
		<div class="space-y-2">
			{#each filtered as model (model.id)}
				{@const stats = modelStats(model)}
				{@const modelExpanded = expanded.models.has(model.id)}
				{@const groupExpanded = expanded.groups.has(groupKey(model.id))}
				{@const isFailoverChain = model.routingMode === "failover" && model.failoverEnabled}
				<div class="bg-surface rounded-xl shadow-card border border-white/[0.05] overflow-hidden">
					<button class="w-full flex items-center gap-2 sm:gap-2.5 px-3.5 sm:px-4 py-3 hover:bg-surface-hover transition-colors text-left" onclick={() => toggleModel(model.id)} aria-expanded={modelExpanded}>
						{#if modelExpanded}<ChevronDown class="w-4 h-4 shrink-0 text-cta" stroke-width={2} />{:else}<ChevronRight class="w-4 h-4 shrink-0 text-muted" stroke-width={2} />{/if}
						<span class="flex-1 min-w-0 font-mono text-sm text-primary truncate">{model.id}</span>
						{#if stats.open > 0}<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-danger-subtle text-danger font-mono">✕ {stats.open} 熔断</span>{:else if stats.halfOpen > 0}<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-warning-subtle text-warning font-mono">⚠ {stats.halfOpen} Half Open</span>{/if}
						{#if stats.available === 0}<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-danger-subtle text-danger font-mono">无可用 Provider</span>{/if}
						<span class="ml-auto flex items-center gap-2 shrink-0 text-xs">
							<span class="hidden sm:inline px-2 py-0.5 rounded-md bg-white/[0.04] text-muted font-mono">{stats.total} upstream{stats.total === 1 ? "" : "s"}</span>
							<span class={`px-2 py-0.5 rounded-md font-mono ${model.routingMode === "failover" ? "bg-cta-subtle text-cta" : "bg-white/[0.04] text-secondary"}`}>
								{MODE_LABELS[model.routingMode]}{#if model.routingMode === "priority" && !model.failoverEnabled}<span class="hidden sm:inline"> · Failover Disabled</span>{/if}
							</span>
							<span class="hidden sm:inline text-muted"><span class="text-accent">{stats.available}</span> 可用</span>
						</span>
					</button>

					{#if modelExpanded}
						<div class="border-t border-white/[0.06]">
							<div class="flex flex-wrap items-center gap-2 px-4 pt-2">
								<button class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold text-secondary hover:bg-surface-hover transition-colors" onclick={() => toggleGroup(model.id)} aria-expanded={groupExpanded}>
									{#if groupExpanded}<ChevronDown class="w-3.5 h-3.5 text-cta" stroke-width={2} />{:else}<ChevronRight class="w-3.5 h-3.5 text-muted" stroke-width={2} />{/if}
									<ListTree class="w-3.5 h-3.5" stroke-width={1.5} />{MODE_LABELS[model.routingMode]}
								</button>
								<span class={`px-2 py-0.5 rounded-md text-[10px] font-mono ${model.failoverEnabled ? "bg-accent-subtle text-accent" : "bg-white/[0.04] text-muted"}`}>Failover {model.failoverEnabled ? "Enabled" : "Disabled"}</span>
								{#if model.routingMode === "weighted"}<span class="hidden sm:inline text-[10px] text-muted font-mono">（真实加权负载均衡尚未启用 — 当前权重仅决定候选顺序）</span>{/if}
							</div>

							{#if groupExpanded}
								<div class="px-4 pb-3 pt-1">
									{#if model.providers.length === 0}
										<p class="text-xs text-muted py-3 pl-2">无匹配 Provider</p>
									{:else}
										{#each model.providers as provider, index (provider.id)}
											{@const health = providerHealth(provider)}
											{@const providerExpanded = expanded.providers.has(providerKey(model.id, provider.id))}
											{#if isFailoverChain && index > 0}
												<div class="flex items-center gap-2 py-1 pl-3 text-[10px] text-muted font-mono"><span class="w-px h-3 bg-white/[0.12]"></span>↓ Failover {index}</div>
											{/if}
											<button class="w-full flex items-center gap-2 sm:gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-left" onclick={() => toggleProvider(model.id, provider.id)} aria-expanded={providerExpanded}>
												<span class={`shrink-0 flex items-center justify-center w-5 h-5 rounded-md text-[9px] font-bold font-mono ${index === 0 ? "bg-cta-subtle text-cta" : isFailoverChain ? "bg-white/[0.05] text-muted" : "bg-white/[0.05] text-placeholder"}`}>
													{index === 0 ? "P" : isFailoverChain ? index : "–"}
												</span>
												<span class={`w-2 h-2 rounded-full shrink-0 ${HEALTH_DOTS[health]}`}></span>
												<span class="min-w-0 flex-1 text-sm text-primary truncate">{provider.name}</span>
												<span class="font-mono text-[10px] text-muted truncate hidden md:inline">{provider.id}</span>
												<span class={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGES[provider.type] || "bg-white/[0.05] text-muted"}`}>{typeLabel(provider.type)}</span>
												<span class="hidden sm:inline shrink-0 text-[10px] text-muted font-mono">w{provider.weight}</span>
												<span class="hidden sm:inline shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-white/[0.04] text-secondary">{MATCHED_BY_LABELS[provider.matchedBy]}</span>
												<span class={`ml-auto shrink-0 flex items-center gap-1 text-[11px] font-medium ${HEALTH_TEXT[health]}`}>{HEALTH_LABELS[health]}{#if providerExpanded}<ChevronDown class="w-3.5 h-3.5" stroke-width={2} />{:else}<ChevronRight class="w-3.5 h-3.5" stroke-width={2} />{/if}</span>
											</button>

											{#if providerExpanded}
												<div class="ml-9 mb-2 mt-1 rounded-lg bg-background/60 border border-white/[0.06] p-4">
													<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-xs">
														<div><div class="text-muted mb-0.5">Provider</div><div class="text-primary font-medium break-all">{provider.name}</div></div>
														<div><div class="text-muted mb-0.5">ID</div><div class="text-secondary font-mono break-all">{provider.id}</div></div>
														<div><div class="text-muted mb-0.5">Type</div><div class="text-secondary font-mono uppercase">{provider.type}</div></div>
														<div><div class="text-muted mb-0.5">Weight</div><div class="text-secondary font-mono">{provider.weight}</div></div>
														<div><div class="text-muted mb-0.5">Enabled</div><div class={provider.enabled ? "text-accent" : "text-muted"}>{provider.enabled ? "是" : "否"}</div></div>
														<div><div class="text-muted mb-0.5">Matched Model</div><div class="text-secondary font-mono break-all">{provider.matchedModel}</div></div>
														<div><div class="text-muted mb-0.5">Matched By</div><div class="text-secondary">{MATCHED_BY_LABELS[provider.matchedBy]}{#if provider.matchedPattern}<span class="text-muted font-mono">（{provider.matchedPattern}）</span>{/if}</div></div>
														<div><div class="text-muted mb-0.5">Circuit State</div><div class={HEALTH_TEXT[health]}>{HEALTH_LABELS[health]}</div></div>
														<div><div class="text-muted mb-0.5">模型显式配置</div><div class="text-secondary">{provider.modelConfigured ? "是" : "否"}</div></div>
														<div><div class="text-muted mb-0.5">路由参与</div><div class={provider.enabled ? "text-accent" : "text-muted"}>{provider.enabled ? "参与请求路由" : "已禁用，不会参与路由"}</div></div>
													</div>
													{#if !provider.enabled || health === "open" || health === "half-open"}
														<div class="mt-3 text-[11px] border-t border-white/[0.06] pt-2">
															{#if !provider.enabled}<span class="text-muted">※ 已禁用 Provider 仅作展示，真实请求不会路由到它。</span>{:else if health === "open"}<span class="text-warning">※ 熔断已打开，请求会跳过该 Provider（冷却后自动探测恢复）。</span>{:else}<span class="text-warning">※ 熔断半开，正在试探恢复。</span>{/if}
														</div>
													{/if}
												</div>
											{/if}
										{/each}
								{/if}
							</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
