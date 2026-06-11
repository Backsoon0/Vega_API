<script lang="ts">
  import { getProviders, getUsage, type Provider, type UsageData } from "$lib/api";
  import { LayoutDashboard, Server, TrendingUp, Zap, Activity } from "lucide-svelte";

  let providers = $state<Provider[]>([]);
  let usage = $state<UsageData | null>(null);
  let loading = $state(true);

  $effect(() => {
    Promise.all([
      getProviders().catch(() => [] as Provider[]),
      getUsage().catch(() => null as UsageData | null),
    ]).then(([p, u]) => {
      providers = p;
      usage = u;
      loading = false;
    });
  });

  const totalCalls = $derived(
    usage?.totals
      ? Object.values(usage.totals).reduce((s, v) => s + (v.calls || 0), 0)
      : 0
  );
  const totalTokens = $derived(
    usage?.totals
      ? Object.values(usage.totals).reduce(
          (s, v) => s + (v.promptTokens || 0) + (v.completionTokens || 0), 0)
      : 0
  );
  const enabledCount = $derived(providers.filter(p => p.enabled).length);

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  function formatNumber(n: number): string {
    return n.toLocaleString();
  }
</script>

<svelte:head><title>概览 — Vega API</title></svelte:head>

{#if loading}
  <div class="space-y-6 animate-pulse">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {#each Array(4) as _}
        <div class="bg-surface rounded-xl p-5 h-24"></div>
      {/each}
    </div>
  </div>
{:else}
  <div class="max-w-6xl mx-auto">
    <div class="mb-8">
      <h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
        <LayoutDashboard class="w-5 h-5" stroke-width={1.5} />
        概览
      </h1>
      <p class="text-xs text-muted mt-1">Vega API 运行状态一览</p>
    </div>

    <!-- Stat Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div class="bg-surface border border-white/[0.06] rounded-xl p-5">
        <div class="flex items-center gap-2 mb-3">
          <Activity class="w-4 h-4 text-cta" stroke-width={1.5} />
          <span class="text-xs text-muted uppercase tracking-wider">总调用次数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{formatNumber(totalCalls)}</div>
      </div>

      <div class="bg-surface border border-white/[0.06] rounded-xl p-5">
        <div class="flex items-center gap-2 mb-3">
          <Zap class="w-4 h-4 text-accent" stroke-width={1.5} />
          <span class="text-xs text-muted uppercase tracking-wider">活跃提供商</span>
        </div>
        <div class="text-2xl font-bold text-accent font-mono tabular-nums">{enabledCount}</div>
      </div>

      <div class="bg-surface border border-white/[0.06] rounded-xl p-5">
        <div class="flex items-center gap-2 mb-3">
          <TrendingUp class="w-4 h-4 text-warning" stroke-width={1.5} />
          <span class="text-xs text-muted uppercase tracking-wider">总 Token 数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{formatTokens(totalTokens)}</div>
      </div>

      <div class="bg-surface border border-white/[0.06] rounded-xl p-5">
        <div class="flex items-center gap-2 mb-3">
          <Server class="w-4 h-4 text-cta" stroke-width={1.5} />
          <span class="text-xs text-muted uppercase tracking-wider">提供商总数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{providers.length}</div>
      </div>
    </div>

    <!-- Provider Status -->
    <div class="bg-surface border border-white/[0.06] rounded-xl p-6">
      <h2 class="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
        <Server class="w-4 h-4 text-cta" stroke-width={1.5} />
        提供商状态
      </h2>
      <div class="space-y-2">
        {#each providers as p (p.id)}
          <div class="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-surface-hover transition-colors">
            <div class="flex items-center gap-3">
              <div class="w-2 h-2 rounded-full {p.enabled ? 'bg-accent' : 'bg-muted'}"></div>
              <span class="text-sm text-secondary">{p.name}</span>
              <span class="text-[10px] text-muted font-mono uppercase px-1.5 py-0.5 rounded bg-white/[0.04]">
                {p.type === 'vertex_ai' ? 'Vertex' : p.type === 'google_ai_studio' ? 'Studio' : 'OpenAI'}
              </span>
            </div>
            <span class="text-xs {p.enabled ? 'text-accent' : 'text-muted'}">
              {p.enabled ? '运行中' : '已禁用'}
            </span>
          </div>
        {/each}
        {#if providers.length === 0}
          <p class="text-sm text-muted text-center py-6">暂无提供商，请到 API 设置页面添加</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
