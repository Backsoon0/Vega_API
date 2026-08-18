<script lang="ts">
	import { getRoutes } from "$lib/api";
	import type { RouteTopologyModel, RouteTopologyProvider } from "$lib/api";
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
	import {
		getRouteStats,
		formatLatency,
		type RouteStatsResponse,
	} from "$lib/route-stats";
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

	let query = $state("");
	let statusFilter = $state<StatusFilter>("all");
	let modeFilter = $state<ModeFilter>("all");
	let expanded = $state<TreeState>(emptyTreeState());

	function groupKey(modelId: string) { return `route:${modelId}`; }
	function providerKey(modelId: string, providerId: string) { return `${modelId}::${providerId}`; }
	function toggleModel(id: string) { expanded = { ...expanded, models: toggleSetKey(expanded.models, id) }; }
	function toggleGroup(id: string) { expanded = { ...expanded, groups: toggleSetKey(expanded.groups, groupKey(id)) }; }
	function toggleProvider(m: string, p: string) { expanded = { ...expanded, providers: toggleSetKey(expanded.providers, providerKey(m, p)) }; }
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
			lastRefreshed = generatedAt ? new Date(generatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : new Date().toLocaleTimeString("zh-CN", { hour12: false });
		} catch (err: any) {
			error = err?.message || "加载路由拓扑失败";
		} finally { loading = false; }
	}

	async function loadStats() {
		statsLoading = true;
		statsError = "";
		try {
			routeStats = await getRouteStats(periodHours);
		} catch (err: any) {
			statsError = err?.message || "加载路由统计失败";
		}
		finally { statsLoading = false; }
	}

	async function loadAll() {
		await Promise.all([loadRoutes(), loadStats()]);
	}

	$effect(() => { loadAll(); });
	$effect(() => { if (periodHours) loadStats(); });

	const filtered = $derived(filterModels(models, { query, status: statusFilter, mode: modeFilter }));
	const showCount = $derived(filtered.length);
	const barProviders = $derived((routeStats?.providers || []).filter((p) => p.requestCount >= 0).sort((a, b) => b.requestCount - a.requestCount).slice(0, 10));
	const maxRequests = $derived(Math.max(1, ...barProviders.map((p) => p.requestCount)));
	const chartProviders = $derived((routeStats?.providers || []).filter((p) => p.averageLatencyMs != null).sort((a, b) => b.requestCount - a.requestCount).slice(0, 6));
	const chartPoints = $derived(routeStats?.latency.points || []);
	const maxLatency = $derived(Math.max(1, ...chartPoints.flatMap((point) => Object.values(point.providers).filter((v): v is number => v != null && Number.isFinite(v)))));

	function xFor(index: number) { return chartPoints.length <= 1 ? 50 : (index / (chartPoints.length - 1)) * 100; }
	function yFor(value: number) { return 100 - (value / maxLatency) * 82 - 8; }
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
	function typeLabel(type: string) { return type === "vertex_ai" ? "Vertex" : type === "google_ai_studio" ? "Studio" : type === "anthropic" ? "Anthropic" : "OpenAI"; }
	const TYPE_BADGES: Record<string, string> = { openai: "text-openai bg-openai-subtle", vertex_ai: "text-vertex bg-vertex-subtle", google_ai_studio: "text-studio bg-studio-subtle", anthropic: "text-anthropic bg-anthropic-subtle" };
	const HEALTH_DOTS: Record<string, string> = { healthy: "bg-accent", "half-open": "bg-warning", open: "bg-danger", disabled: "bg-muted" };
	const HEALTH_TEXT: Record<string, string> = { healthy: "text-accent", "half-open": "text-warning", open: "text-danger", disabled: "text-muted" };
	const CHART_COLORS = ["var(--color-cta)", "var(--color-accent)", "var(--color-warning)", "var(--color-danger)", "#a78bfa", "#38bdf8"];
</script>

