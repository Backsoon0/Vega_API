<script lang="ts">
  import CallLogTable from "$lib/CallLogTable.svelte";
  import { authToken } from "$lib/api";
  import { ListTodo, RefreshCw } from "lucide-svelte";

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
  let pageSize = 100;

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

  // Fetch on mount and when filters change
  $effect(() => {
    if (!authToken) return;
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
    // With D1 storage, clear is not needed — logs auto-rotate
    fetchLogs();
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
</div>
