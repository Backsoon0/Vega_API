<script lang="ts">
  import type { CallLogEntry } from "$lib/logStore";
  import { searchLogs, clearLogs as clearStoredLogs } from "$lib/logStore";
  import { Search, Trash2 } from "lucide-svelte";

  let { entries = [] as CallLogEntry[], onclear = () => {} } = $props();

  let searchQuery = $state('');
  let providerFilter = $state('');

  const filtered = $derived(
    searchLogs(
      entries.filter(e => {
        if (providerFilter && !e.providerId.includes(providerFilter)) return false;
        return true;
      }),
      searchQuery
    )
  );

  const uniqueProviders = $derived([...new Set(entries.map(e => e.providerId))].sort());

  function formatTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
</script>

<div class="space-y-4">
  <!-- Search bar -->
  <div class="flex flex-col sm:flex-row gap-3">
    <div class="flex-1 relative">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-placeholder" stroke-width={1.5} />
      <input
        type="text"
        placeholder="搜索 IP / 模型 / 提供商..."
        class="w-full pl-10 pr-4 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-primary placeholder:text-placeholder focus:outline-none focus:ring-2 focus:ring-cta/50 transition-all"
        bind:value={searchQuery}
      />
    </div>
    <select
      class="px-3 py-2.5 bg-input border border-white/[0.06] rounded-xl text-sm text-secondary min-w-[140px]"
      bind:value={providerFilter}
    >
      <option value="">全部提供商</option>
      {#each uniqueProviders as p}
        <option value={p}>{p}</option>
      {/each}
    </select>
    {#if entries.length > 0}
      <button
        class="px-3 py-2.5 rounded-xl text-sm text-danger hover:bg-danger-subtle flex items-center gap-2 transition-all"
        onclick={() => { clearStoredLogs(); onclear(); }}
      >
        <Trash2 class="w-4 h-4" stroke-width={1.5} />
        清空
      </button>
    {/if}
  </div>

  <!-- Table -->
  {#if entries.length === 0}
    <div class="bg-surface border border-white/[0.06] border-dashed rounded-2xl p-12 text-center">
      <p class="text-muted text-sm">暂无调用记录</p>
      <p class="text-placeholder text-xs mt-1">API 调用将实时显示在这里</p>
    </div>
  {:else}
    <div class="bg-surface border border-white/[0.06] rounded-xl overflow-hidden overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-white/[0.06]">
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">时间</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">IP</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">提供商</th>
            <th class="text-left px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">模型</th>
            <th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">Prompt</th>
            <th class="text-right px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">Completion</th>
            <th class="text-center px-4 py-3 text-[10px] text-muted uppercase tracking-wider font-semibold">状态</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as entry (entry.timestamp + entry.ip + entry.model)}
            <tr class="border-b border-white/[0.03] hover:bg-surface-hover transition-colors">
              <td class="px-4 py-2.5 text-secondary font-mono text-xs whitespace-nowrap">{formatTime(entry.timestamp)}</td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs">{entry.ip}</td>
              <td class="px-4 py-2.5 text-secondary text-xs">{entry.providerId}</td>
              <td class="px-4 py-2.5 text-secondary font-mono text-xs max-w-[180px] truncate">{entry.model}</td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">{entry.promptTokens.toLocaleString()}</td>
              <td class="px-4 py-2.5 text-muted font-mono text-xs text-right tabular-nums">{entry.completionTokens.toLocaleString()}</td>
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
    <div class="text-xs text-muted text-right">
      显示 {filtered.length} / {entries.length} 条记录
    </div>
  {/if}
</div>
