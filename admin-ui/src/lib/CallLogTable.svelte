<script lang="ts">
  import { Search, Trash2 } from "lucide-svelte";

  interface LogEntry {
    timestamp: string;
    ip: string;
    providerId: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    success: boolean;
  }

  let { entries = [] as LogEntry[], loading = false, onclear = () => {} } = $props();

  let searchQuery = $state('');
  let providerFilter = $state('');

  function filterLogs(list: LogEntry[]): LogEntry[] {
    let result = list;
    if (providerFilter) {
      result = result.filter(e => e.providerId === providerFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(e =>
        e.ip.toLowerCase().includes(q) ||
        e.providerId.toLowerCase().includes(q) ||
        e.model.toLowerCase().includes(q)
      );
    }
    return result;
  }

  const filtered = $derived(filterLogs(entries));
  const uniqueProviders = $derived([...new Set(entries.map(e => e.providerId))].sort());

  function formatTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  function formatDuration(ms: number): string {
    if (!ms || ms < 0) return '-';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const secs = Math.floor(ms / 1000);
    return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  }
</script>

<div class="space-y-4">
  <!-- Search bar -->
  <div class="flex flex-col sm:flex-row gap-2 sm:gap-3">
    <div class="flex-1 relative">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-placeholder" stroke-width={1.5} />
      <input
        type="text"
        placeholder="搜索 IP / 模型 / 提供商..."
        class="w-full pl-10 pr-4 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50 transition-all"
        bind:value={searchQuery}
      />
    </div>
    <div class="flex gap-2">
      <select
        class="flex-1 sm:flex-none px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary"
        bind:value={providerFilter}
      >
        <option value="">全部提供商</option>
        {#each uniqueProviders as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Content -->
  {#if loading && entries.length === 0}
    <div class="space-y-3">
      {#each Array(5) as _}
        <div class="bg-surface border border-white/[0.06] rounded-xl p-4 animate-pulse h-[52px]"></div>
      {/each}
    </div>
  {:else if entries.length === 0}
    <div class="bg-surface border border-white/[0.06] border-dashed rounded-2xl p-10 sm:p-12 text-center">
      <p class="text-muted text-sm">暂无调用记录</p>
      <p class="text-placeholder text-xs mt-1">发送 API 请求后，调用记录将显示在这里</p>
    </div>
  {:else}
    <!-- Desktop table -->
    <div class="hidden sm:block bg-surface border border-white/[0.06] rounded-xl overflow-hidden overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-white/[0.06]">
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">时间</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">IP</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">提供商</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">模型</th>
            <th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">Tokens</th>
            <th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">耗时</th>
            <th class="text-center px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">状态</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as entry (entry.timestamp + entry.ip + entry.model)}
            <tr class="border-b border-white/[0.03] hover:bg-surface-hover transition-colors">
              <td class="px-4 py-2.5 text-secondary font-mono text-xs whitespace-nowrap">{formatTime(entry.timestamp)}</td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs">{entry.ip}</td>
              <td class="px-4 py-2.5 text-secondary text-xs">{entry.providerId}</td>
              <td class="px-4 py-2.5 text-secondary font-mono text-xs max-w-[160px] truncate">{entry.model}</td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">
                <span class="text-accent">{entry.promptTokens.toLocaleString()}</span>
                <span class="text-muted"> / </span>
                <span class="text-cta">{entry.completionTokens.toLocaleString()}</span>
              </td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">
                {formatDuration(entry.durationMs)}
              </td>
              <td class="px-4 py-2.5 text-center">
                <span class="text-[10px] px-2 py-0.5 rounded-full font-semibold {entry.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}">
                  {entry.success ? '成功' : '失败'}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Mobile cards -->
    <div class="sm:hidden space-y-3">
      {#each filtered as entry (entry.timestamp + entry.ip + entry.model)}
        <div class="bg-surface border border-white/[0.06] rounded-xl p-4 space-y-2.5">
          <div class="flex items-center justify-between">
            <span class="font-mono text-xs text-secondary">{formatTime(entry.timestamp)}</span>
            <span class="text-[10px] px-2 py-0.5 rounded-full font-semibold {entry.success ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger'}">
              {entry.success ? '成功' : '失败'}
            </span>
          </div>
          <div class="grid grid-cols-2 gap-2 text-xs">
            <div><span class="text-muted">IP: </span><span class="text-secondary font-mono">{entry.ip}</span></div>
            <div><span class="text-muted">提供商: </span><span class="text-secondary">{entry.providerId}</span></div>
            <div class="col-span-2"><span class="text-muted">模型: </span><span class="text-secondary font-mono break-all">{entry.model}</span></div>
            <div class="col-span-2 flex gap-3">
              <span class="text-muted">Prompt: <span class="text-accent font-mono tabular-nums">{entry.promptTokens.toLocaleString()}</span></span>
              <span class="text-muted">Completion: <span class="text-cta font-mono tabular-nums">{entry.completionTokens.toLocaleString()}</span></span>
              <span class="text-muted">耗时: <span class="text-secondary font-mono">{formatDuration(entry.durationMs)}</span></span>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <div class="text-xs text-muted text-right">
      显示 {filtered.length} / {entries.length} 条记录
    </div>
  {/if}
</div>
