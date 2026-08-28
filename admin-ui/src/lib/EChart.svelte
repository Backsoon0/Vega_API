<script lang="ts">
	// EChart.svelte — thin Apache ECharts (v6) wrapper for Svelte 5 runes.
	// Usage: <EChart option={...} height={240} />
	// Renders with the SVG renderer (crisp lines, CSS-friendly), auto-resizes via
	// ResizeObserver and disposes on destroy. Only the chart types used by this
	// admin panel are registered — keeps the bundle smaller than full echarts.
	import * as echarts from 'echarts/core';
	import { LineChart, BarChart } from 'echarts/charts';
	import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
	import { SVGRenderer } from 'echarts/renderers';
	import type { EChartsCoreOption } from 'echarts/core';

	echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);

	let {
		option,
		height = 240,
	}: {
		option: Record<string, unknown> | EChartsCoreOption;
		height?: number | string;
	} = $props();

	let el = $state<HTMLDivElement | undefined>();
	let chart = $state<ReturnType<typeof echarts.init> | undefined>();
	let ro: ResizeObserver | undefined;

	// Init once the container is mounted (client only).
	$effect(() => {
		const root = el;
		if (!root || chart) return;
		chart = echarts.init(root, undefined, { renderer: 'svg' });
		ro = new ResizeObserver(() => chart?.resize());
		ro.observe(root);
	});

	// Push option changes into the chart (notMerge so series/axes fully replace).
	$effect(() => {
		if (chart && option) chart.setOption(option as EChartsCoreOption, { notMerge: true });
	});

	// Cleanup on destroy.
	$effect(() => {
		return () => {
			ro?.disconnect();
			ro = undefined;
			chart?.dispose();
			chart = undefined;
		};
	});
</script>

<div
	bind:this={el}
	style="width:100%;height:{typeof height === 'number' ? height + 'px' : height}"
></div>