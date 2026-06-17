<script lang="ts">
	import { getCallLogs, getProviders, type LogEntry } from "$lib/api";
	import { toasts } from "$lib/toast-store";
	import CallLogTable from "$lib/CallLogTable.svelte";
	import LogDetailModal from "$lib/LogDetailModal.svelte";
	import { ListTodo, RefreshCw, ChevronLeft, ChevronRight, Search } from "lucide-svelte";

	let entries = $state<LogEntry[]>([]);
	let total = $state(0);
	let hasMore = $state(false);
	let loading = $state(true);
	let search = $state('');
	let debouncedSearch = $state('');
	let providerFilter = $state('');
	let streamFilter = $state('');
	let successFilter = $state('');
	let page = $state(0);
	let pageSize = $state(10);
	let allProviderIds = $state<string[]>([]);
	const pageSizeOptions = [10, 20, 50, 100];
	let totalPages = $derived(Math.max(1, Math.ceil((total > 0 ? total : page * pageSize + (hasMore ? pageSize + 1 : entries.length)) / pageSize)));

	// Detail modal
	let detailEntry = $state<LogEntry | null>(null);
	let detailOpen = $state(false);

	// Column visibility (from localStorage)
	const ALL_COLUMNS = ['time', 'ip', 'provider', 'model', 'keyName', 'stream', 'tokens', 'duration', 'status'];
	let visibleColumns = $state<string[]>(ALL_COLUMNS);

	function loadColumnPrefs() {
		try {
			const saved = localStorage.getItem('vega_log_columns');
			if (saved) {
				const arr = JSON.parse(saved);
				if (Array.isArray(arr) && arr.length > 0) {
					visibleColumns = arr;
				}
			}
		} catch { /* use defaults */ }
	}
	loadColumnPrefs();

	function openDetail(entry: LogEntry) {
		detailEntry = entry;
		detailOpen = true;
	}
	function closeDetail() {
		detailOpen = false;
		detailEntry = null;
	}

	// Load all configured providers for the filter dropdown
	async function loadProviders() {
		try {
			const providers = await getProviders();
			allProviderIds = providers.map((p: any) => p.id).sort();
		} catch { /* ignore, providers will fall back to entries */ }
	}
	loadProviders();

	async function fetchLogs() {
		loading = true;
		try {
			const params = new URLSearchParams();
			params.set('limit', String(pageSize));
			params.set('offset', String(page * pageSize));
			if (debouncedSearch) params.set('search', debouncedSearch);
			if (providerFilter) params.set('providerId', providerFilter);
			if (streamFilter === 'stream') params.set('isStream', '1');
			else if (streamFilter === 'nonstream') params.set('isStream', '0');
			if (successFilter === 'success') params.set('success', '1');
			else if (successFilter === 'failed') params.set('success', '0');

			const data = await getCallLogs(params);
			entries = data.logs || [];
			total = data.total || 0;
			hasMore = data.hasMore || false;
		} catch (err: any) {
			toasts.show(err.message || '获取日志失败', 'error');
		} finally { loading = false; }
	}

	// Debounce search: wait 500ms after last keystroke before firing
	let searchTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const q = search;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			debouncedSearch = q;
		}, 500);
	});

	$effect(() => {
		void page; void pageSize; void debouncedSearch; void providerFilter; void streamFilter; void successFilter;
		fetchLogs();
	});

	// Reset page to 0 when search text changes
	$effect(() => {
		debouncedSearch;
		page = 0;
	});

	function handleRefresh() { fetchLogs(); }

	function changeFilter(filterSetter: (() => void)) {
		page = 0;
		filterSetter();
	}

	function changePageSize(size: number) {
		pageSize = size;
		page = 0;
	}

	function jumpPage(v: number) {
		if (v >= 1 && v <= totalPages) page = v - 1;
	}
</script>

<svelte:head><title>调用记录 — Vega API</title></svelte:head>

