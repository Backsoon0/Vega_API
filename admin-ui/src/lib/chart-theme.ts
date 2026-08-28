// admin-ui/src/lib/chart-theme.ts
// Code Dark chart palette + shared axis/tooltip defaults for Apache ECharts.
// Reads the design tokens at runtime (getComputedStyle) because ECharts needs
// concrete color strings — CSS var() is not valid inside canvas/SVG paints.

export function cssVar(name: string, fallback = ''): string {
	if (typeof window === 'undefined') return fallback;
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export interface ChartPalette {
	cta: string;
	accent: string;
	success: string;
	warning: string;
	danger: string;
	muted: string;
	fg: string;
	fg2: string;
	grid: string;
	fontSans: string;
	fontMono: string;
}

let cached: ChartPalette | null = null;

/** Resolve once per page load (tokens are static — theme never switches at runtime). */
export function chartPalette(): ChartPalette {
	if (cached) return cached;
	cached = {
		cta: cssVar('--cta', '#3B82F6'),
		accent: cssVar('--accent', '#22C55E'),
		success: cssVar('--success', '#22C55E'),
		warning: cssVar('--warning', '#F59E0B'),
		danger: cssVar('--danger', '#EF4444'),
		muted: cssVar('--muted', '#64748B'),
		fg: cssVar('--fg', '#F1F5F9'),
		fg2: cssVar('--fg-2', cssVar('--color-secondary', '#CBD5E1')),
		grid: 'rgba(255,255,255,0.06)',
		fontSans: cssVar('--font-sans', "'IBM Plex Sans', ui-sans-serif, sans-serif"),
		fontMono: cssVar('--font-mono', "'JetBrains Mono', ui-monospace, monospace"),
	};
	return cached;
}

/**
 * Shared axis / tooltip / legend defaults so every chart matches Code Dark.
 * Spread the result into an ECharts option, then override per chart.
 */
export function chartAxes(p: ChartPalette) {
	const axis = {
		axisLine: { lineStyle: { color: p.grid } },
		axisTick: { show: false },
		axisLabel: { color: p.muted, fontFamily: p.fontMono, fontSize: 10 },
		splitLine: { lineStyle: { color: p.grid } },
	};
	return {
		xAxis: { ...axis, boundaryGap: true },
		yAxis: { ...axis },
		tooltip: {
			backgroundColor: 'rgba(9, 11, 16, 0.92)',
			borderColor: 'rgba(255,255,255,0.08)',
			textStyle: { color: p.fg, fontFamily: p.fontSans, fontSize: 12 },
			confine: true,
		},
		legend: {
			textStyle: { color: p.fg2, fontFamily: p.fontSans, fontSize: 11 },
			icon: 'roundRect',
			itemWidth: 10,
			itemHeight: 10,
			top: 0,
		},
		grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
	};
}

/** Classic series palette (calls/requests/latency lines), CTA-first. */
export const SERIES_COLORS = [
	'#3B82F6', '#22C55E', '#F59E0B', '#EF4444', '#a78bfa', '#38bdf8', '#34d399', '#f472b6',
];