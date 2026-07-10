<script lang="ts">
  import { getProviders, getUsage, type Provider, type UsageData } from "$lib/api";
  import { LayoutDashboard, Server, TrendingUp, Zap, Activity } from "lucide-svelte";
  import { formatTokens, formatNumber } from "$lib/utils";
  import Spinner from "$lib/Spinner.svelte";

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
</script>

<svelte:head><title>概览 — Vega API</title></svelte:head>

{#if loading}
  <div class="flex items-center justify-center min-h-[50vh]">
    <div class="flex flex-col items-center gap-4">
      <Spinner class="text-cta" />
      <span class="text-sm text-muted font-mono">加载中...</span>
    </div>
  </div>
{:else}
  <div class="max-w-6xl mx-auto">
    <div class="mb-6">
      <h1 class="text-lg font-bold text-primary font-mono flex items-center gap-2">
        <LayoutDashboard class="w-5 h-5" stroke-width={1.5} />
        概览
      </h1>
      <p class="text-xs text-muted mt-1">Vega API 运行状态一览</p>
    </div>

    <div class="divider-gradient mb-8"></div>

    <!-- Stat Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      <div class="card-gradient-cta rounded-xl p-5 shadow-card hover:shadow-card-hover transition-shadow animate-stagger-1">
        <div class="flex items-center justify-between mb-4">
          <div class="stat-icon-cta w-10 h-10 rounded-lg flex items-center justify-center">
            <Activity class="w-5 h-5 text-cta" stroke-width={1.5} />
          </div>
          <span class="text-xs text-muted uppercase tracking-wider">总调用次数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{formatNumber(totalCalls)}</div>
      </div>

      <div class="card-gradient-accent rounded-xl p-5 shadow-card hover:shadow-card-hover transition-shadow animate-stagger-2">
        <div class="flex items-center justify-between mb-4">
          <div class="stat-icon-accent w-10 h-10 rounded-lg flex items-center justify-center">
            <Zap class="w-5 h-5 text-accent" stroke-width={1.5} />
          </div>
          <span class="text-xs text-muted uppercase tracking-wider">活跃提供商</span>
        </div>
        <div class="text-2xl font-bold text-accent font-mono tabular-nums">{enabledCount}</div>
      </div>

      <div class="card-gradient-cta rounded-xl p-5 shadow-card hover:shadow-card-hover transition-shadow animate-stagger-3">
        <div class="flex items-center justify-between mb-4">
          <div class="stat-icon-warning w-10 h-10 rounded-lg flex items-center justify-center">
            <TrendingUp class="w-5 h-5 text-warning" stroke-width={1.5} />
          </div>
          <span class="text-xs text-muted uppercase tracking-wider">总 Token 数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{formatTokens(totalTokens)}</div>
      </div>

      <div class="card-gradient-cta rounded-xl p-5 shadow-card hover:shadow-card-hover transition-shadow animate-stagger-4">
        <div class="flex items-center justify-between mb-4">
          <div class="stat-icon-cta w-10 h-10 rounded-lg flex items-center justify-center">
            <Server class="w-5 h-5 text-cta" stroke-width={1.5} />
          </div>
          <span class="text-xs text-muted uppercase tracking-wider">提供商总数</span>
        </div>
        <div class="text-2xl font-bold text-primary font-mono tabular-nums">{providers.length}</div>
      </div>
    </div>

    <!-- Provider Status -->
    <div class="bg-surface rounded-xl p-6 shadow-elevated">
      <h2 class="text-sm font-semibold text-primary mb-4 flex items-center gap-2">
        <Server class="w-4 h-4 text-cta" stroke-width={1.5} />
        提供商状态
      </h2>
      <div class="space-y-1">
        {#each providers as p (p.id)}
          <div class="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-surface-hover transition-colors duration-normal">
            <div class="flex items-center gap-3">
              <div class="w-2 h-2 rounded-full {p.enabled ? 'bg-accent' : 'bg-muted'} {p.enabled ? 'shadow-[0_0_8px_var(--color-accent-glow)]' : ''}"></div>
              <span class="text-sm text-secondary">{p.name}</span>
              <span class="text-[10px] text-muted font-mono uppercase px-1.5 py-0.5 rounded bg-white/[0.04] border border-subtle">
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
