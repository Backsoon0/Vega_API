<script lang="ts">
	import { getCallLogs, getProviders, getSettings, clearCallLogs, type LogEntry } from "$lib/api";
	import { toasts } from "$lib/toast-store";
	import CallLogTable from "$lib/CallLogTable.svelte";
	import LogDetailModal from "$lib/LogDetailModal.svelte";
	import CustomSelect from "$lib/CustomSelect.svelte";

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

	function changePageSize(size: number) {
		pageSize = size;
		page = 0;
	}

	function jumpPage(v: number) {
		if (v >= 1 && v <= totalPages) page = v - 1;
	}

	// ---- Custom dropdown option lists (native <select> popups render light) ----
	const providerOptions = $derived([
		{ value: '', label: '全部提供商' },
		...allProviderIds.map((p) => ({ value: p, label: p })),
	]);
	const streamOptions = [
		{ value: '', label: '全部类型' },
		{ value: 'stream', label: '流式' },
		{ value: 'nonstream', label: '非流式' },
	];
	const statusOptions = [
		{ value: '', label: '全部状态' },
		{ value: 'success', label: '成功' },
		{ value: 'failed', label: '失败' },
	];
	const pageSizeOptionsMap = $derived(pageSizeOptions.map((n) => ({ value: n, label: String(n) })));
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
<div class="mb flex flex-col gap-2.5 md:flex-row md:items-center md:gap-3">
	<div class="input-search w-full md:flex-1 min-w-[200px]">
		<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>
		<input placeholder="搜索 IP / 请求 ID / 模型…" bind:value={search} />
	</div>
	<div class="flex flex-wrap items-center gap-2.5">
		<CustomSelect options={providerOptions} bind:value={providerFilter} onchange={() => (page = 0)} />
		<CustomSelect options={streamOptions} bind:value={streamFilter} onchange={() => (page = 0)} />
		<CustomSelect options={statusOptions} bind:value={successFilter} onchange={() => (page = 0)} />
	</div>
</div>

<CallLogTable entries={entries} loading={loading} visibleColumns={visibleColumns} onRowClick={openDetail} />

<!-- Pagination -->
{#if entries.length > 0 || hasMore}
	<div class="between log-pag">
		<div class="row">
			<span>每页</span>
			<CustomSelect small options={pageSizeOptionsMap} bind:value={pageSize} onchange={(v) => changePageSize(Number(v))} />
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