<div class="max-w-6xl mx-auto">
	<div class="mb-6 flex items-center justify-between flex-wrap gap-4">
		<div>
			<h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
				<ListTodo class="w-5 h-5" stroke-width={1.5} />
				调用记录
			</h1>
			<p class="text-xs text-muted mt-1">最近 {total} 条 API 调用记录（最多保留 10000 条）</p>
		</div>
		<button
			class="px-3 py-2 rounded-xl text-sm text-secondary hover:text-primary hover:bg-surface-hover transition-all flex items-center gap-2 border border-white/[0.06]"
			onclick={handleRefresh}
			disabled={loading}
		>
			<RefreshCw class={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} stroke-width={1.5} />
			刷新
		</button>
	</div>

	<!-- Search & filter bar -->
	<div class="mb-4 flex flex-col sm:flex-row gap-2 sm:gap-3">
		<div class="flex-1 flex items-center gap-2 bg-input border border-white/[0.06] rounded-xl px-3 focus-within:ring-2 focus-within:ring-cta/50 transition-all">
			<Search
				class="w-4 h-4 shrink-0 transition-opacity {search ? 'text-muted/30' : 'text-muted'}"
				stroke-width={1.5}
			/>
			<input
				type="text"
				placeholder="搜索 IP / 模型..."
				class="flex-1 py-2.5 bg-transparent text-sm text-primary placeholder:text-placeholder focus:outline-none"
				bind:value={search}
			/>
		</div>
		<div class="flex gap-2">
			<select
				class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
				value={providerFilter}
				onchange={(e) => changeFilter(() => providerFilter = (e.target as HTMLSelectElement).value)}
			>
				<option value="">全部提供商</option>
				{#each allProviderIds as p}
					<option value={p}>{p}</option>
				{/each}
			</select>
			<select
				class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
				value={streamFilter}
				onchange={(e) => changeFilter(() => streamFilter = (e.target as HTMLSelectElement).value)}
			>
				<option value="">全部类型</option>
				<option value="stream">流式</option>
				<option value="nonstream">非流式</option>
			</select>
			<select
				class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
				value={successFilter}
				onchange={(e) => changeFilter(() => successFilter = (e.target as HTMLSelectElement).value)}
			>
				<option value="">全部状态</option>
				<option value="success">成功</option>
				<option value="failed">失败</option>
			</select>
		</div>
	</div>

	<CallLogTable entries={entries} loading={loading} visibleColumns={visibleColumns} onRowClick={openDetail} />

	<!-- Pagination -->
	{#if entries.length > 0 || hasMore}
		<div class="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted">
			<div class="flex items-center gap-2">
				<span>每页</span>
				<select
					class="px-3 py-2 bg-input border border-white/[0.08] rounded-xl text-secondary text-xs"
					value={pageSize}
					onchange={(e) => changePageSize(Number((e.target as HTMLSelectElement).value))}
				>
					{#each pageSizeOptions as size}
						<option value={size}>{size}</option>
					{/each}
				</select>
				<span>条</span>
			</div>

			<div class="flex items-center gap-3">
				<button
					class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1
						{page === 0
							? 'text-muted bg-surface border border-white/[0.06] cursor-not-allowed'
							: 'text-white bg-cta hover:bg-cta-hover shadow-glow-cta active:scale-[0.97]'}"
					onclick={() => page--}
					disabled={page === 0}
				>
					<ChevronLeft class="w-3.5 h-3.5" stroke-width={2} />
					上一页
				</button>
				<span class="tabular-nums flex items-center gap-1.5">
					第
					<input
						type="number"
						min="1"
						max={totalPages}
						value={page + 1}
						onkeydown={(e) => {
							if (e.key === 'Enter') jumpPage(parseInt((e.target as HTMLInputElement).value));
						}}
						onchange={(e) => jumpPage(parseInt((e.target as HTMLInputElement).value))}
						class="w-12 px-1.5 py-0.5 bg-input border border-white/[0.10] rounded text-center text-secondary font-mono text-xs focus:outline-none focus:ring-1 focus:ring-cta/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
					/>
					/ <span class="text-secondary font-mono">{totalPages}</span> 页
				</span>
				<button
					class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1
						{!hasMore && page >= totalPages - 1
							? 'text-muted bg-surface border border-white/[0.06] cursor-not-allowed'
							: 'text-white bg-cta hover:bg-cta-hover shadow-glow-cta active:scale-[0.97]'}"
					onclick={() => page++}
					disabled={!hasMore && page >= totalPages - 1}
				>
					下一页
					<ChevronRight class="w-3.5 h-3.5" stroke-width={2} />
				</button>
			</div>
		</div>
	{/if}
</div>

<LogDetailModal entry={detailEntry} open={detailOpen} onclose={closeDetail} />