<svelte:head><title>路由拓扑 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
	<div class="mb-6 flex items-center justify-between flex-wrap gap-4">
		<div>
			<h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2"><Network class="w-5 h-5" stroke-width={1.5} />路由拓扑</h1>
			<p class="text-xs text-muted mt-1">模型路由关系与真实 Provider 请求统计</p>
		</div>
		<div class="flex items-center gap-2">
			<button class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={handleExpandAll} disabled={loading}><Maximize2 class="w-4 h-4" />展开全部</button>
			<button class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={handleCollapseAll} disabled={loading}><Minimize2 class="w-4 h-4" />收起全部</button>
			<button class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]" onclick={loadAll} disabled={loading || statsLoading}><RefreshCw class={`w-4 h-4 ${loading || statsLoading ? "animate-spin" : ""}`} />刷新</button>
		</div>
	</div>

	<!-- Overview -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
		{#each [
			{ label: "Models", value: routeStats?.overview.models ?? models.length, icon: Network },
			{ label: "Upstreams", value: routeStats?.overview.upstreams ?? "—", icon: ListTree },
			{ label: "Healthy", value: routeStats ? routeStats.overview.healthyUpstreams : "—", icon: Activity },
			{ label: "Requests", value: routeStats ? routeStats.overview.trackedRequests : "—", icon: BarChart3 },
		] as card}
			<div class="bg-surface rounded-xl border border-white/[0.05] p-4 shadow-card">
				<div class="flex items-center justify-between"><span class="text-xs text-muted">{card.label}</span><svelte:component this={card.icon} class="w-4 h-4 text-muted" /></div>
				<div class="mt-2 text-xl font-bold font-mono text-primary">{card.value}</div>
			</div>
		{/each}
	</div>

	<div class="bg-surface rounded-xl border border-white/[0.05] p-4 mb-6 shadow-card">
		<div class="flex items-center justify-between mb-4 gap-3">
			<div><h2 class="text-sm font-semibold text-primary flex items-center gap-2"><BarChart3 class="w-4 h-4" />Provider 请求量</h2><p class="text-[11px] text-muted mt-1">直接按 call_logs.provider_id 聚合，未做模型推断</p></div>
			<select class="px-3 py-2 bg-input border border-white/[0.06] rounded-lg text-xs text-secondary" bind:value={periodHours}>
				<option value={6}>最近 6 小时</option><option value={24}>最近 24 小时</option><option value={72}>最近 3 天</option><option value={168}>最近 7 天</option>
			</select>
		</div>
		{#if statsLoading && !routeStats}
			<div class="h-48 flex items-center justify-center"><Spinner /></div>
		{:else if statsError && !routeStats}
			<Alert type="error">{statsError}</Alert>
		{:else if barProviders.length === 0}
			<div class="h-48 flex items-center justify-center text-sm text-muted">暂无数据</div>
		{:else}
			<div class="space-y-3">
				{#each barProviders as provider}
					<div class="grid grid-cols-[minmax(90px,180px)_1fr_auto] items-center gap-3 text-xs">
						<div class="truncate text-secondary" title={provider.name}>{provider.name}</div>
						<div class="h-7 bg-background rounded-md overflow-hidden"><div class="h-full rounded-md bg-cta/80 transition-all duration-500" style={`width:${(provider.requestCount / maxRequests) * 100}%`}></div></div>
						<div class="font-mono text-primary min-w-12 text-right">{provider.requestCount}</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<div class="bg-surface rounded-xl border border-white/[0.05] p-4 mb-6 shadow-card">
		<div class="flex items-center justify-between mb-4"><div><h2 class="text-sm font-semibold text-primary flex items-center gap-2"><Activity class="w-4 h-4" />延迟趋势</h2><p class="text-[11px] text-muted mt-1">仅使用 call_logs 中直接关联 Provider 且 duration_ms &gt; 0 的真实样本</p></div><span class="text-xs text-muted">平均延迟：{formatLatency(routeStats?.overview.averageLatencyMs ?? null)}</span></div>
		{#if statsLoading && !routeStats}
			<div class="h-64 flex items-center justify-center"><Spinner /></div>
		{:else if !routeStats || chartProviders.length === 0 || chartPoints.length === 0}
			<div class="h-64 flex items-center justify-center text-sm text-muted">暂无数据</div>
		{:else}
			<div class="overflow-x-auto">
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-64 min-w-[520px] rounded-lg bg-background/50">
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
					<span class="flex items-center gap-1.5 text-secondary"><span class="w-2 h-2 rounded-full" style={`background:${CHART_COLORS[providerIndex % CHART_COLORS.length]}`}></span>{provider.name}</span>
				{/each}
			</div>
		{/if}
	</div>

	<div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
		<span class="text-muted">共 <span class="text-secondary font-mono">{models.length}</span> 个模型{#if query || statusFilter !== 'all' || modeFilter !== 'all'} · 显示 <span class="text-secondary font-mono">{showCount}</span>{/if}</span>
		<span class={`px-2 py-0.5 rounded-md font-mono ${failoverEnabledGlobal ? "bg-accent-subtle text-accent" : "bg-white/[0.04] text-muted"}`}>Failover {failoverEnabledGlobal ? "Enabled" : "Disabled"}</span>
		{#if lastRefreshed}<span class="text-placeholder font-mono">更新于 {lastRefreshed}</span>{/if}
	</div>

	<div class="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-3">
		<div class="flex-1 flex items-center gap-2 bg-input border border-white/[0.06] rounded-xl px-3 focus-within:ring-2 focus-within:ring-cta/50 transition-all"><Search class="w-4 h-4 text-muted" /><input type="text" placeholder="搜索模型 ID / Provider 名称..." class="flex-1 py-2.5 bg-transparent text-sm text-primary placeholder:text-placeholder focus:outline-none" bind:value={query} /></div>
		<div class="flex gap-2">
			<select class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary" bind:value={statusFilter}><option value="all">全部状态</option><option value="healthy">Healthy</option><option value="half-open">Half Open</option><option value="open">Circuit Open</option><option value="disabled">Disabled</option></select>
			<select class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary" bind:value={modeFilter}><option value="all">全部路由模式</option><option value="priority">Priority</option><option value="failover">Failover</option><option value="weighted">Weighted</option></select>
			<button class="px-3 py-2.5 rounded-xl text-sm text-muted hover:text-secondary border border-white/[0.06]" onclick={() => { query = ""; statusFilter = "all"; modeFilter = "all"; }}>清除</button>
		</div>
	</div>

	{#if loading && models.length === 0}
		<div class="flex items-center justify-center min-h-[30vh]"><div class="flex flex-col items-center gap-4"><Spinner /><span class="text-sm text-muted">加载路由拓扑...</span></div></div>
	{:else if error && models.length === 0}
		<Alert type="error"><span class="flex items-center justify-between gap-3"><span>{error}</span><button class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cta text-white" onclick={loadRoutes}>重试</button></span></Alert>
	{:else if models.length === 0}
		<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">暂无模型路由数据 — 请先添加并启用 Provider</div>
	{:else if filtered.length === 0}
		<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">没有符合当前筛选条件的模型</div>
	{:else}
		<div class="space-y-2">
			{#each filtered as model (model.id)}
				{@const stats = modelStats(model)}
				{@const modelExpanded = expanded.models.has(model.id)}
				{@const groupExpanded = expanded.groups.has(groupKey(model.id))}
				{@const isFailoverChain = model.routingMode === 'failover' && model.failoverEnabled}
				<div class="bg-surface rounded-xl shadow-card border border-white/[0.05] overflow-hidden">
					<button class="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-surface-hover transition-colors text-left" onclick={() => toggleModel(model.id)} aria-expanded={modelExpanded}>
						{#if modelExpanded}<ChevronDown class="w-4 h-4 text-cta" />{:else}<ChevronRight class="w-4 h-4 text-muted" />{/if}
						<span class="font-mono text-sm text-primary truncate">{model.id}</span>
						{#if stats.open > 0}<span class="px-2 py-0.5 rounded-md text-[10px] bg-danger-subtle text-danger">✕ {stats.open} 熔断</span>{:else if stats.halfOpen > 0}<span class="px-2 py-0.5 rounded-md text-[10px] bg-warning-subtle text-warning">⚠ {stats.halfOpen} Half Open</span>{/if}
						<span class="ml-auto flex items-center gap-2 shrink-0 text-xs"><span class="px-2 py-0.5 rounded-md bg-white/[0.04] text-muted font-mono">{stats.total} upstream{stats.total === 1 ? '' : 's'}</span><span class="px-2 py-0.5 rounded-md bg-white/[0.04] text-secondary font-mono">{MODE_LABELS[model.routingMode]}</span><span class="hidden sm:inline text-muted"><span class="text-accent">{stats.available}</span> 可用</span></span>
					</button>
					{#if modelExpanded}
						<div class="border-t border-white/[0.06]">
							<div class="flex items-center gap-2 px-4 pt-2"><button class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold text-secondary hover:bg-surface-hover" onclick={() => toggleGroup(model.id)}>{#if groupExpanded}<ChevronDown class="w-3.5 h-3.5 text-cta" />{:else}<ChevronRight class="w-3.5 h-3.5 text-muted" />{/if}<ListTree class="w-3.5 h-3.5" />{MODE_LABELS[model.routingMode]}</button><span class="px-2 py-0.5 rounded-md text-[10px] font-mono bg-white/[0.04] text-muted">Failover {model.failoverEnabled ? 'Enabled' : 'Disabled'}</span>{#if model.routingMode === 'weighted'}<span class="text-[10px] text-muted">真实加权负载均衡尚未启用 — 当前权重仅决定候选顺序</span>{/if}</div>
							{#if groupExpanded}<div class="px-4 pb-3 pt-1">
								{#each model.providers as p, idx (p.id)}
									{@const health = providerHealth(p)}
									{@const pExpanded = expanded.providers.has(providerKey(model.id, p.id))}
									{#if isFailoverChain && idx > 0}<div class="pl-4 py-1 text-[10px] text-muted font-mono">│<br />↓ Failover {idx}</div>{/if}
									<button class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover text-left" onclick={() => toggleProvider(model.id, p.id)} aria-expanded={pExpanded}>
										<span class="shrink-0 flex items-center justify-center w-5 h-5 rounded-md text-[9px] font-bold bg-white/[0.05] text-muted">{idx === 0 ? 'P' : isFailoverChain ? idx : '–'}</span><span class={`w-2 h-2 rounded-full shrink-0 ${HEALTH_DOTS[health]}`}></span><span class="text-sm text-primary truncate">{p.name}</span><span class="font-mono text-[10px] text-muted truncate hidden md:inline">{p.id}</span><span class={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGES[p.type] || 'bg-white/[0.05] text-muted'}`}>{typeLabel(p.type)}</span><span class="text-[10px] text-muted font-mono">w{p.weight}</span><span class="px-1.5 py-0.5 rounded text-[10px] bg-white/[0.04] text-secondary">{MATCHED_BY_LABELS[p.matchedBy]}</span><span class={`ml-auto text-[11px] font-medium ${HEALTH_TEXT[health]}`}>{HEALTH_LABELS[health]} {pExpanded ? '⌄' : '›'}</span>
									</button>
									{#if pExpanded}<div class="ml-9 mb-2 mt-1 rounded-lg bg-background/60 border border-white/[0.06] p-4"><div class="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs"><div><div class="text-muted">Provider</div><div class="text-primary break-all">{p.name}</div></div><div><div class="text-muted">ID</div><div class="text-secondary font-mono break-all">{p.id}</div></div><div><div class="text-muted">Type</div><div class="text-secondary font-mono">{p.type}</div></div><div><div class="text-muted">Weight</div><div class="text-secondary font-mono">{p.weight}</div></div><div><div class="text-muted">Enabled</div><div class={p.enabled ? 'text-accent' : 'text-muted'}>{p.enabled ? '是' : '否'}</div></div><div><div class="text-muted">Matched Model</div><div class="text-secondary font-mono break-all">{p.matchedModel}</div></div><div><div class="text-muted">Matched By</div><div class="text-secondary">{MATCHED_BY_LABELS[p.matchedBy]}{#if p.matchedPattern}<span class="text-muted font-mono">（{p.matchedPattern}）</span>{/if}</div></div><div><div class="text-muted">Circuit State</div><div class={HEALTH_TEXT[health]}>{HEALTH_LABELS[health]}</div></div></div></div>{/if}
								{/each}
							</div>{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
