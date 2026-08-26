<script lang="ts">
	import { getCallLogs, getProviders, getSettings, clearCallLogs, type LogEntry } from "$lib/api";
	import { toasts } from "$lib/toast-store";
	import CallLogTable from "$lib/CallLogTable.svelte";
	import LogDetailModal from "$lib/LogDetailModal.svelte";

	let entries = $state<LogEntry[]>([]);
	let total = $state(0);
	let hasMore = $state(false);
	let loading = $state(true);
	let clearing = $state(false);
	let retentionLimit = $state(10000);
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

	// Load the configured retention limit (for the subtitle) from admin settings
	getSettings().then(s => {
		retentionLimit = s.logRetentionLimit || 10000;
	}).catch(() => {});

	// One-click clear all call logs
	async function handleClearLogs() {
		if (!confirm('确定要清空全部调用记录吗？此操作不可恢复。\n（仅删除调用记录明细，不影响用量统计）')) return;
		clearing = true;
		try {
			const res = await clearCallLogs();
			toasts.show(`已清空 ${res.deleted} 条调用记录`);
			page = 0;
			await fetchLogs();
		} catch (err: any) {
			toasts.show(err.message || '清空失败', 'error');
		} finally {
			clearing = false;
		}
	}

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

<div class="page-head">
	<div>
		<h1>调用记录</h1>
		<p class="lead">最近 {total} 条 API 调用记录（最多保留 {retentionLimit.toLocaleString()} 条，可在设置页调整）</p>
	</div>
	<div class="actions">
		<button class="btn btn-danger" onclick={handleClearLogs} disabled={clearing || (loading && entries.length === 0)}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" /></svg>
			{clearing ? '清空中...' : '清空记录'}
		</button>
		<button class="btn btn-ghost" onclick={handleRefresh} disabled={loading}>
			<svg class={loading ? 'animate-spin' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
			刷新
		</button>
	</div>
</div>

<!-- Search & filter bar -->
<div class="row mb" style="flex-wrap:wrap">
	<div class="input-search" style="flex:1;min-width:200px">
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
		<input placeholder="搜索 IP / 请求 ID / 模型…" bind:value={search} />
	</div>
	<div class="select-wrap" style="min-width:176px">
		<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
		<select class="select" style="border:none;background:none" value={providerFilter} onchange={(e) => changeFilter(() => providerFilter = (e.target as HTMLSelectElement).value)}>
			<option value="">全部提供商</option>
			{#each allProviderIds as p}
				<option value={p}>{p}</option>
			{/each}
		</select>
	</div>
	<select class="select" style="width:auto" value={streamFilter} onchange={(e) => changeFilter(() => streamFilter = (e.target as HTMLSelectElement).value)}>
		<option value="">全部类型</option>
		<option value="stream">流式</option>
		<option value="nonstream">非流式</option>
	</select>
	<select class="select" style="width:auto" value={successFilter} onchange={(e) => changeFilter(() => successFilter = (e.target as HTMLSelectElement).value)}>
		<option value="">全部状态</option>
		<option value="success">成功</option>
		<option value="failed">失败</option>
	</select>
</div>

<CallLogTable entries={entries} loading={loading} visibleColumns={visibleColumns} onRowClick={openDetail} />

<!-- Pagination -->
{#if entries.length > 0 || hasMore}
	<div class="between log-pag">
		<div class="row">
			<span>每页</span>
			<select class="select btn-sm" style="width:auto;font-size:12px" value={pageSize} onchange={(e) => changePageSize(Number((e.target as HTMLSelectElement).value))}>
				{#each pageSizeOptions as size}
					<option value={size}>{size}</option>
				{/each}
			</select>
			<span>条</span>
		</div>
		<div class="row">
			<button class="btn btn-ghost btn-sm" onclick={() => page--} disabled={page === 0}>‹</button>
			<span class="mono">{page + 1} / {totalPages}</span>
			<button class="btn btn-ghost btn-sm" onclick={() => page++} disabled={!hasMore && page >= totalPages - 1}>›</button>
		</div>
	</div>
{/if}

<LogDetailModal entry={detailEntry} open={detailOpen} onclose={closeDetail} />
