<script lang="ts">
  import { authToken, getCallLogs, type LogEntry } from "$lib/api";
  import { get } from "svelte/store";
  import { toasts } from "$lib/toast-store";
  import CallLogTable from "$lib/CallLogTable.svelte";
  import { ListTodo, RefreshCw, ChevronLeft, ChevronRight } from "lucide-svelte";

  let entries = $state<LogEntry[]>([]);
  let total = $state(0);
  let cachedTotal = 0;
  let lastFilterKey = '';
  let loading = $state(true);
  let search = $state('');
  let providerFilter = $state('');
  let streamFilter = $state('');
  let successFilter = $state('');
  let page = $state(0);
  let pageSize = $state(10);
  const pageSizeOptions = [10, 20, 50, 100];
  let totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));

  async function fetchLogs() {
    loading = true;
    try {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      if (search) params.set('search', search);
      if (providerFilter) params.set('providerId', providerFilter);
      if (streamFilter === 'stream') params.set('isStream', '1');
      else if (streamFilter === 'nonstream') params.set('isStream', '0');
      if (successFilter === 'success') params.set('success', '1');
      else if (successFilter === 'failed') params.set('success', '0');

      // Build a key representing the current filter state (without page/pageSize)
      const filterKey = `${search}|${providerFilter}|${streamFilter}|${successFilter}`;
      const filtersChanged = filterKey !== lastFilterKey;

      if (!filtersChanged) {
        // Only page changed — skip COUNT, reuse cached total
        params.set('includeTotal', 'false');
        total = cachedTotal;
      }

      const data = await getCallLogs(params);
      entries = data.logs || [];
      if (filtersChanged) {
        total = data.total || 0;
        cachedTotal = total;
        lastFilterKey = filterKey;
      }
    } catch (err: any) {
      toasts.show(err.message || '获取日志失败', 'error');
    } finally { loading = false; }
  }

  $effect(() => {
    if (!get(authToken)) return;
    void page; void pageSize; void search; void providerFilter; void streamFilter; void successFilter;
    fetchLogs();
  });

  function handleRefresh() { fetchLogs(); }

  function changePageSize(size: number) {
    pageSize = size;
    page = 0;
  }

  function prevPage() {
    if (page > 0) page--;
  }

  function nextPage() {
    if (page < totalPages - 1) page++;
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

  <CallLogTable entries={entries} loading={loading} />

  <!-- Filter bar -->
  <div class="mt-4 flex flex-wrap gap-2">
    <select
      class="px-3 py-2 bg-input border border-white/[0.06] rounded-xl text-xs text-secondary"
      bind:value={streamFilter}
    >
      <option value="">全部类型</option>
      <option value="stream">流式</option>
      <option value="nonstream">非流式</option>
    </select>
    <select
      class="px-3 py-2 bg-input border border-white/[0.06] rounded-xl text-xs text-secondary"
      bind:value={successFilter}
    >
      <option value="">全部状态</option>
      <option value="success">成功</option>
      <option value="failed">失败</option>
    </select>
  </div>

  <!-- Pagination -->
  {#if total > 0}
    <div class="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted">
      <!-- Page size selector -->
      <div class="flex items-center gap-2">
        <span>每页</span>
        <select
          class="px-2 py-1.5 bg-input border border-white/[0.08] rounded-lg text-secondary text-xs"
          value={pageSize}
          onchange={(e) => changePageSize(Number((e.target as HTMLSelectElement).value))}
        >
          {#each pageSizeOptions as size}
            <option value={size}>{size}</option>
          {/each}
        </select>
        <span>条</span>
      </div>

      <!-- Page navigation -->
      <div class="flex items-center gap-1.5">
        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1
            {page === 0
              ? 'text-muted bg-surface border border-white/[0.06] cursor-not-allowed'
              : 'text-white bg-cta hover:bg-cta-hover shadow-glow-cta active:scale-[0.97]'}"
          onclick={prevPage}
          disabled={page === 0}
        >
          <ChevronLeft class="w-3.5 h-3.5" stroke-width={2} />
          上一页
        </button>
        <span class="tabular-nums px-2">
          第 <span class="text-secondary font-mono">{page + 1}</span> / <span class="text-secondary font-mono">{totalPages}</span> 页
          <span class="hidden sm:inline">（共 {total} 条）</span>
        </span>
        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1
            {page >= totalPages - 1
              ? 'text-muted bg-surface border border-white/[0.06] cursor-not-allowed'
              : 'text-white bg-cta hover:bg-cta-hover shadow-glow-cta active:scale-[0.97]'}"
          onclick={nextPage}
          disabled={page >= totalPages - 1}
        >
          下一页
          <ChevronRight class="w-3.5 h-3.5" stroke-width={2} />
        </button>
      </div>
    </div>
  {/if}
</div>
