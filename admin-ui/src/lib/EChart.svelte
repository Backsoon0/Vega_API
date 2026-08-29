<script lang="ts">
	// EChart.svelte — thin Apache ECharts (v6) wrapper for Svelte 5 runes.
	// Usage: <EChart option={...} height={240} />
	//
	// ECharts is loaded LAZILY via dynamic import() so its ~550 kB minified
	// payload (split into "echarts" + "zrender" chunks by manualChunks in
	// vite.config.ts) is only fetched when a page actually renders a chart —
	// the app/routes bundles stay small. Only the chart types used by this
	// admin panel are registered (Line + Bar, Grid/Tooltip/Legend, SVG renderer).
	import type { EChartsCoreOption } from 'echarts/core';

	type EchartsNamespace = typeof import('echarts/core');

	let {
		option,
		height = 240,
	}: {
		option: Record<string, unknown> | EChartsCoreOption;
		height?: number | string;
	} = $props();

	let el = $state<HTMLDivElement | undefined>();
	let chart = $state<ReturnType<EchartsNamespace['init']> | undefined>();
	let ro: ResizeObserver | undefined;

	// Module-level memoized loader: all EChart instances share one echarts load.
	let echartsPromise: Promise<EchartsNamespace> | undefined;
	function loadEcharts(): Promise<EchartsNamespace> {
		echartsPromise ??= (async () => {
			const mod = await import('echarts/core');
			const { LineChart, BarChart } = await import('echarts/charts');
			const { GridComponent, TooltipComponent, LegendComponent } = await import('echarts/components');
			const { SVGRenderer } = await import('echarts/renderers');
			mod.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);
			return mod;
		})();
		return echartsPromise;
	}

	// Init once the container is mounted (client only) and echarts is loaded.
	$effect(() => {
		const root = el;
		if (!root) return;
		let cancelled = false;

		void loadEcharts().then((mod) => {
			if (cancelled) return;
			chart = mod.init(root, undefined, { renderer: 'svg' });
			ro = new ResizeObserver(() => chart?.resize());
			ro.observe(root);
		});

		return () => {
			cancelled = true;
			ro?.disconnect();
			ro = undefined;
			chart?.dispose();
			chart = undefined;
		};
	});

	// Push option changes into the chart (notMerge so series/axes fully replace).
	// Re-runs when `chart` (after lazy load) or `option` changes.
	$effect(() => {
		if (chart && option) chart.setOption(option as EChartsCoreOption, { notMerge: true });
	});
</script>

<div
	bind:this={el}
	style="width:100%;height:{typeof height === 'number' ? height + 'px' : height}"
></div>