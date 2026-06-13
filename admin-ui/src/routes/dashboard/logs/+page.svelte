<script lang="ts">
  import CallLogTable from "$lib/CallLogTable.svelte";
  import { authToken } from "$lib/api";
  import { ListTodo, RefreshCw, ChevronLeft, ChevronRight } from "lucide-svelte";

  interface LogEntry {
    timestamp: string;
    ip: string;
    providerId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    success: boolean;
  }

  let entries = $state<LogEntry[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let search = $state('');
  let providerFilter = $state('');
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

      const resp = await fetch(`/admin/logs?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      entries = data.logs || [];
      total = data.total || 0;
    } catch {
      // ignore
    } finally { loading = false; }
  }

  // Fetch on mount and when filters/page/pageSize change
  $effect(() => {
    if (!authToken) return;
    // track dependencies via reading them
    void page; void pageSize; void search; void providerFilter;
    fetchLogs();
  });

  function handleSearch() {
    page = 0;
    fetchLogs();
  }

  function handleRefresh() {
    fetchLogs();
  }

  function handleClear() {
    fetchLogs();
  }

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

  <CallLogTable entries={entries} loading={loading} onclear={handleClear} />

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
      <div class="flex items-center gap-3">
        <button
          class="px-2.5 py-1.5 rounded-lg border border-white/[0.08] hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
          onclick={prevPage}
          disabled={page === 0}
        >
          <ChevronLeft class="w-3.5 h-3.5" stroke-width={2} />
          上一页
        </button>
        <span class="tabular-nums">
          第 <span class="text-secondary font-mono">{page + 1}</span> / <span class="text-secondary font-mono">{totalPages}</span> 页
          <span class="hidden sm:inline">（共 {total} 条）</span>
        </span>
        <button
          class="px-2.5 py-1.5 rounded-lg border border-white/[0.08] hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
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
