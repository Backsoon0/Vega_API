<script lang="ts">
	import { getRoutes } from "$lib/api";
	import type {
		RouteTopologyModel,
		RouteTopologyProvider,
	} from "$lib/api";
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
	} from "lucide-svelte";

	// ---- Data ----
	let models = $state<RouteTopologyModel[]>([]);
	let failoverEnabledGlobal = $state(true);
	let generatedAt = $state("");
	let loading = $state(true);
	let error = $state("");
	let lastRefreshed = $state("");

	// ---- Filters ----
	let query = $state("");
	let statusFilter = $state<StatusFilter>("all");
	let modeFilter = $state<ModeFilter>("all");

	// ---- Tree expansion (stable Sets — toggling one node touches only it) ----
	let expanded = $state<TreeState>(emptyTreeState());

	// Group key (per model, single route group for now)
	function groupKey(modelId: string) {
		return `route:${modelId}`;
	}
	// Provider key
	function providerKey(modelId: string, providerId: string) {
		return `${modelId}::${providerId}`;
	}

	function toggleModel(id: string) {
		expanded = { ...expanded, models: toggleSetKey(expanded.models, id) };
	}
	function toggleGroup(id: string) {
		expanded = { ...expanded, groups: toggleSetKey(expanded.groups, groupKey(id)) };
	}
	function toggleProvider(m: string, p: string) {
		expanded = { ...expanded, providers: toggleSetKey(expanded.providers, providerKey(m, p)) };
	}
	function handleExpandAll() {
		expanded = expandAll(filtered);
	}
	function handleCollapseAll() {
		expanded = collapseAll();
	}

	// ---- Load / refresh ----
	async function load() {
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
	$effect(() => {
		load();
	});

	const filtered = $derived(
		filterModels(models, { query, status: statusFilter, mode: modeFilter }),
	);
	const showCount = $derived(filtered.length);

	// ---- Rendering helpers ----
	const TYPE_BADGES: Record<string, string> = {
		openai: "text-openai bg-openai-subtle",
		vertex_ai: "text-vertex bg-vertex-subtle",
		google_ai_studio: "text-studio bg-studio-subtle",
		anthropic: "text-anthropic bg-anthropic-subtle",
	};
	const HEALTH_DOTS: Record<string, string> = {
		healthy: "bg-accent shadow-[0_0_8px_var(--color-accent-glow)]",
		"half-open": "bg-warning",
		open: "bg-danger shadow-[0_0_8px_rgba(239,68,68,0.55)]",
		disabled: "bg-muted",
	};
	const HEALTH_TEXT: Record<string, string> = {
		healthy: "text-accent",
		"half-open": "text-warning",
		open: "text-danger",
		disabled: "text-muted",
	};

	function typeLabel(type: string): string {
		return type === "vertex_ai" ? "Vertex" : type === "google_ai_studio" ? "Studio" : type === "anthropic" ? "Anthropic" : "OpenAI";
	}
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
			<p class="text-xs text-muted mt-1">
				查看当前所有模型的实际 Provider 路由关系（数据由后端实时计算，与真实请求路径一致）
			</p>
		</div>
		<div class="flex items-center gap-2">
			<button
				class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06] disabled:opacity-50"
				onclick={handleExpandAll}
				disabled={loading}
			>
				<Maximize2 class="w-4 h-4" stroke-width={1.5} />
				展开全部
			</button>
			<button
				class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06] disabled:opacity-50"
				onclick={handleCollapseAll}
				disabled={loading}
			>
				<Minimize2 class="w-4 h-4" stroke-width={1.5} />
				收起全部
			</button>
			<button
				class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06] disabled:opacity-50"
				onclick={load}
				disabled={loading}
			>
				<RefreshCw class={`w-4 h-4 ${loading ? "animate-spin" : ""}`} stroke-width={1.5} />
				刷新
			</button>
		</div>
	</div>

	<!-- Global status line -->
	<div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
		<span class="text-muted">
			共 <span class="text-secondary font-mono">{models.length}</span> 个模型
			{#if query || statusFilter !== 'all' || modeFilter !== 'all'}
				· 显示 <span class="text-secondary font-mono">{showCount}</span>
			{/if}
		</span>
		<span
			class={`px-2 py-0.5 rounded-md font-mono ${failoverEnabledGlobal ? "bg-accent-subtle text-accent" : "bg-white/[0.04] text-muted"}`}
		>
			Failover {failoverEnabledGlobal ? "Enabled" : "Disabled"}
		</span>
		{#if lastRefreshed}
			<span class="text-placeholder font-mono">更新于 {lastRefreshed}</span>
		{/if}
	</div>

	<!-- Search & filter bar -->
	<div class="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-3">
		<div class="flex-1 flex items-center gap-2 bg-input border border-white/[0.06] rounded-xl px-3 focus-within:ring-2 focus-within:ring-cta/50 transition-all">
			<Search
				class="w-4 h-4 shrink-0 transition-opacity {query ? 'text-muted/30' : 'text-muted'}"
				stroke-width={1.5}
			/>
			<input
				type="text"
				placeholder="搜索模型 ID / Provider 名称..."
				class="flex-1 py-2.5 bg-transparent text-sm text-primary placeholder:text-placeholder focus:outline-none"
				bind:value={query}
			/>
		</div>
		<div class="flex gap-2">
			<select
				class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
				value={statusFilter}
				onchange={(e) => (statusFilter = (e.target as HTMLSelectElement).value as StatusFilter)}
			>
				<option value="all">全部状态</option>
				<option value="healthy">Healthy</option>
				<option value="half-open">Half Open</option>
				<option value="open">Circuit Open</option>
				<option value="disabled">Disabled</option>
			</select>
			<select
				class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
				value={modeFilter}
				onchange={(e) => (modeFilter = (e.target as HTMLSelectElement).value as ModeFilter)}
			>
				<option value="all">全部路由模式</option>
				<option value="priority">Priority</option>
				<option value="failover">Failover</option>
				<option value="weighted">Weighted</option>
			</select>
			<button
				class="px-3 py-2.5 rounded-xl text-sm text-muted hover:text-secondary transition-all border border-white/[0.06]"
				onclick={() => { query = ""; statusFilter = "all"; modeFilter = "all"; }}
				title="清除筛选"
			>
				清除
			</button>
		</div>
	</div>

	<!-- Loading -->
	{#if loading && models.length === 0}
		<div class="flex items-center justify-center min-h-[40vh]">
			<div class="flex flex-col items-center gap-4">
				<Spinner class="text-cta" />
				<span class="text-sm text-muted font-mono">加载路由拓扑...</span>
			</div>
		</div>
	{:else if error && models.length === 0}
		<div class="max-w-xl mx-auto">
			<Alert type="error">
				<span class="flex items-center justify-between gap-3">
					<span>{error}</span>
					<button
						class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cta hover:bg-cta-hover text-white transition-all shrink-0"
						onclick={load}
					>
						重试
					</button>
				</span>
			</Alert>
		</div>
	{:else}
		<!-- No data at all -->
		{#if models.length === 0}
			<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">
				暂无模型路由数据 — 请先到 <span class="text-cta">API 设置</span> 页面添加并启用 Provider
			</div>
		{:else if filtered.length === 0}
			<div class="bg-surface rounded-xl p-10 text-center text-sm text-muted border border-white/[0.06]">
				没有符合当前筛选条件的模型
			</div>
		{:else}
			<!-- Tree -->
			<div class="space-y-2">
				{#each filtered as model (model.id)}
					{@const stats = modelStats(model)}
					{@const modelExpanded = expanded.models.has(model.id)}
					{@const groupExpanded = expanded.groups.has(groupKey(model.id))}
					{@const isFailoverChain = model.routingMode === 'failover' && model.failoverEnabled}

					<div class="bg-surface rounded-xl shadow-card border border-white/[0.05] overflow-hidden">
						<!-- Model node -->
						<button
							class="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-surface-hover transition-colors text-left"
							onclick={() => toggleModel(model.id)}
							aria-expanded={modelExpanded}
						>
							{#if modelExpanded}
								<ChevronDown class="w-4 h-4 shrink-0 text-cta" stroke-width={2} />
							{:else}
								<ChevronRight class="w-4 h-4 shrink-0 text-muted" stroke-width={2} />
							{/if}
							<span class="font-mono text-sm text-primary truncate">{model.id}</span>

							{#if stats.open > 0}
								<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-danger-subtle text-danger font-mono">
									✕ {stats.open} 熔断
								</span>
							{:else if stats.halfOpen > 0}
								<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-warning-subtle text-warning font-mono">
									⚠ {stats.halfOpen} Half Open
								</span>
							{/if}
							{#if stats.available === 0}
								<span class="shrink-0 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-danger-subtle text-danger font-mono">
									无可用 Provider
								</span>
							{/if}

							<span class="ml-auto flex items-center gap-2 shrink-0 text-xs">
								<span class="px-2 py-0.5 rounded-md bg-white/[0.04] text-muted font-mono">
									{stats.total} upstream{stats.total === 1 ? '' : 's'}
								</span>
								<span
									class="px-2 py-0.5 rounded-md font-mono {model.routingMode === 'failover'
										? 'bg-cta-subtle text-cta'
										: 'bg-white/[0.04] text-secondary'}"
								>
									{MODE_LABELS[model.routingMode]}
									{#if model.routingMode === 'priority' && !model.failoverEnabled}
										· Failover Disabled
									{/if}
								</span>
								<span class="hidden sm:inline text-muted">
									<span class="text-accent">{stats.available}</span> 可用
								</span>
							</span>
						</button>

						<!-- Model body (rendered only when expanded — keeps DOM small) -->
						{#if modelExpanded}
							<div class="border-t border-white/[0.06]">
								<!-- Route group header -->
								<div class="flex items-center gap-2 px-4 pt-2">
									<button
										class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold text-secondary hover:bg-surface-hover transition-colors"
										onclick={() => toggleGroup(model.id)}
										aria-expanded={groupExpanded}
									>
										{#if groupExpanded}
											<ChevronDown class="w-3.5 h-3.5 text-cta" stroke-width={2} />
										{:else}
											<ChevronRight class="w-3.5 h-3.5 text-muted" stroke-width={2} />
										{/if}
										<ListTree class="w-3.5 h-3.5" stroke-width={1.5} />
										{MODE_LABELS[model.routingMode]}
									</button>
									<span
										class="px-2 py-0.5 rounded-md text-[10px] font-mono {model.failoverEnabled ? 'bg-accent-subtle text-accent' : 'bg-white/[0.04] text-muted'}"
									>
										Failover {model.failoverEnabled ? 'Enabled' : 'Disabled'}
									</span>
									{#if model.routingMode === 'weighted'}
										<span class="text-[10px] text-muted font-mono">
											（真实加权负载均衡尚未启用 — 当前权重仅决定候选顺序）
										</span>
									{/if}
								</div>

								{#if groupExpanded}
									<div class="px-4 pb-3 pt-1">
										{#if model.providers.length === 0}
											<p class="text-xs text-muted py-3 pl-2">无匹配 Provider</p>
										{:else}
											{#each model.providers as p, idx (p.id)}
												{@const health = providerHealth(p)}
												{@const pKey = providerKey(model.id, p.id)}
												{@const pExpanded = expanded.providers.has(pKey)}

												<!-- Failover chain connector -->
												{#if isFailoverChain && idx > 0}
													<div class="flex items-center gap-2 py-1 pl-3 text-[10px] text-muted font-mono">
														<span class="w-px h-3 bg-white/[0.12]"></span>
														↓ Failover {idx}
													</div>
												{/if}

												<!-- Provider node -->
												<button
													class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-left"
													onclick={() => toggleProvider(model.id, p.id)}
													aria-expanded={pExpanded}
												>
													<span
														class="shrink-0 flex items-center justify-center w-5 h-5 rounded-md text-[9px] font-bold font-mono {idx === 0 ? 'bg-cta-subtle text-cta' : isFailoverChain ? 'bg-white/[0.05] text-muted' : 'bg-white/[0.05] text-placeholder'}"
														title={idx === 0 ? 'Primary' : isFailoverChain ? `Failover ${idx}` : '备用（Failover 已禁用，不会使用）'}
													>
														{idx === 0 ? 'P' : isFailoverChain ? idx : '–'}
													</span>
													<span class="w-2 h-2 rounded-full shrink-0 {HEALTH_DOTS[health]}"></span>
													<span class="text-sm text-primary truncate">{p.name}</span>
													<span class="font-mono text-[10px] text-muted truncate hidden md:inline">{p.id}</span>
													<span class={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_BADGES[p.type] || 'bg-white/[0.05] text-muted'}`}>
														{typeLabel(p.type)}
													</span>
													<span class="shrink-0 text-[10px] text-muted font-mono">w{p.weight}</span>
													<span class="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-white/[0.04] text-secondary">
														{MATCHED_BY_LABELS[p.matchedBy]}
													</span>
													<span class={`ml-auto shrink-0 flex items-center gap-1 text-[11px] font-medium ${HEALTH_TEXT[health]}`}>
														{HEALTH_LABELS[health]}
														{#if pExpanded}
															<ChevronDown class="w-3.5 h-3.5" stroke-width={2} />
														{:else}
															<ChevronRight class="w-3.5 h-3.5" stroke-width={2} />
														{/if}
													</span>
												</button>

												<!-- Provider detail (rendered only when expanded) -->
												{#if pExpanded}
													<div class="ml-9 mb-2 mt-1 rounded-lg bg-background/60 border border-white/[0.06] p-4">
														<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3 text-xs">
															<div>
																<div class="text-muted mb-0.5">Provider</div>
																<div class="text-primary font-medium break-all">{p.name}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">ID</div>
																<div class="text-secondary font-mono break-all">{p.id}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Type</div>
																<div class="text-secondary font-mono uppercase">{p.type}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Weight</div>
																<div class="text-secondary font-mono">{p.weight}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Enabled</div>
																<div class={p.enabled ? 'text-accent' : 'text-muted'}>
																	{p.enabled ? '是' : '否'}
																</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Matched Model</div>
																<div class="text-secondary font-mono break-all">{p.matchedModel}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Matched By</div>
																<div class="text-secondary">
																	{MATCHED_BY_LABELS[p.matchedBy]}
																	{#if p.matchedPattern}
																		<span class="text-muted font-mono">（{p.matchedPattern}）</span>
																	{/if}
																</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">Circuit State</div>
																<div class={HEALTH_TEXT[health]}>{HEALTH_LABELS[health]}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">模型显式配置</div>
																<div class="text-secondary">{p.modelConfigured ? '是' : '否'}</div>
															</div>
															<div>
																<div class="text-muted mb-0.5">路由参与</div>
																<div class={p.enabled ? 'text-accent' : 'text-muted'}>
																	{p.enabled ? '参与请求路由' : '已禁用，不会参与路由'}
																</div>
															</div>
														</div>
														{#if !p.enabled || health === 'open' || health === 'half-open'}
															<div class="mt-3 text-[11px] border-t border-white/[0.06] pt-2">
																{#if !p.enabled}
																	<span class="text-muted">※ 已禁用 Provider 仅作展示，真实请求不会路由到它。</span>
																{:else if health === 'open'}
																	<span class="text-warning">※ 熔断已打开，请求会跳过该 Provider（冷却后自动探测恢复）。</span>
																{:else if health === 'half-open'}
																	<span class="text-warning">※ 熔断半开，正在试探恢复。</span>
																{/if}
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
	{/if}
</div>