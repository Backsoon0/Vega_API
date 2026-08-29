<script lang="ts">
  import { getProviders, getCallLogs, getUsageReport, type Provider, type LogEntry, type UsageReport } from "$lib/api";
  import { getRouteStats, formatLatency, type RouteStatsResponse } from "$lib/route-stats";
  import { formatNumber, formatDuration, formatTime } from "$lib/utils";
  import CustomSelect from "$lib/CustomSelect.svelte";
  import EChart from "$lib/EChart.svelte";
  import { chartPalette, chartAxes, SERIES_COLORS, type ChartPalette } from "$lib/chart-theme";

  let providers = $state<Provider[]>([]);
  let report = $state<UsageReport | null>(null);
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
  const rangeOptions = RANGES.map((r) => ({ value: r.hours, label: r.label }));

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

  async function loadAll() {
    loading = true;
    error = "";
    try {
      const [p, r, rs, logs] = await Promise.all([
        getProviders().catch(() => [] as Provider[]),
        getUsageReport(rangeDays).catch(() => null as UsageReport | null),
        getRouteStats(rangeHours).catch(() => null as RouteStatsResponse | null),
        getCallLogs(new URLSearchParams({ limit: "6" })).catch(() => ({ logs: [] as LogEntry[], total: 0, hasMore: false })),
      ]);
      providers = p;
      report = r;
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
  const totalCalls = $derived(report?.series.reduce((s, d) => s + d.calls, 0) || 0);
  const totalTokens = $derived(report?.series.reduce((s, d) => s + d.tokens, 0) || 0);
  const enabledCount = $derived(providers.filter((p) => p.enabled).length);
  const latencyMs = $derived(routeStats?.overview?.averageLatencyMs ?? null);

  // ---- ECharts options (Code Dark themed) ----
  const pal = $derived(chartPalette());
  const axes = $derived(chartAxes(pal));
  const series = $derived(report?.series || []);
  const hasChart = $derived(series.length > 0);

  const trendOption = $derived({
    ...axes,
    color: [pal.cta, pal.success],
    tooltip: { ...axes.tooltip, trigger: "axis" },
    legend: { ...axes.legend, data: ["调用次数", "Token"] },
    grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
    xAxis: {
      ...axes.xAxis,
      type: "category",
      data: series.map((d) => d.date.slice(5)),
    },
    yAxis: [{ ...axes.yAxis, type: "value", minInterval: 1 }, { ...axes.yAxis, type: "value", splitLine: { show: false } }],
    series: [
      {
        name: "调用次数",
        type: "line",
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 },
        data: series.map((d) => d.calls),
      },
      {
        name: "Token",
        type: "line",
        yAxisIndex: 1,
        smooth: 0.25,
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.1 },
        data: series.map((d) => d.tokens),
      },
    ],
  });

  // 按模型分布 — horizontal bar, top 12
  const byModel = $derived(report?.byModel || []);
  const modelOption = $derived({
    ...axes,
    color: [pal.cta],
    tooltip: { ...axes.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
    xAxis: { ...axes.xAxis, type: "value", minInterval: 1 },
    yAxis: { ...axes.yAxis, type: "category", inverse: true, data: byModel.map((m) => m.model) },
    series: [
      {
        name: "调用次数",
        type: "bar",
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        data: byModel.map((m) => m.calls),
      },
    ],
  });

  // 按密钥用量 — horizontal bar, 调用数（配额密钥可显示超限状态）
  const byKey = $derived(report?.byKey || []);
  const keyOption = $derived({
    ...axes,
    color: [pal.accent],
    tooltip: { ...axes.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
    xAxis: { ...axes.xAxis, type: "value", minInterval: 1 },
    yAxis: { ...axes.yAxis, type: "category", inverse: true, data: byKey.map((k) => k.keyName) },
    series: [
      {
        name: "调用次数",
        type: "bar",
        barMaxWidth: 14,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        data: byKey.map((k) => k.calls),
      },
    ],
  });

  // ---- CSV 导出 ----
  function exportCsv() {
    if (!report) return;
    const lines: string[] = [];
    lines.push("日期,调用次数,Token");
    for (const d of report.series) lines.push(`${d.date},${d.calls},${d.tokens}`);
    lines.push("");
    lines.push("模型,调用次数,Token");
    for (const m of report.byModel) lines.push(`${m.model},${m.calls},${m.tokens}`);
    lines.push("");
    lines.push("密钥名称,调用次数,Token");
    for (const k of report.byKey) lines.push(`${k.keyName},${k.calls},${k.tokens}`);
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `vega-usage-report-${rangeDays}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- Refresh ----
  let refreshing = $state(false);
  function refresh() {
    refreshing = true;
    loadAll().finally(() => { refreshing = false; });
  }

  // Chart height handles (consumed by markup)
  function chartHeight(days: number): number {
    return days <= 7 ? 190 : days <= 30 ? 200 : 210;
  }
</script>

<svelte:head><title>概览 — Vega API</title></svelte:head>

<div class="page-head">
  <div>
    <h1>概览</h1>
    <p class="lead">网关实时运行状态与用量报表</p>
  </div>
  <div class="actions">
    <CustomSelect options={rangeOptions} bind:value={rangeHours} onchange={() => loadAll()} />
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
    <!-- Requests trend (ECharts) -->
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
      <div style="padding:18px 20px 14px">
        {#if !report}
          <div class="empty" style="padding:40px 0">
            <p style="margin:0 0 4px">用量报表接口无响应</p>
            <p style="font-size:12px;color:var(--muted);margin:0">请确认已部署包含 /admin/usage/report 的最新版本</p>
          </div>
        {:else if !hasChart}
          <div class="empty" style="padding:40px 0">暂无用法数据</div>
        {:else}
          <EChart option={trendOption} height={chartHeight(rangeDays)} />
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

  <!-- 用量报表 (ECharts) -->
  <div class="card rise mb-lg" style="--d:300ms">
    <div class="card-head">
      <div>
        <h2>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-6" /></svg>
          用量报表
        </h2>
        <div class="sub">按模型 / 密钥分组 · {rangeLabel}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick={exportCsv} disabled={!report || totalCalls === 0}>导出 CSV</button>
    </div>
    <div class="grid grid-2" style="gap:8px">
      <div style="padding:10px 16px 16px">
        <div style="font-size:12px;color:var(--muted);margin:4px 0 10px">按模型分布（调用次数 Top 12）</div>
        {#if byModel.length === 0}
          <div class="empty" style="padding:30px 0">暂无数据</div>
        {:else}
          <EChart option={modelOption} height={Math.min(320, Math.max(160, byModel.length * 26 + 40))} />
        {/if}
      </div>
      <div style="padding:10px 16px 16px">
        <div style="font-size:12px;color:var(--muted);margin:4px 0 10px">按密钥用量（调用次数）</div>
        {#if byKey.length === 0}
          <div class="empty" style="padding:30px 0">暂无命名密钥用量</div>
        {:else}
          <EChart option={keyOption} height={Math.min(320, Math.max(160, byKey.length * 26 + 40))} />
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