<script lang="ts">
  import { getProviders, getUsage, getCallLogs, type Provider, type UsageData, type LogEntry } from "$lib/api";
  import { getRouteStats, formatLatency, type RouteStatsResponse } from "$lib/route-stats";
  import { formatNumber, formatDuration, formatTime } from "$lib/utils";

  let providers = $state<Provider[]>([]);
  let usage = $state<UsageData | null>(null);
  let routeStats = $state<RouteStatsResponse | null>(null);
  let recent = $state<LogEntry[]>([]);
  let loading = $state(true);
  let error = $state("");
  let rangeHours = $state(24);

  const RANGES = [
    { label: "最近 24 小时", hours: 24 },
    { label: "最近 7 天", hours: 24 * 7 },
    { label: "最近 30 天", hours: 24 * 30 },
  ];
  const rangeLabel = $derived(RANGES.find((r) => r.hours === rangeHours)?.label || "最近 24 小时");
  const rangeDays = $derived(Math.max(1, Math.round(rangeHours / 24)));

  const TYPE_LABEL: Record<string, string> = {
    vertex_ai: "Vertex AI",
    google_ai_studio: "AI Studio",
    openai: "OpenAI",
    anthropic: "Anthropic",
  };
  const TYPE_TAG: Record<string, string> = {
    vertex_ai: "tag-vertex",
    google_ai_studio: "tag-studio",
    openai: "tag-openai",
    anthropic: "tag-anthropic",
  };

  function toDateStr(d: Date) {
    return d.toISOString().slice(0, 10);
  }

  async function loadAll() {
    loading = true;
    error = "";
    const from = toDateStr(new Date(Date.now() - rangeDays * 86400000));
    const to = toDateStr(new Date());
    try {
      const [p, u, rs, logs] = await Promise.all([
        getProviders().catch(() => [] as Provider[]),
        getUsage(from, to).catch(() => null as UsageData | null),
        getRouteStats(rangeHours).catch(() => null as RouteStatsResponse | null),
        getCallLogs(new URLSearchParams({ limit: "6" })).catch(() => ({ logs: [] as LogEntry[], total: 0, hasMore: false })),
      ]);
      providers = p;
      usage = u;
      routeStats = rs;
      recent = logs.logs || [];
    } catch (err: any) {
      error = err?.message || "加载失败";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    loadAll();
  });

  // ---- Derived metrics ----
  const totalCalls = $derived(usage?.total?.calls || 0);
  const totalTokens = $derived((usage?.total?.promptTokens || 0) + (usage?.total?.completionTokens || 0));
  const enabledCount = $derived(providers.filter((p) => p.enabled).length);
  const latencyMs = $derived(routeStats?.overview?.averageLatencyMs ?? null);

  // ---- Daily series for the chart ----
  interface DayPoint { date: string; calls: number; tokens: number; }
  function buildDaily(u: UsageData | null): DayPoint[] {
    const d = u?.daily || {};
    return Object.entries(d)
      .map(([date, v]) => ({ date, calls: v.calls || 0, tokens: (v.promptTokens || 0) + (v.completionTokens || 0) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  const daily = $derived(buildDaily(usage));
  const hasChart = $derived(daily.length > 1);

  // ---- Chart geometry (viewBox 600x210) ----
  const W = 600, H = 210, PAD = 10, BASE = H - 34;
  const maxC = $derived(Math.max(1, ...daily.map((d) => d.calls)));
  const maxT = $derived(Math.max(1, ...daily.map((d) => d.tokens)));
  function cx(i: number) { return PAD + (i / Math.max(1, daily.length - 1)) * (W - PAD * 2); }
  function cyC(v: number) { return BASE - (v / maxC) * (H - 52); }
  function cyT(v: number) { return BASE - (v / maxT) * (H - 52); }
  const lineC = $derived(daily.map((d, i) => `${cx(i)},${cyC(d.calls)}`).join(" "));
  const lineT = $derived(daily.map((d, i) => `${cx(i)},${cyT(d.tokens)}`).join(" "));
  const pathC = $derived(daily.map((d, i) => (i ? "L " : "M ") + cx(i) + " " + cyC(d.calls)).join(" "));
  const pathT = $derived(daily.map((d, i) => (i ? "L " : "M ") + cx(i) + " " + cyT(d.tokens)).join(" "));
  const areaC = $derived(`${pathC} L ${W - PAD} ${BASE} L ${PAD} ${BASE} Z`);
  const areaT = $derived(`${pathT} L ${W - PAD} ${BASE} L ${PAD} ${BASE} Z`);

  let chartBox = $state<HTMLDivElement>();
  let chartSvg = $state<SVGSVGElement>();
  let tipOn = $state(false);
  let tipLeft = $state(0);
  let tipTop = $state(0);
  let tipIdx = $state(0);

  function onChartMove(e: MouseEvent) {
    if (!chartSvg || daily.length < 2) return;
    const rect = chartSvg.getBoundingClientRect();
    const parentRect = chartBox?.getBoundingClientRect() || rect;
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let idx = 0, best = Infinity;
    daily.forEach((_, i) => { const dx = Math.abs(cx(i) - mx); if (dx < best) { best = dx; idx = i; } });
    tipIdx = idx;
    let px = (cx(idx) / W) * rect.width + (rect.left - parentRect.left);
    const py = (cyC(daily[idx].calls) / H) * rect.height + (rect.top - parentRect.top);
    const half = 64;
    if (px < half) px = half;
    if (px > parentRect.width - half) px = parentRect.width - half;
    tipLeft = px;
    tipTop = py;
    tipOn = true;
  }
  function onChartLeave() { tipOn = false; }

  // ---- Refresh ----
  let refreshing = $state(false);
  function refresh() {
    refreshing = true;
    loadAll().finally(() => { refreshing = false; });
  }
</script>

<svelte:head><title>概览 — Vega API</title></svelte:head>

<div class="page-head">
  <div>
    <h1>概览</h1>
    <p class="lead">网关实时运行状态与用量总览</p>
  </div>
  <div class="actions">
    <select class="select" style="width:auto;font-size:12.5px" value={rangeHours} onchange={(e) => { rangeHours = Number((e.target as HTMLSelectElement).value); loadAll(); }}>
      {#each RANGES as r}
        <option value={r.hours}>{r.label}</option>
      {/each}
    </select>
    <button class="btn btn-ghost" onclick={refresh} disabled={refreshing}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      刷新
    </button>
  </div>
</div>

{#if loading}
  <div class="empty" style="min-height:40vh;display:grid;place-items:center">
    <div class="flex items-center justify-center min-h-[40vh]">
      <div class="flex flex-col items-center gap-4">
        <svg class="animate-spin h-6 w-6 text-cta" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" />
          <path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span class="mono" style="font-size:13px;color:var(--muted)">加载中...</span>
      </div>
    </div>
  </div>
{:else}
  {#if error}
    <div class="empty" style="padding:20px 0">{error}</div>
  {/if}

  <!-- KPIs -->
  <div class="kpis mb-lg">
    <div class="kpi rise" style="--d:30ms">
      <div class="kpi-top">
        <span class="kpi-label">总调用次数</span>
        <span class="kpi-ico ico-cta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
        </span>
      </div>
      <div class="kpi-val">{formatNumber(totalCalls)}</div>
      <div class="kpi-sub"><span class="up">▲ {rangeLabel}</span></div>
    </div>
    <div class="kpi rise" style="--d:80ms">
      <div class="kpi-top">
        <span class="kpi-label">活跃提供商</span>
        <span class="kpi-ico ico-accent">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" /></svg>
        </span>
      </div>
      <div class="kpi-val">{enabledCount}</div>
      <div class="kpi-sub"><span class="up">{enabledCount} / {providers.length}</span>&nbsp;运行中</div>
    </div>
    <div class="kpi rise" style="--d:130ms">
      <div class="kpi-top">
        <span class="kpi-label">总 Token 数</span>
        <span class="kpi-ico ico-warn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 6l-9.5 9.5-5-5L1 18" /><path d="M17 6h6v6" /></svg>
        </span>
      </div>
      <div class="kpi-val">{formatNumber(totalTokens)}</div>
      <div class="kpi-sub"><span class="up">▲ {rangeLabel}</span></div>
    </div>
    <div class="kpi rise" style="--d:180ms">
      <div class="kpi-top">
        <span class="kpi-label">平均时延</span>
        <span class="kpi-ico ico-cta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </span>
      </div>
      <div class="kpi-val">{formatLatency(latencyMs)}</div>
      <div class="kpi-sub"><span style="color:var(--success)">● 真实 duration_ms</span></div>
    </div>
  </div>

  <div class="grid grid-2 mb-lg">
    <!-- Requests trend -->
    <div class="card rise" style="--d:230ms">
      <div class="card-head">
        <div>
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-6" /></svg>
            请求量趋势
          </h2>
          <div class="sub">全部 Provider · {rangeLabel}</div>
        </div>
        <span class="chip chip-cta">{rangeDays}d</span>
      </div>
      <div style="padding:18px 20px 14px;position:relative">
        {#if !hasChart}
          <div class="empty" style="padding:40px 0">暂无用法数据</div>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
          <div bind:this={chartBox} style="position:relative" onmousemove={onChartMove} onmouseleave={onChartLeave}>
            <svg
              bind:this={chartSvg}
              viewBox="0 0 600 210"
              preserveAspectRatio="none"
              style="width:100%;height:190px;cursor:crosshair"
            >
              <defs>
                <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="var(--cta)" stop-opacity=".30" />
                  <stop offset="1" stop-color="var(--cta)" stop-opacity="0" />
                </linearGradient>
                <linearGradient id="gT" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="var(--success)" stop-opacity=".26" />
                  <stop offset="1" stop-color="var(--success)" stop-opacity="0" />
                </linearGradient>
              </defs>
              {#each [0.25, 0.5, 0.75] as t}
                <line class="grid-line" x1={PAD} y1={BASE - (H - 52) * t - 14} x2={W - PAD} y2={BASE - (H - 52) * t - 14} stroke-width="1" />
              {/each}
              <path d={areaC} fill="url(#gC)" />
              <path d={areaT} fill="url(#gT)" />
              <polyline points={lineC} fill="none" stroke="var(--cta)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
              <polyline points={lineT} fill="none" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              {#each daily as d, i (d.date)}
                <circle class="chart-dot" cx={cx(i)} cy={cyC(d.calls)} r="2.6" fill="var(--cta)" />
                <text x={cx(i)} y={H - 16} text-anchor="middle" font-size="10" fill="var(--muted)" font-family="var(--font-mono)">{d.date.slice(5)}</text>
              {/each}
            </svg>
            {#if tipOn}
              <div class="chart-tip on" style:left={tipLeft + "px"} style:top={tipTop + "px"}>
                <div class="t">{daily[tipIdx].date}</div>
                <div class="r"><span class="lb">调用</span><span class="v-c">{formatNumber(daily[tipIdx].calls)}</span></div>
                <div class="r"><span class="lb">Token</span><span class="v-t">{formatNumber(daily[tipIdx].tokens)}</span></div>
              </div>
            {/if}
          </div>
          <div class="legend">
            <span><span class="sw" style="background:var(--cta)"></span>调用次数</span>
            <span><span class="sw" style="background:var(--success)"></span>Token</span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Provider status -->
    <div class="card rise" style="--d:280ms">
      <div class="card-head">
        <div>
          <h2>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="6" height="6" rx="1" /><rect x="16" y="15" width="6" height="6" rx="1" /><circle cx="7" cy="18" r="2.5" /><circle cx="17" cy="6" r="2.5" /><path d="M7 18h9M17 6 7 10" /></svg>
            提供商状态
          </h2>
          <div class="sub">当前启用的路由上游</div>
        </div>
        <a class="btn btn-ghost btn-sm" href="/dashboard/api-settings">管理</a>
      </div>
      <div id="providerStatus" style="padding:6px">
        {#each providers as p (p.id)}
          <div class="between" style="padding:9px 10px;border-radius:10px">
            <div class="row">
              <span style="width:8px;height:8px;border-radius:50%;background:{p.enabled ? 'var(--success)' : 'var(--muted)'};box-shadow:{p.enabled ? '0 0 8px var(--accent-glow)' : 'none'}"></span>
              <span style="font-size:13px;color:var(--fg-2)">{p.name}</span>
              <span class="tag {TYPE_TAG[p.type]}">{TYPE_LABEL[p.type]}</span>
            </div>
            <span style="font-size:12px;{p.enabled ? 'color:var(--success)' : 'color:var(--muted)'}">{p.enabled ? "运行中" : "已禁用"}</span>
          </div>
        {/each}
        {#if providers.length === 0}
          <p style="font-size:13px;color:var(--muted);text-align:center;padding:20px">暂无提供商，请到 API 设置页面添加</p>
        {/if}
      </div>
    </div>
  </div>

  <!-- Recent calls -->
  <div class="card rise" style="--d:330ms">
    <div class="card-head">
      <div>
        <h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>
          最近调用
        </h2>
        <div class="sub">最新 {recent.length} 条调用记录</div>
      </div>
      <a class="btn btn-ghost btn-sm" href="/dashboard/logs">查看全部</a>
    </div>
    {#if recent.length === 0}
      <div class="empty" style="padding:36px 16px">暂无调用记录</div>
    {:else}
      <div class="table-wrap rc-table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时间</th>
              <th>提供商</th>
              <th>模型</th>
              <th class="right">Tokens</th>
              <th class="right">耗时</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {#each recent as l (l.id)}
              <tr>
                <td class="mono" style="color:var(--muted)">{formatTime(l.timestamp)}</td>
                <td>{l.providerId}</td>
                <td class="mono">{l.model}</td>
                <td class="num right" style="color:var(--fg-2)">{l.promptTokens.toLocaleString()} / {l.completionTokens.toLocaleString()}</td>
                <td class="num right">{formatDuration(l.durationMs)}</td>
                <td>
                  <span class="chip {l.success ? 'chip-accent' : 'chip-danger'}"><span class="c-dot" style="background:currentColor"></span>{l.success ? "成功" : "失败"}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="rc-list">
        {#each recent as l (l.id)}
          <div class="rc">
            <div class="rc-top">
              <span class="mono">{formatTime(l.timestamp)}</span>
              <span class="chip {l.success ? 'chip-accent' : 'chip-danger'}"><span class="c-dot" style="background:currentColor"></span>{l.success ? "成功" : "失败"}</span>
            </div>
            <div class="rc-main">
              <span class="mono">{l.model}</span>
              <span class="rc-prov">{l.providerId}</span>
              <span class="rc-tok">{l.promptTokens.toLocaleString()}/{l.completionTokens.toLocaleString()} · {formatDuration(l.durationMs)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
