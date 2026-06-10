<script lang="ts">
  import { getUsage, type UsageData } from "$lib/api";
  import { BarChart3, RefreshCw, Calendar } from "lucide-svelte";

  let loading = $state(false);
  let data = $state<UsageData | null>(null);
  let error = $state("");

  let fromDate = $state("");
  let toDate = $state("");
  let hasFilter = $state(false);

  async function fetchUsage() {
    loading = true;
    error = "";
    try {
      if (hasFilter || fromDate || toDate) {
        data = await getUsage(fromDate || undefined, toDate || undefined);
      } else {
        data = await getUsage();
      }
    } catch (err: any) {
      error = err.message || "获取用量失败";
    } finally {
      loading = false;
    }
  }

  function applyFilter() {
    hasFilter = !!(fromDate || toDate);
    fetchUsage();
  }

  function clearFilter() {
    fromDate = "";
    toDate = "";
    hasFilter = false;
    fetchUsage();
  }

  function formatNumber(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return n.toLocaleString();
  }

  function getTotals() {
    if (!data) return { calls: 0, promptTokens: 0, completionTokens: 0 };

    // From filtered data
    if (data.total) return data.total;

    // From totals (unfiltered)
    if (data.totals) {
      let calls = 0, prompt = 0, comp = 0;
      for (const v of Object.values(data.totals)) {
        calls += v.calls || 0;
        prompt += v.promptTokens || 0;
        comp += v.completionTokens || 0;
      }
      return { calls, promptTokens: prompt, completionTokens: comp };
    }

    return { calls: 0, promptTokens: 0, completionTokens: 0 };
  }

  function getProviderBreakdown(): Array<{ id: string; calls: number; promptTokens: number; completionTokens: number }> {
    if (data?.byProvider) {
      return Object.entries(data.byProvider)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.calls - a.calls);
    }
    if (data?.totals) {
      return Object.entries(data.totals)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => b.calls - a.calls);
    }
    return [];
  }

  function getDailyBreakdown(): Array<{ date: string; calls: number; promptTokens: number; completionTokens: number }> {
    if (!data?.daily) return [];
    return Object.entries(data.daily)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Load on mount
  $effect(() => {
    fetchUsage();
  });
</script>

<div class="space-y-5">
  <!-- Section header -->
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div class="flex items-center gap-2.5">
      <BarChart3 class="w-5 h-5 text-accent" />
      <h2 class="text-sm font-semibold text-primary uppercase tracking-wider font-mono">API 用量统计</h2>
    </div>
    <button
      type="button"
      onclick={fetchUsage}
      disabled={loading}
      class="px-3 py-1.5 text-xs font-medium rounded-lg
             bg-surface-elevated hover:bg-surface-hover text-secondary hover:text-primary
             border border-white/[0.08] transition-all duration-200
             inline-flex items-center gap-1.5 disabled:opacity-40"
    >
      <RefreshCw class={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
      刷新
    </button>
  </div>

  <!-- Date filter -->
  <div class="flex items-center gap-3 flex-wrap p-3 rounded-xl bg-input border border-white/[0.06]">
    <Calendar class="w-4 h-4 text-muted shrink-0" />
    <label class="text-xs text-secondary font-medium">日期范围</label>
    <input
      type="date"
      bind:value={fromDate}
      class="px-2.5 py-1.5 rounded-lg bg-surface border border-white/[0.10] text-primary text-xs font-mono
             focus:outline-none focus:ring-2 focus:ring-cta/30 transition-all duration-200"
    />
    <span class="text-xs text-muted">至</span>
    <input
      type="date"
      bind:value={toDate}
      class="px-2.5 py-1.5 rounded-lg bg-surface border border-white/[0.10] text-primary text-xs font-mono
             focus:outline-none focus:ring-2 focus:ring-cta/30 transition-all duration-200"
    />
    <button onclick={applyFilter} class="px-3 py-1.5 text-xs font-medium rounded-lg bg-cta text-white hover:opacity-90 transition-all duration-200">
      查询
    </button>
    {#if hasFilter}
      <button onclick={clearFilter} class="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-elevated text-muted hover:text-secondary transition-all duration-200">
        清除
      </button>
    {/if}
  </div>

  {#if error}
    <div class="text-sm text-danger bg-danger-subtle rounded-xl px-4 py-3 border border-danger/20">{error}</div>
  {/if}

  {#if loading}
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {#each [1, 2, 3] as _}
        <div class="p-4 rounded-xl bg-input border border-white/[0.06] animate-pulse">
          <div class="h-3 w-16 bg-surface rounded mb-3"></div>
          <div class="h-6 w-24 bg-surface rounded"></div>
        </div>
      {/each}
    </div>
  {:else if data}
    {@const totals = getTotals()}
    {@const providers = getProviderBreakdown()}
    {@const daily = getDailyBreakdown()}

    <!-- Total cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="p-4 rounded-xl bg-input border border-white/[0.08]">
        <div class="text-[11px] text-muted uppercase tracking-wider font-semibold mb-1">总调用次数</div>
        <div class="text-2xl font-bold text-primary font-mono">{formatNumber(totals.calls)}</div>
      </div>
      <div class="p-4 rounded-xl bg-input border border-white/[0.08]">
        <div class="text-[11px] text-muted uppercase tracking-wider font-semibold mb-1">总输入 Token</div>
        <div class="text-2xl font-bold text-cta font-mono">{formatNumber(totals.promptTokens)}</div>
      </div>
      <div class="p-4 rounded-xl bg-input border border-white/[0.08]">
        <div class="text-[11px] text-muted uppercase tracking-wider font-semibold mb-1">总输出 Token</div>
        <div class="text-2xl font-bold text-accent font-mono">{formatNumber(totals.completionTokens)}</div>
      </div>
    </div>

    <!-- Per-provider breakdown -->
    {#if providers.length > 0}
      <div class="space-y-2">
        <h3 class="text-xs font-semibold text-secondary uppercase tracking-wider">提供商明细</h3>
        <div class="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-white/[0.06] bg-surface">
                <th class="text-left px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">Provider ID</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">调用次数</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">输入 Token</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">输出 Token</th>
              </tr>
            </thead>
            <tbody>
              {#each providers as p}
                <tr class="border-b border-white/[0.04] hover:bg-surface-hover transition-colors">
                  <td class="px-4 py-2.5 text-primary font-mono">{p.id}</td>
                  <td class="px-4 py-2.5 text-right text-primary font-mono">{p.calls.toLocaleString()}</td>
                  <td class="px-4 py-2.5 text-right text-cta font-mono">{formatNumber(p.promptTokens)}</td>
                  <td class="px-4 py-2.5 text-right text-accent font-mono">{formatNumber(p.completionTokens)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {:else if hasFilter}
      <div class="text-center py-8 text-muted text-sm">所选日期范围内无数据</div>
    {/if}

    <!-- Daily breakdown -->
    {#if daily.length > 0}
      <div class="space-y-2">
        <h3 class="text-xs font-semibold text-secondary uppercase tracking-wider">每日明细</h3>
        <div class="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-white/[0.06] bg-surface">
                <th class="text-left px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">日期</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">调用次数</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">输入 Token</th>
                <th class="text-right px-4 py-2.5 text-muted font-semibold uppercase tracking-wider">输出 Token</th>
              </tr>
            </thead>
            <tbody>
              {#each daily as d}
                <tr class="border-b border-white/[0.04] hover:bg-surface-hover transition-colors">
                  <td class="px-4 py-2.5 text-primary font-mono">{d.date}</td>
                  <td class="px-4 py-2.5 text-right text-primary font-mono">{d.calls.toLocaleString()}</td>
                  <td class="px-4 py-2.5 text-right text-cta font-mono">{formatNumber(d.promptTokens)}</td>
                  <td class="px-4 py-2.5 text-right text-accent font-mono">{formatNumber(d.completionTokens)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <!-- Empty state -->
    {#if providers.length === 0 && daily.length === 0 && !hasFilter}
      <div class="text-center py-8 text-muted text-sm">
        <BarChart3 class="w-8 h-8 mx-auto mb-2 opacity-30" />
        暂无用量数据，开始调用 API 后这里将显示统计信息
      </div>
    {/if}
  {/if}
</div>
